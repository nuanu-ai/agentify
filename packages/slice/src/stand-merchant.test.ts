/**
 * What cannot be seen on the stand's page: a merchant subscription that
 * outlived its replacement goes on taking orders from a gateway nobody is
 * watching, and the screen afterwards shows a run that makes no sense for a
 * reason that is not on it.
 */

import { type FileHandle, mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@agentify/gateway/config";
import { CONTRACT_VERSION, type Order, type WorkerEnvelope } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sliceEnv } from "./gateway-harness.js";
import { type Entry, makeFeed } from "./stand-log.js";
import { makeStandMerchant } from "./stand-merchant.js";
import { renderEntry } from "./stand-page.js";
import { keepRecordsIn } from "./stand-records.js";

const KEY = "the-key-the-stand-connects-with";

const waitUntil = async (that: () => boolean, within = 5_000): Promise<void> => {
  const until = Date.now() + within;
  while (!that()) {
    if (Date.now() > until) {
      throw new Error(`still not true after ${within}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/**
 * A gateway that answers a poll and counts it, and nothing else.
 *
 * The SDK's own fake gateway is not reachable from here, since the package
 * publishes one entry point, and widening a published package for a test helper
 * is not worth it. The answer has to name the contract version: a worker polled
 * without one decides it cannot speak to the gateway and ends its loop, which
 * would make the second gateway look silent for an unrelated reason.
 */
const pollCounter = async (): Promise<{
  url: string;
  polls: () => number;
  close: () => Promise<void>;
}> => {
  let polls = 0;
  const server: Server = createServer((request, response) => {
    if (request.url?.endsWith("/worker/poll") === true) {
      polls += 1;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ contract_version: CONTRACT_VERSION, envelopes: [] }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    polls: () => polls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};

const orderAfterMove = (): WorkerEnvelope => ({
  kind: "order",
  id: "envelope-after-move",
  sent_at: "2026-08-31T00:00:00Z",
  payload: {
    id: "order-after-move",
    merchant_item_id: "the-item-both-gateways-name",
    params: {},
    price: {
      amount: "1.00",
      currency: "USD",
      at: "2026-08-31T00:00:00Z",
      as_of: "2026-08-31T00:00:00Z",
    },
    test: false,
  },
});

const orderGateway = async (): Promise<{
  url: string;
  delivered: () => unknown;
  close: () => Promise<void>;
}> => {
  let sent = false;
  let answer: unknown;
  const server: Server = createServer(async (request, response) => {
    if (request.url?.endsWith("/worker/poll") === true) {
      const envelopes = sent ? [] : [orderAfterMove()];
      sent = true;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ contract_version: CONTRACT_VERSION, envelopes }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    answer = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, result: "delivered" }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    delivered: () => answer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};

/** What the gateway says when the goods are not the ones the card declares. */
const DELIVERY_REFUSED = {
  ok: false,
  error: {
    code: "delivery_does_not_match_card",
    message: "this delivery is not what the card for this order declares",
    retryable: true,
    problems: [
      {
        path: ["access_url"],
        code: "unrecognized_keys",
        message: "this card declares no such field",
      },
    ],
  },
};

/** A gateway that hands over one order and then will not take the delivery. */
const refusingDeliveryGateway = async (): Promise<{
  url: string;
  close: () => Promise<void>;
}> => {
  let sent = false;
  const server: Server = createServer(async (request, response) => {
    if (request.url?.endsWith("/worker/poll") === true) {
      const envelopes = sent ? [] : [orderAfterMove()];
      sent = true;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ contract_version: CONTRACT_VERSION, envelopes }));
      return;
    }
    for await (const _chunk of request) {
      // Drained before answering, so keep-alive cannot carry a body forward.
    }
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/deliver") === true) {
      // The refusal arrives under a clean status on purpose. An answer that
      // said no with a 4xx would be caught by the status arm of the reading
      // this is about, and the arm that matters here would never be reached.
      response.end(JSON.stringify(DELIVERY_REFUSED));
      return;
    }
    response.end(JSON.stringify({ ok: true, result: "accepted" }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};

const blockingDeliveryGateway = async (): Promise<{
  url: string;
  deliveryBegan: () => boolean;
  releaseDelivery: () => void;
  close: () => Promise<void>;
}> => {
  let sent = false;
  let began = false;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server: Server = createServer(async (request, response) => {
    if (request.url?.endsWith("/worker/poll") === true) {
      const envelopes = sent ? [] : [orderAfterMove()];
      sent = true;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ contract_version: CONTRACT_VERSION, envelopes }));
      return;
    }
    for await (const _chunk of request) {
      // Consume the body before responding so this test gateway mirrors HTTP
      // connection reuse rather than leaving bytes behind for the next request.
    }
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/deliver") === true) {
      began = true;
      await released;
      response.end(JSON.stringify({ ok: true, result: "delivered" }));
      return;
    }
    response.end(JSON.stringify({ ok: true, result: "accepted" }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    deliveryBegan: () => began,
    releaseDelivery: () => release?.(),
    close: async () => {
      release?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
};

/*
 * These read the detail rather than the title, and that is deliberate. What
 * this test is about is order — a delivery already in flight finishing before
 * the replacement connection does — and the sentences the console writes are
 * rewritten whenever somebody reading a screen cannot follow them. A test that
 * held those sentences would fail on a wording change and pass on a broken
 * ordering, which is the wrong way round.
 */
const detailOf = (entry: Entry): Record<string, unknown> =>
  typeof entry.detail === "object" && entry.detail !== null
    ? (entry.detail as Record<string, unknown>)
    : {};

/** The console saying it is holding the disconnect for work already begun. */
const isWaitingForDeliveries = (entry: Entry): boolean =>
  typeof detailOf(entry).deliveries === "number";

/** The gateway's answer to a delivery made on an order accepted earlier. */
const isDeliveryAnswered = (entry: Entry): boolean =>
  entry.kind === "merchant" && detailOf(entry).result !== undefined;

let merchant: ReturnType<typeof makeStandMerchant> | undefined;
const shutting: Array<() => Promise<void>> = [];

afterEach(async () => {
  await merchant?.disconnect();
  merchant = undefined;
  for (const close of shutting.splice(0)) {
    await close();
  }
});

describe("a closing call the gateway would not take", () => {
  it("writes it as a line the log reads as failed, with the reason on it", async () => {
    // A refusal that arrives under a clean status must still be visible in the
    // log: HTTP 200 and an answer where one was expected, so only the reading
    // in `stand-page` marks it, fed by what this side puts in the detail.
    // Written whole under `result` the refusal is swallowed: the envelope's
    // `ok` sits one level down where nothing looks for it, and the line renders
    // like every other.
    const gateway = await refusingDeliveryGateway();
    shutting.push(gateway.close);
    const feed = makeFeed();

    merchant = makeStandMerchant(feed);
    merchant.moods.order = "accept_then_deliver";
    merchant.moods.deliverAfterMs = 0;
    await merchant.connect(gateway.url, KEY);
    await waitUntil(() => feed.entries().some(isDeliveryAnswered));

    const answered = feed.entries().find(isDeliveryAnswered);
    if (answered === undefined) throw new Error("the delivery was never answered");

    // Marked, by the reader the page actually uses rather than by a copy of its
    // rule written here.
    expect(renderEntry(answered)).toContain("bad");

    // And carrying what to do about it: the word a merchant's own program
    // branches on, and the finding their handler has to act on.
    const said = detailOf(answered).error;
    expect(said).toContain("delivery_does_not_match_card");
    expect(said).toContain("access_url");
    expect(said).toContain("this card declares no such field");
  });
});

describe("connecting the stand somewhere else", () => {
  it("stops the subscription it had, so no gateway keeps a mouth on this merchant", async () => {
    const first = await pollCounter();
    const second = await pollCounter();
    shutting.push(first.close, second.close);

    merchant = makeStandMerchant(makeFeed());
    await merchant.connect(first.url, KEY);
    await waitUntil(() => first.polls() > 0);

    await merchant.connect(second.url, KEY);
    await waitUntil(() => second.polls() > 0);

    // What the first gateway had seen when the move finished. Anything after
    // this is a subscription that outlived its replacement.
    const afterTheMove = first.polls();
    await waitUntil(() => second.polls() > 1, 10_000);

    expect(first.polls()).toBe(afterTheMove);
    expect(merchant.connected()).toBe(second.url);
  });

  it("forgets goods learned from the gateway it left", async () => {
    const first = await pollCounter();
    const second = await orderGateway();
    shutting.push(first.close, second.close);

    merchant = makeStandMerchant(makeFeed());
    await merchant.connect(first.url, KEY);
    await waitUntil(() => first.polls() > 0);
    merchant.learn("the-item-both-gateways-name", { old_gateway_field: { type: "string" } });

    await merchant.connect(second.url, KEY);
    await waitUntil(() => second.delivered() !== undefined);

    expect(second.delivered()).toEqual({ delivered: {} });
  });

  it("waits for a delivery already in flight before replacing the gateway", async () => {
    const oldGateway = await blockingDeliveryGateway();
    const nextGateway = await pollCounter();
    shutting.push(oldGateway.close, nextGateway.close);
    const feed = makeFeed();

    merchant = makeStandMerchant(feed);
    merchant.moods.order = "accept_then_deliver";
    merchant.moods.deliverAfterMs = 0;
    await merchant.connect(oldGateway.url, KEY);
    await waitUntil(oldGateway.deliveryBegan);

    try {
      let replacementFinished = false;
      const replacing = merchant.connect(nextGateway.url, KEY).then(() => {
        replacementFinished = true;
      });
      await waitUntil(() => feed.entries().some(isWaitingForDeliveries), 1_000);

      expect(replacementFinished).toBe(false);
      oldGateway.releaseDelivery();
      await replacing;
      await waitUntil(() => nextGateway.polls() > 0);

      const oldAnswer = feed.entries().findIndex(isDeliveryAnswered);
      const newConnection = feed
        .entries()
        .findIndex((entry) => detailOf(entry).base_url === nextGateway.url);
      expect(oldAnswer).toBeGreaterThanOrEqual(0);
      expect(oldAnswer).toBeLessThan(newConnection);
      expect(
        feed
          .entries()
          .slice(newConnection + 1)
          .some(isDeliveryAnswered),
      ).toBe(false);
    } finally {
      oldGateway.releaseDelivery();
    }
  });
});

describe("the handler told to answer only after the deadline", () => {
  /**
   * Whether `that` comes true while real time passes and the timers stay
   * faked: the exchanges with the gateway run over a socket, and they move on
   * real time, not on the faked timers.
   */
  const comesTrue = async (that: () => boolean, within: number): Promise<boolean> => {
    const until = Date.now() + within;
    while (!that() && Date.now() < until) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return that();
  };

  it("answers past the deadline the gateway ships for a synchronous answer", async () => {
    // Goods that reach the gateway in time are delivered and charged for,
    // which is the opposite of what a person choosing this answer came to see.
    // The deadline runs from the payment, before the order reaches the
    // handler, so a silence as long as the deadline is already past it.
    const { syncResponseMs } = loadConfig(sliceEnv()).deadlines;
    const gateway = await orderGateway();
    shutting.push(gateway.close);
    const feed = makeFeed();
    merchant = makeStandMerchant(feed);
    merchant.moods.order = "say_nothing";

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await merchant.connect(gateway.url, KEY);
      const handed = () =>
        feed.entries().some((entry) => detailOf(entry).order_id === "order-after-move");
      expect(await comesTrue(handed, 5_000)).toBe(true);

      // The handler writes its goods to the log the moment its silence ends,
      // before anything goes on the wire, so the log says whether it has.
      const madeGoods = () => feed.entries().some((entry) => "delivery" in detailOf(entry));
      await vi.advanceTimersByTimeAsync(syncResponseMs);
      await vi.advanceTimersByTimeAsync(0);
      expect(madeGoods(), "the handler answered inside the deadline").toBe(false);

      // The negative control: the handler does answer once the deadline is
      // behind it, so the silence above was not a handler that never answers.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(madeGoods()).toBe(true);
      expect(await comesTrue(() => gateway.delivered() !== undefined, 5_000)).toBe(true);
      expect(gateway.delivered()).toEqual({ delivered: {} });
    } finally {
      vi.useRealTimers();
    }
  });
});

/** What the merchant sent back about one order, as the gateway received it. */
interface Posted {
  readonly orderId: string;
  readonly body: unknown;
}

/**
 * A gateway that hands this merchant the orders a test gives it, and keeps
 * what comes back: the handler's answers and any delivery made later.
 *
 * A poll is held open until there is something to hand over, as the real
 * gateway holds it, so an order handed over mid-test arrives at once rather
 * than after the pause the worker takes between quiet polls.
 */
const handingGateway = async (): Promise<{
  url: string;
  /** Hands these orders over together, in the batch the next poll answers with. */
  hand: (...orders: Order[]) => void;
  answers: Posted[];
  /** Every delivery received, counted as it arrives and before it is answered. */
  deliveries: Posted[];
  /** Leaves every delivery unanswered from now until the returned call lets them through. */
  holdDeliveries: () => () => void;
  close: () => Promise<void>;
}> => {
  const parked = new Set<ServerResponse>();
  const queued: WorkerEnvelope[] = [];
  const answers: Posted[] = [];
  const deliveries: Posted[] = [];
  let envelopes = 0;
  let deliveriesHeld: Promise<void> = Promise.resolve();
  let letDeliveriesThrough = (): void => {};

  const handOut = (response: ServerResponse): void => {
    parked.delete(response);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ contract_version: CONTRACT_VERSION, envelopes: queued.splice(0) }),
    );
  };

  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (request.url?.endsWith("/worker/poll") === true) {
      if (queued.length > 0) {
        handOut(response);
        return;
      }
      parked.add(response);
      response.once("close", () => parked.delete(response));
      return;
    }
    const [, , , encodedId, call] = (request.url ?? "").split("/");
    const posted = {
      orderId: decodeURIComponent(encodedId ?? ""),
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    };
    if (call === "answer") answers.push(posted);
    if (call === "deliver") {
      deliveries.push(posted);
      await deliveriesHeld;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, result: "delivered" }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hand: (...orders) => {
      for (const order of orders) {
        envelopes += 1;
        queued.push({
          kind: "order",
          id: `envelope-${envelopes}`,
          sent_at: "2026-10-19T00:00:00Z",
          payload: order,
        });
      }
      const waiting = [...parked][0];
      if (waiting !== undefined) handOut(waiting);
    },
    answers,
    deliveries,
    holdDeliveries: () => {
      deliveriesHeld = new Promise((resolve) => {
        letDeliveriesThrough = resolve;
      });
      return () => letDeliveriesThrough();
    },
    close: async () => {
      letDeliveriesThrough();
      for (const waiting of [...parked]) handOut(waiting);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
};

/**
 * An order whose identifier would be a path, and a dangerous one, if it were
 * ever used as a file name. Identifiers may hold any printable character.
 */
const ORDER_ID = "order/../../escaped: with spaces & *stars*";

const anOrder = (id = ORDER_ID): Order => ({
  id,
  merchant_item_id: "the-item-ordered",
  params: {},
  price: {
    amount: "1.00",
    currency: "USD",
    at: "2026-10-19T00:00:00Z",
    as_of: "2026-10-19T00:00:00Z",
  },
  test: true,
});

const recordsDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "stand-records-"));
  shutting.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

/** The answers a records directory holds, one parsed file per answered order. */
const recordsIn = async (directory: string): Promise<Record<string, unknown>[]> => {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  return Promise.all(
    names.map(
      async (name) =>
        JSON.parse(await readFile(join(directory, name), "utf8")) as Record<string, unknown>,
    ),
  );
};

/** The arrivals a records directory has counted, one parsed line each. */
const arrivalsIn = async (directory: string): Promise<Record<string, unknown>[]> => {
  const text = await readFile(join(directory, "arrivals.jsonl"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

/**
 * What a records directory holds besides its arrivals and its records: a file
 * a tester counting effects would have to know to leave out.
 */
const strayFilesIn = async (directory: string): Promise<string[]> =>
  (await readdir(directory)).filter((name) => name !== "arrivals.jsonl" && !name.endsWith(".json"));

/** Long enough for an answer or a delivery that should not happen to arrive anyway. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

describe("a stand keeping records", () => {
  it("keeps one record of the answer that went back, and counts the arrival apart", async () => {
    // The promise: the records directory is the merchant's durable effect,
    // and a tester reads it to count effects against arrivals. A record that
    // differed from what the gateway received, or an arrival that went
    // uncounted, would make that count lie.
    const gateway = await handingGateway();
    shutting.push(gateway.close);
    const directory = await recordsDirectory();
    merchant = makeStandMerchant(makeFeed(), { records: keepRecordsIn(directory, 8701) });
    merchant.moods.delivery = { licence: "the-first-goods" };
    await merchant.connect(gateway.url, KEY);

    gateway.hand(anOrder());
    await waitUntil(() => gateway.answers.length === 1);

    expect(gateway.answers[0]?.orderId).toBe(ORDER_ID);
    expect(await recordsIn(directory)).toEqual([
      expect.objectContaining({
        order_id: ORDER_ID,
        merchant_item_id: "the-item-ordered",
        answer: gateway.answers[0]?.body,
        port: 8701,
        pid: process.pid,
      }),
    ]);
    expect(await arrivalsIn(directory)).toEqual([
      expect.objectContaining({ order_id: ORDER_ID, port: 8701, pid: process.pid }),
    ]);
    // Nothing but the two, so an identifier read as a path wrote nowhere else
    // and no half-written file was left beside the record.
    expect(await readdir(directory)).toHaveLength(2);
  });

  it("answers a repeat with the recorded answer, whatever it is set to now", async () => {
    // The promise: one order, one effect. A repeat is allowed to arrive, and
    // the record decides what goes back — not the mood, which here would hold
    // the order for a person and so never answer at all.
    const gateway = await handingGateway();
    shutting.push(gateway.close);
    const directory = await recordsDirectory();
    merchant = makeStandMerchant(makeFeed(), { records: keepRecordsIn(directory, 8701) });
    merchant.moods.delivery = { licence: "the-first-goods" };
    await merchant.connect(gateway.url, KEY);
    gateway.hand(anOrder());
    await waitUntil(() => gateway.answers.length === 1);

    merchant.moods.order = "ask_me";
    merchant.moods.delivery = { licence: "goods-it-would-give-now" };
    gateway.hand(anOrder());
    await waitUntil(() => gateway.answers.length === 2);

    expect(gateway.answers[1]?.body).toEqual(gateway.answers[0]?.body);
    expect(await arrivalsIn(directory)).toHaveLength(2);
    expect(await recordsIn(directory)).toHaveLength(1);
  });

  it("makes no second delivery for a repeat of an order it took on", async () => {
    // The promise: the delivery that follows an order taken on is part of the
    // one effect. A repeat answered from its record says "accepted" again and
    // promises nothing new.
    const gateway = await handingGateway();
    shutting.push(gateway.close);
    const directory = await recordsDirectory();
    merchant = makeStandMerchant(makeFeed(), { records: keepRecordsIn(directory, 8701) });
    merchant.moods.order = "accept_then_deliver";
    merchant.moods.deliverAfterMs = 0;
    await merchant.connect(gateway.url, KEY);
    gateway.hand(anOrder());
    await waitUntil(() => gateway.deliveries.length === 1);

    gateway.hand(anOrder());
    await waitUntil(() => gateway.answers.length === 2);
    await settle();

    expect(gateway.answers.map((one) => one.body)).toEqual([{ accepted: {} }, { accepted: {} }]);
    expect(gateway.deliveries).toHaveLength(1);
  });
});

describe("two stands on one records directory", () => {
  it("keep one record of an order both were handed, and both answer with it", async () => {
    // The promise: two processes of one merchant share one effect per order.
    // Both handlers must have looked for a record before either writes one, or
    // the second simply finds the first's record and the race is never run;
    // holding both orders for a person is what lines them up, and the two
    // answers given are the two different moods.
    const directory = await recordsDirectory();
    const firstGateway = await handingGateway();
    const secondGateway = await handingGateway();
    const first = makeStandMerchant(makeFeed(), { records: keepRecordsIn(directory, 8701) });
    const second = makeStandMerchant(makeFeed(), { records: keepRecordsIn(directory, 8702) });
    merchant = first;
    shutting.push(() => second.disconnect(), firstGateway.close, secondGateway.close);
    first.moods.order = "ask_me";
    second.moods.order = "ask_me";
    await first.connect(firstGateway.url, KEY);
    await second.connect(secondGateway.url, KEY);

    firstGateway.hand(anOrder());
    secondGateway.hand(anOrder());
    await waitUntil(() => first.held.has(ORDER_ID) && second.held.has(ORDER_ID));

    first.answerHeld(ORDER_ID, "deliver");
    await waitUntil(() => firstGateway.answers.length === 1);
    second.answerHeld(ORDER_ID, "refuse");
    await waitUntil(() => secondGateway.answers.length === 1);

    const records = await recordsIn(directory);
    expect(records).toHaveLength(1);
    expect(records[0]?.port).toBe(8701);
    expect(firstGateway.answers[0]?.body).toEqual(records[0]?.answer);
    expect(secondGateway.answers[0]?.body).toEqual(records[0]?.answer);
    expect(await arrivalsIn(directory)).toHaveLength(2);
    // Neither stand left behind the file it wrote its record under before
    // linking it, the winner's nor the loser's.
    expect(await strayFilesIn(directory)).toEqual([]);
  });

  it("make one delivery between them for an order both took on", async () => {
    // The promise: the delivery that follows an order taken on is part of its
    // one effect, so only the stand whose record stands promises it. The one
    // that lost the race answers with the winner's record and schedules
    // nothing, or two stands both on "Accept, then deliver" deliver twice.
    const directory = await recordsDirectory();
    const firstGateway = await handingGateway();
    const secondGateway = await handingGateway();
    const first = makeStandMerchant(makeFeed(), { records: keepRecordsIn(directory, 8701) });
    const second = makeStandMerchant(makeFeed(), { records: keepRecordsIn(directory, 8702) });
    merchant = first;
    shutting.push(() => second.disconnect(), firstGateway.close, secondGateway.close);
    for (const stand of [first, second]) {
      stand.moods.order = "ask_me";
      stand.moods.deliverAfterMs = 0;
    }
    await first.connect(firstGateway.url, KEY);
    await second.connect(secondGateway.url, KEY);

    firstGateway.hand(anOrder());
    secondGateway.hand(anOrder());
    await waitUntil(() => first.held.has(ORDER_ID) && second.held.has(ORDER_ID));

    first.answerHeld(ORDER_ID, "accept");
    await waitUntil(() => firstGateway.deliveries.length === 1);
    second.answerHeld(ORDER_ID, "accept");
    await waitUntil(() => secondGateway.answers.length === 1);
    await settle();

    expect(secondGateway.answers[0]?.body).toEqual({ accepted: {} });
    expect(firstGateway.deliveries.length + secondGateway.deliveries.length).toBe(1);
  });
});

describe("a stand keeping no records", () => {
  it("decides a repeat afresh, so goods corrected on a repeat go out", async () => {
    // The promise: without a records directory the stand is the stand it has
    // always been. A story where the merchant corrects their goods on a repeat
    // can only be played by a stand that remembers nothing.
    const gateway = await handingGateway();
    shutting.push(gateway.close);
    merchant = makeStandMerchant(makeFeed());
    merchant.moods.delivery = { licence: "the-first-goods" };
    await merchant.connect(gateway.url, KEY);
    gateway.hand(anOrder());
    await waitUntil(() => gateway.answers.length === 1);

    merchant.moods.delivery = { licence: "the-corrected-goods" };
    gateway.hand(anOrder());
    await waitUntil(() => gateway.answers.length === 2);

    expect(gateway.answers[1]?.body).toEqual({ delivered: { licence: "the-corrected-goods" } });
  });
});

describe("an order paused as it arrives", () => {
  it("is neither answered nor recorded until it is released, and then is both", async () => {
    // The promise: "before the effect" means before it. A tester who crashes
    // the stand here must find no record and no answer, or the phase they
    // meant to hit is not the phase they hit.
    const gateway = await handingGateway();
    shutting.push(gateway.close);
    const directory = await recordsDirectory();
    const stand = makeStandMerchant(makeFeed(), { records: keepRecordsIn(directory, 8701) });
    merchant = stand;
    stand.moods.delivery = { licence: "the-goods" };
    stand.pause.at = "arrival";
    await stand.connect(gateway.url, KEY);

    gateway.hand(anOrder());
    await waitUntil(() => stand.paused.get(ORDER_ID)?.phase === "arrival");
    await settle();

    expect(gateway.answers).toEqual([]);
    expect(await recordsIn(directory)).toEqual([]);
    expect(await arrivalsIn(directory)).toHaveLength(1);

    expect(stand.releasePaused(ORDER_ID)).toBe(true);
    await waitUntil(() => gateway.answers.length === 1);

    expect(gateway.answers[0]?.body).toEqual({ delivered: { licence: "the-goods" } });
    expect((await recordsIn(directory)).map((one) => one.answer)).toEqual([
      gateway.answers[0]?.body,
    ]);
  });

  it("pauses an arrival once, at the point set when it arrived, whatever is set while it waits", async () => {
    // The promise: the pause point applies to arrivals. A tester who moves it
    // while an order is paused is setting up the next arrival; the one already
    // stopped goes on when released and is not stopped a second time.
    const gateway = await handingGateway();
    shutting.push(gateway.close);
    const stand = makeStandMerchant(makeFeed());
    merchant = stand;
    stand.pause.at = "arrival";
    await stand.connect(gateway.url, KEY);

    gateway.hand(anOrder());
    await waitUntil(() => stand.paused.get(ORDER_ID)?.phase === "arrival");
    stand.pause.at = "answer_ready";

    expect(stand.releasePaused(ORDER_ID)).toBe(true);
    await waitUntil(() => gateway.answers.length === 1);
    expect(stand.paused.size).toBe(0);
  });
});

describe("an order paused with its answer ready", () => {
  it("is recorded and not answered until it is released, and so is its repeat", async () => {
    // The promise: "after the durable effect, before the acknowledgement". The
    // record is on disk and the gateway has heard nothing, which is the state
    // a crash here leaves behind. A repeat is paused at the same point, so two
    // stands holding one redelivered order can both be caught there.
    const gateway = await handingGateway();
    shutting.push(gateway.close);
    const directory = await recordsDirectory();
    const stand = makeStandMerchant(makeFeed(), { records: keepRecordsIn(directory, 8701) });
    merchant = stand;
    stand.moods.order = "refuse";
    stand.pause.at = "answer_ready";
    await stand.connect(gateway.url, KEY);

    gateway.hand(anOrder());
    await waitUntil(() => stand.paused.get(ORDER_ID)?.phase === "answer_ready");
    const records = await recordsIn(directory);
    await settle();

    expect(records.map((one) => one.answer)).toEqual([{ refused: stand.moods.refusal }]);
    expect(gateway.answers).toEqual([]);

    stand.releasePaused(ORDER_ID);
    await waitUntil(() => gateway.answers.length === 1);
    expect(gateway.answers[0]?.body).toEqual(records[0]?.answer);

    gateway.hand(anOrder());
    await waitUntil(() => stand.paused.get(ORDER_ID)?.phase === "answer_ready");
    await settle();
    expect(gateway.answers).toHaveLength(1);

    stand.releasePaused(ORDER_ID);
    await waitUntil(() => gateway.answers.length === 2);
    expect(gateway.answers[1]?.body).toEqual(records[0]?.answer);
  });

  it("makes no delivery for an order it took on until its answer is released", async () => {
    // The promise: the gateway hears that the order was taken on before the
    // goods arrive. A delivery scheduled while that answer was still paused
    // would arrive for an order the gateway had never been told was taken on.
    const gateway = await handingGateway();
    shutting.push(gateway.close);
    const stand = makeStandMerchant(makeFeed());
    merchant = stand;
    stand.moods.order = "accept_then_deliver";
    stand.moods.deliverAfterMs = 0;
    stand.pause.at = "answer_ready";
    await stand.connect(gateway.url, KEY);

    gateway.hand(anOrder());
    await waitUntil(() => stand.paused.has(ORDER_ID));
    await settle();

    expect(gateway.deliveries).toEqual([]);
    expect(gateway.answers).toEqual([]);

    stand.releasePaused(ORDER_ID);
    await waitUntil(() => gateway.deliveries.length === 1);
    expect(gateway.answers.map((one) => one.body)).toEqual([{ accepted: {} }]);
  });
});

/** Fails, rather than waiting on, a promise that has not settled within `ms`. */
const within = async <T>(ms: number, promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`still waiting after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Whether the SDK said the handler threw on this order, so nothing was answered for it. */
const handlerFailedOn = (feed: ReturnType<typeof makeFeed>, orderId: string): boolean =>
  feed
    .entries()
    .some(
      (entry) => detailOf(entry).error === "handler_failed" && detailOf(entry).subject === orderId,
    );

/**
 * Connects the stand with a delivery for an earlier order on its way and held
 * by the gateway, and returns the call that lets it through.
 *
 * A disconnect waits for that delivery before it stops the SDK, and the SDK
 * goes on posting answers meanwhile, so an answer that must never be sent has
 * all the time it needs to reach the gateway. Without it the stop aborts the
 * post first and a test of "answers nothing" holds only by timing.
 */
const connectedWithADeliveryInFlight = async (
  stand: ReturnType<typeof makeStandMerchant>,
  gateway: Awaited<ReturnType<typeof handingGateway>>,
): Promise<() => void> => {
  stand.moods.order = "accept_then_deliver";
  stand.moods.deliverAfterMs = 0;
  const letDeliveriesThrough = gateway.holdDeliveries();
  await stand.connect(gateway.url, KEY);
  gateway.hand(anOrder("an-order-whose-delivery-is-on-its-way"));
  await waitUntil(() => gateway.deliveries.length === 1);
  return letDeliveriesThrough;
};

describe("disconnecting while an order is held for a person", () => {
  it("answers and records nothing for the held order, as for a paused one", async () => {
    // The promise: nobody answered because the stand went away, which is not
    // the merchant refusing. A refusal recorded here would be the order's one
    // effect although it never reached the gateway, and every repeat after it
    // would be refused with it.
    const gateway = await handingGateway();
    shutting.push(gateway.close);
    const directory = await recordsDirectory();
    const feed = makeFeed();
    const stand = makeStandMerchant(feed, { records: keepRecordsIn(directory, 8701) });
    merchant = stand;
    const letDeliveriesThrough = await connectedWithADeliveryInFlight(stand, gateway);
    let disconnecting = Promise.resolve();
    try {
      stand.moods.order = "ask_me";
      gateway.hand(anOrder());
      await waitUntil(() => stand.held.has(ORDER_ID));

      disconnecting = stand.disconnect();
      await settle();
    } finally {
      letDeliveriesThrough();
    }
    await within(5_000, disconnecting);

    expect(gateway.answers.filter((one) => one.orderId === ORDER_ID)).toEqual([]);
    expect((await recordsIn(directory)).filter((one) => one.order_id === ORDER_ID)).toEqual([]);
    expect(stand.held.size).toBe(0);
    expect(handlerFailedOn(feed, ORDER_ID)).toBe(true);
  });

  it("gives up at once on an order handed over while it waits on a delivery", async () => {
    // The promise: a disconnect never holds an order for a person it will not
    // show it to. The worker goes on polling while the disconnect waits for a
    // delivery already on its way, and an order it hands over then has to be
    // given up on at once, not held to the ceiling and refused.
    const gateway = await handingGateway();
    shutting.push(gateway.close);
    const directory = await recordsDirectory();
    const feed = makeFeed();
    const stand = makeStandMerchant(feed, { records: keepRecordsIn(directory, 8701) });
    merchant = stand;
    const late = "an-order-handed-over-during-the-disconnect";
    const letDeliveriesThrough = await connectedWithADeliveryInFlight(stand, gateway);
    let disconnecting = Promise.resolve();
    try {
      stand.moods.order = "ask_me";
      disconnecting = stand.disconnect();
      await waitUntil(() => feed.entries().some(isWaitingForDeliveries));
      gateway.hand(anOrder(late));

      await waitUntil(() => handlerFailedOn(feed, late), 2_000);
      expect(stand.held.size).toBe(0);
    } finally {
      letDeliveriesThrough();
    }
    await within(5_000, disconnecting);

    expect(gateway.answers.filter((one) => one.orderId === late)).toEqual([]);
    expect((await recordsIn(directory)).filter((one) => one.order_id === late)).toEqual([]);
  });

  it("still refuses, and records the refusal, when nobody answers while it is connected", async () => {
    // The negative control of the two above: the ceiling's refusal is a real
    // answer, recorded and sent, so the silence there is the disconnect's
    // doing and not a stand that never records a held order.
    const gateway = await handingGateway();
    shutting.push(gateway.close);
    const directory = await recordsDirectory();
    const stand = makeStandMerchant(makeFeed(), { records: keepRecordsIn(directory, 8701) });
    merchant = stand;
    stand.moods.order = "ask_me";

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await stand.connect(gateway.url, KEY);
      gateway.hand(anOrder());
      const until = Date.now() + 5_000;
      while (!stand.held.has(ORDER_ID) && Date.now() < until) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(stand.held.has(ORDER_ID)).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
    } finally {
      vi.useRealTimers();
    }
    await waitUntil(() => gateway.answers.length === 1);

    const refusal = { refused: expect.objectContaining({ code: "nobody_answered" }) };
    expect(gateway.answers[0]?.body).toEqual(refusal);
    expect((await recordsIn(directory)).map((one) => one.answer)).toEqual([refusal]);
  });
});

describe("disconnecting while an order is paused", () => {
  it("returns, and answers and records nothing for an order paused as it arrived", async () => {
    // The promise: a disconnect lets go of a paused order by giving up on it,
    // so the gateway sends the order again. Letting it run on would make an
    // effect and an answer nobody released.
    const gateway = await handingGateway();
    shutting.push(gateway.close);
    const directory = await recordsDirectory();
    const feed = makeFeed();
    const stand = makeStandMerchant(feed, { records: keepRecordsIn(directory, 8701) });
    merchant = stand;
    stand.pause.at = "arrival";
    await stand.connect(gateway.url, KEY);
    gateway.hand(anOrder());
    await waitUntil(() => stand.paused.has(ORDER_ID));

    await within(5_000, stand.disconnect());

    expect(gateway.answers).toEqual([]);
    expect(await recordsIn(directory)).toEqual([]);
    expect(stand.paused.size).toBe(0);
    // The SDK's word for a handler that answered nothing, so the order returns.
    expect(handlerFailedOn(feed, ORDER_ID)).toBe(true);
  });

  it("returns when the next order of a batch reaches a pause while it waits on a delivery", async () => {
    // The promise: a disconnect never waits on a pause nobody can release. It
    // does wait for a delivery already on its way, and meanwhile the worker
    // goes on to the next order of the batch it was handed; that order has to
    // give up at once rather than pause behind the disconnect.
    const gateway = await handingGateway();
    shutting.push(gateway.close);
    const stand = makeStandMerchant(makeFeed());
    merchant = stand;
    const letDeliveriesThrough = await connectedWithADeliveryInFlight(stand, gateway);

    stand.pause.at = "arrival";
    gateway.hand(anOrder(), anOrder("the-next-order-in-the-same-batch"));
    await waitUntil(() => stand.paused.has(ORDER_ID));
    const disconnecting = stand.disconnect();
    await settle();
    letDeliveriesThrough();

    await within(5_000, disconnecting);
    expect(stand.paused.size).toBe(0);
  });

  it("keeps the record of an order paused with its answer ready, and answers nothing", async () => {
    // The promise: an effect already made is not undone by a disconnect, and
    // the answer nobody released is not sent. The repeat that follows finds
    // the record. The delivery in flight keeps the SDK running after the
    // disconnect began, so a handler let go on instead of given up on would
    // have its answer reach the gateway.
    const gateway = await handingGateway();
    shutting.push(gateway.close);
    const directory = await recordsDirectory();
    const feed = makeFeed();
    const stand = makeStandMerchant(feed, { records: keepRecordsIn(directory, 8701) });
    merchant = stand;
    const letDeliveriesThrough = await connectedWithADeliveryInFlight(stand, gateway);
    let disconnecting = Promise.resolve();
    try {
      stand.moods.order = "refuse";
      stand.pause.at = "answer_ready";
      gateway.hand(anOrder());
      await waitUntil(() => stand.paused.has(ORDER_ID));

      disconnecting = stand.disconnect();
      await settle();
    } finally {
      letDeliveriesThrough();
    }
    await within(5_000, disconnecting);

    expect(gateway.answers.filter((one) => one.orderId === ORDER_ID)).toEqual([]);
    expect(handlerFailedOn(feed, ORDER_ID)).toBe(true);
    expect(
      (await recordsIn(directory))
        .filter((one) => one.order_id === ORDER_ID)
        .map((one) => one.answer),
    ).toEqual([{ refused: stand.moods.refusal }]);
  });
});

describe("a stand whose record cannot be written", () => {
  it("answers nothing, and leaves only the arrival in the records directory", async () => {
    // The promise: the directory holds the arrivals and one record per
    // answered order, and nothing else, so a tester counting files counts
    // effects; and an order whose record did not land is not answered, since
    // the record is what goes before the answer. A disk failing the write is
    // played by a flush that fails.
    const gateway = await handingGateway();
    shutting.push(gateway.close);
    const directory = await recordsDirectory();
    const feed = makeFeed();
    merchant = makeStandMerchant(feed, { records: keepRecordsIn(directory, 8701) });
    await merchant.connect(gateway.url, KEY);

    const probe = await open(directory, "r");
    const handles = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const failing = vi
      .spyOn(handles, "sync")
      .mockRejectedValueOnce(
        Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }),
      );
    try {
      gateway.hand(anOrder());
      await waitUntil(() => handlerFailedOn(feed, ORDER_ID));
    } finally {
      failing.mockRestore();
    }

    expect(gateway.answers).toEqual([]);
    expect(await recordsIn(directory)).toEqual([]);
    expect(await arrivalsIn(directory)).toHaveLength(1);
    expect(await strayFilesIn(directory)).toEqual([]);
  });
});

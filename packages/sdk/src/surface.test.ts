/**
 * The surface a merchant registers on and the objects it hands them: one `on`
 * for every kind that arrives, one `start` and one `stop`, and an order that
 * carries the calls which close it, so a merchant delivering hours later, from
 * another process, never passes an identifier back. The loop itself is tested
 * in `worker.test.ts`. The block at the end is checked by the compiler: the
 * kind a handler is registered under and the handler must agree.
 */

import type {
  Order,
  OrderEvent,
  OrderWithStatus,
  QuoteRequest,
  WorkerEnvelope,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentifyClient, HandlerKind, OrderCalls } from "./client.js";
import { createClient } from "./index.js";
import { type FakeGateway, type GatewayAnswer, startFakeGateway } from "./testing/fake-gateway.js";
import { waitUntil } from "./testing/waiting.js";
import { batch, polling } from "./testing/worker-stream.js";
import type { WorkerProblem } from "./worker.js";

const API_KEY = "merchant-key-for-the-tests";
const AT = "2026-08-26T10:20:00Z";

const order: Order = {
  id: "order-1",
  merchant_item_id: "access-monthly",
  params: { email: "buyer@example.com" },
  price: { amount: "5.00", currency: "USD", at: AT, as_of: AT },
  test: false,
};

const openOrder: OrderWithStatus = { ...order, status: "in_progress", payment_status: "paid" };

const question: QuoteRequest = {
  merchant_item_id: "access-monthly",
  price_id: "price-1",
  purpose: "purchase",
  expires_at: "2026-08-26T10:25:00Z",
};

const event: OrderEvent = {
  type: "order.unfulfilled",
  order_id: "order-1",
  at: AT,
  price: { amount: "5.00", currency: "USD" },
  reason: "deadline_passed",
};

const envelopes = {
  order: { kind: "order", id: "env-1", sent_at: AT, payload: order },
  quote: { kind: "quote_request", id: "env-2", sent_at: AT, payload: question },
  event: { kind: "order_event", id: "env-3", sent_at: AT, payload: event },
} satisfies Record<string, WorkerEnvelope>;

let gateway: FakeGateway | undefined;
let running: { stop(): Promise<void> } | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  await gateway?.close();
  gateway = undefined;
  vi.restoreAllMocks();
});

const clientOver = async (routes: Parameters<typeof startFakeGateway>[0]["routes"]) => {
  gateway = await startFakeGateway({ apiKey: API_KEY, routes });
  return createClient({ apiKey: API_KEY, baseUrl: gateway.url });
};

describe("registering what a process answers", () => {
  it("carries all three kinds of one stream through one registration surface", async () => {
    // The promise: one kind of line for every kind that can arrive.
    const seen: string[] = [];

    const agentify = await clientOver({
      poll_worker: polling(batch(envelopes.order, envelopes.quote, envelopes.event)),
      answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      answer_quote: () => ({ body: { used: true } }),
    });

    agentify.on("order", (arrived) => {
      seen.push(`order ${arrived.id}`);
      return arrived.delivered({ access_url: "https://a.example" });
    });
    agentify.on("quote", (asked) => {
      seen.push(`quote ${asked.price_id}`);
      return asked.unavailable(AT);
    });
    agentify.on("event", (arrived) => {
      seen.push(`event ${arrived.type}`);
    });

    running = agentify;
    await agentify.start();

    await waitUntil(() => seen.length === 3, "all three kinds to reach their handlers");
    expect(seen).toStrictEqual(["order order-1", "quote price-1", "event order.unfulfilled"]);
  });

  it("refuses a second handler for a kind rather than replacing the first in silence", async () => {
    const agentify = await clientOver({ poll_worker: polling() });

    agentify.on("order", (arrived) => arrived.accepted());
    expect(() => agentify.on("order", (arrived) => arrived.accepted())).toThrow(/twice/);

    agentify.on("quote", (asked) => asked.unavailable());
    expect(() => agentify.on("quote", (asked) => asked.unavailable())).toThrow(/twice/);

    agentify.on("event", () => {});
    expect(() => agentify.on("event", () => {})).toThrow(/twice/);

    agentify.on("problem", () => {});
    expect(() => agentify.on("problem", () => {})).toThrow(/twice/);
  });

  it("refuses a kind nothing will ever deliver, and says which ones there are", async () => {
    // A merchant outside TypeScript, or one who typed `orders`, would
    // otherwise register a handler never called; being told the four words
    // turns the refusal into a fix.
    const agentify = await clientOver({ poll_worker: polling() });
    const on = (agentify as unknown as { on(kind: string, handler: () => void): void }).on;

    let complaint = "";

    try {
      on.call(agentify, "orders", () => {});
    } catch (refused) {
      complaint = String(refused);
    }

    expect(complaint).toMatch(/orders/);
    for (const kind of ["order", "quote", "event", "problem"]) {
      expect(complaint).toContain(`'${kind}'`);
    }
  });
});

describe("the lifecycle a merchant drives", () => {
  it("refuses to start a worker that would answer nothing", async () => {
    // With no handler, every order arrives, nothing answers it, and a delivery
    // attempt is spent each time.
    const agentify = await clientOver({ poll_worker: polling() });

    await expect(agentify.start()).rejects.toThrow(/on\(/);

    // A reporter alone is not an answer to anything on the stream.
    agentify.on("problem", () => {});
    await expect(agentify.start()).rejects.toThrow(/on\(/);
  });

  it("dispatches to a handler registered after the loop was already running", async () => {
    // Handlers belong to the client and are read when an envelope arrives. A
    // loop that copied them at start() would miss this price handler, and the
    // sale would fall back to the card's price with no problem reported.
    const parked = new Promise<GatewayAnswer>(() => {});
    let releaseTheQuote: (() => void) | undefined;
    const quoteMayArrive = new Promise<void>((resolve) => {
      releaseTheQuote = resolve;
    });

    const seen: string[] = [];

    const agentify = await clientOver({
      poll_worker: async (_call, index) => {
        if (index === 0) return batch(envelopes.order);
        if (index === 1) {
          await quoteMayArrive;
          return batch(envelopes.quote);
        }
        return parked;
      },
      answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      answer_quote: () => ({ body: { used: true } }),
    });

    agentify.on("order", (arrived) => {
      seen.push(`order ${arrived.id}`);
      return arrived.delivered({ access_url: "https://a.example" });
    });

    running = agentify;
    await agentify.start();
    await waitUntil(() => seen.length === 1, "the loop to be running");

    agentify.on("quote", (asked) => {
      seen.push(`quote ${asked.price_id}`);
      return asked.unavailable(AT);
    });
    releaseTheQuote?.();

    await waitUntil(() => seen.length === 2, "the later handler to receive a question");
    expect(seen[1]).toBe("quote price-1");
  });

  it("refuses a second start rather than running two loops for one client", async () => {
    const agentify = await clientOver({ poll_worker: polling() });

    agentify.on("order", (arrived) => arrived.accepted());
    running = agentify;
    await agentify.start();

    await expect(agentify.start()).rejects.toThrow(/already/);
  });

  it("stops before it has started, so a shutdown routine needs no flag of its own", async () => {
    const agentify = await clientOver({ poll_worker: polling() });

    agentify.on("order", (arrived) => arrived.accepted());

    await expect(agentify.stop()).resolves.toBeUndefined();
  });

  it("runs again on the handlers it already has after a stop", async () => {
    // A restarted worker does not rebuild the client or register again.
    let arrived = 0;

    const agentify = await clientOver({
      poll_worker: () => batch(envelopes.order),
      answer_order: () => ({ body: { ok: true, result: "delivered" } }),
    });

    agentify.on("order", (given) => {
      arrived += 1;
      return given.delivered({ access_url: "https://a.example" });
    });

    await agentify.start();
    await waitUntil(() => arrived > 0, "the first loop to receive an order");
    await agentify.stop();

    const whenItStopped = arrived;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(arrived).toBe(whenItStopped);

    running = agentify;
    await agentify.start();
    await waitUntil(() => arrived > whenItStopped, "the second loop to receive an order");
  });
});

describe("an order that carries the calls which close it", () => {
  it("builds the handler's answer without the merchant writing the wire's words", async () => {
    const answers: unknown[] = [];

    const agentify = await clientOver({
      poll_worker: polling(batch(envelopes.order)),
      answer_order: (call) => {
        answers.push(call.body);
        return { body: { ok: true, result: "delivered" } };
      },
    });

    agentify.on("order", (arrived) => arrived.delivered({ access_url: "https://a.example" }));
    running = agentify;
    await agentify.start();

    await waitUntil(() => answers.length === 1, "the answer to reach the gateway");
    expect(answers[0]).toStrictEqual({ delivered: { access_url: "https://a.example" } });
  });

  it("builds a refusal and an acceptance in the same words the contract carries", async () => {
    // The builders produce the answer and send nothing, so a handler that
    // builds three and returns one has answered once.
    const built: unknown[] = [];
    const answers: unknown[] = [];

    const agentify = await clientOver({
      poll_worker: polling(batch(envelopes.order)),
      answer_order: (call) => {
        answers.push(call.body);
        return { body: { ok: true, result: "accepted" } };
      },
      // Mounted so that a call to one of them would be recorded, not lost.
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
      refuse_order: () => ({ body: { ok: true, result: "refused" } }),
      accept_order: () => ({ body: { ok: true } }),
    });

    agentify.on("order", (arrived) => {
      built.push(arrived.delivered({ access_url: "https://a.example" }));
      built.push(arrived.refused({ code: "out_of_stock", message: "Мест на тарифе нет" }));
      built.push(arrived.accepted());
      built.push(arrived.accepted());
      return arrived.accepted();
    });

    running = agentify;
    await agentify.start();
    await waitUntil(() => answers.length === 1, "the one answer the handler returned");

    expect(built).toStrictEqual([
      { delivered: { access_url: "https://a.example" } },
      { refused: { code: "out_of_stock", message: "Мест на тарифе нет" } },
      { accepted: {} },
      { accepted: {} },
    ]);
    expect(answers).toStrictEqual([{ accepted: {} }]);

    // Four answers built, none sent: a builder that sent would close an order
    // the handler was only considering.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway?.callsTo("deliver_order")).toStrictEqual([]);
    expect(gateway?.callsTo("refuse_order")).toStrictEqual([]);
    expect(gateway?.callsTo("accept_order")).toStrictEqual([]);
  });

  it("delivers later, off the retained order, without the merchant holding an identifier", async () => {
    // The asynchronous merchant's day: take the order on now, deliver when the
    // supplier answers, keeping only the order.
    const agentify = await clientOver({
      poll_worker: polling(batch(envelopes.order)),
      answer_order: () => ({ body: { ok: true, result: "accepted" } }),
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
    });

    let taken: OrderCalls | undefined;

    agentify.on("order", (arrived) => {
      taken = arrived;
      return arrived.accepted();
    });

    running = agentify;
    await agentify.start();
    await waitUntil(() => taken !== undefined, "the order to reach the handler");

    const closed = await taken?.deliver({ access_url: "https://a.example" });

    expect(closed).toStrictEqual({ ok: true, result: "delivered" });
    expect(gateway?.callsTo("deliver_order")[0]?.params).toStrictEqual({ order_id: order.id });
    expect(gateway?.callsTo("deliver_order")[0]?.body).toStrictEqual({
      access_url: "https://a.example",
    });
  });

  it("refuses and accepts later off the same object", async () => {
    const agentify = await clientOver({
      poll_worker: polling(batch(envelopes.order)),
      answer_order: () => ({ body: { ok: true, result: "accepted" } }),
      refuse_order: () => ({ body: { ok: true, result: "refused" } }),
      accept_order: () => ({ body: { ok: true } }),
    });

    let taken: OrderCalls | undefined;

    agentify.on("order", (arrived) => {
      taken = arrived;
      return arrived.accepted();
    });

    running = agentify;
    await agentify.start();
    await waitUntil(() => taken !== undefined, "the order to reach the handler");

    expect(
      await taken?.refuse({ code: "out_of_stock", message: "the supplier had none" }),
    ).toStrictEqual({ ok: true, result: "refused" });
    expect(await taken?.accept()).toStrictEqual({ ok: true });

    expect(gateway?.callsTo("refuse_order")[0]?.params).toStrictEqual({ order_id: order.id });
    expect(gateway?.callsTo("accept_order")[0]?.body).toStrictEqual({});
  });

  it("names the order the merchant asked for when they have only its identifier", async () => {
    // The one place a merchant writes an identifier. It reaches no gateway to
    // build, so it works while the gateway is unreachable and a delivery still
    // has to be retried.
    const agentify = await clientOver({
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
      refuse_order: () => ({ body: { ok: true, result: "refused" } }),
      accept_order: () => ({ body: { ok: true } }),
    });

    const held = agentify.orders.forId("SKU 100/1");

    expect(held.id).toBe("SKU 100/1");
    expect(gateway?.calls).toStrictEqual([]);

    await held.deliver({ access_url: "https://a.example" });
    await held.refuse({ code: "out_of_stock", message: "gone" });
    await held.accept();

    for (const route of ["deliver_order", "refuse_order", "accept_order"] as const) {
      expect(gateway?.callsTo(route)[0]?.params, route).toStrictEqual({ order_id: "SKU 100/1" });
    }
  });

  it("hands the same calls to an order read back after a restart", async () => {
    // After a restart, an order read back must be the same thing the handler
    // received, or the merchant is back to carrying identifiers.
    const agentify = await clientOver({
      list_orders: () => ({ body: { orders: [openOrder] } }),
      get_order: () => ({ body: openOrder }),
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
      refuse_order: () => ({ body: { ok: true, result: "refused" } }),
    });

    const listed = await agentify.orders.list({ open: true });

    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("in_progress");
    expect(await listed[0]?.deliver({ access_url: "https://a.example" })).toStrictEqual({
      ok: true,
      result: "delivered",
    });

    const read = await agentify.orders.get(order.id);

    expect(await read.refuse({ code: "out_of_stock", message: "gone" })).toStrictEqual({
      ok: true,
      result: "refused",
    });

    expect(gateway?.callsTo("deliver_order")[0]?.params).toStrictEqual({ order_id: order.id });
    expect(gateway?.callsTo("refuse_order")[0]?.params).toStrictEqual({ order_id: order.id });
  });

  it("makes an order off a list indistinguishable from one off the stream", async () => {
    // Every call the handler's order has, the listed one has, and both send the
    // same request for the same delivery.
    const agentify = await clientOver({
      poll_worker: polling(batch(envelopes.order)),
      answer_order: () => ({ body: { ok: true, result: "accepted" } }),
      list_orders: () => ({ body: { orders: [openOrder] } }),
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
    });

    let fromStream: OrderCalls | undefined;

    agentify.on("order", (arrived) => {
      fromStream = arrived;
      return arrived.accepted();
    });

    running = agentify;
    await agentify.start();
    await waitUntil(() => fromStream !== undefined, "the order to reach the handler");

    const [fromList] = await agentify.orders.list({ open: true });

    // Compared by what they send, not by object identity, which would compare
    // closures.
    await fromStream?.deliver({ access_url: "https://a.example" });
    await fromList?.deliver({ access_url: "https://a.example" });

    const [first, second] = gateway?.callsTo("deliver_order") ?? [];

    expect(first?.params).toStrictEqual({ order_id: order.id });
    expect(second?.params).toStrictEqual(first?.params);
    expect(second?.body).toStrictEqual(first?.body);

    // And every call one of them answers to, the other answers to as well.
    for (const call of [
      "delivered",
      "refused",
      "accepted",
      "deliver",
      "refuse",
      "accept",
    ] as const) {
      expect(typeof fromStream?.[call]).toBe("function");
      expect(typeof fromList?.[call]).toBe("function");
    }
  });
});

describe("a price question that carries its own answer", () => {
  it("answers with a price, stamped with the moment unless the merchant names one", async () => {
    const bodies: unknown[] = [];

    const agentify = await clientOver({
      poll_worker: polling(batch(envelopes.quote)),
      answer_quote: (call) => {
        bodies.push(call.body);
        return { body: { used: true } };
      },
    });

    agentify.on("quote", (asked) =>
      asked.available({ amount: "3.50", currency: "USD" }, "2026-08-26T10:19:00Z"),
    );
    running = agentify;
    await agentify.start();

    await waitUntil(() => bodies.length === 1, "the price to reach the gateway");
    expect(bodies[0]).toStrictEqual({
      available: true,
      price: { amount: "3.50", currency: "USD" },
      as_of: "2026-08-26T10:19:00Z",
    });
  });

  it("stamps an answer the merchant did not date with the moment they gave it", async () => {
    // A price computed just now is as of now, since the gateway reads `as_of`
    // for freshness. Bracketed by real time, because the promise is "when you
    // answered".
    const bodies: Record<string, unknown>[] = [];

    const agentify = await clientOver({
      poll_worker: polling(batch(envelopes.quote)),
      answer_quote: (call) => {
        bodies.push(call.body as Record<string, unknown>);
        return { body: { used: true } };
      },
    });

    agentify.on("quote", (asked) => asked.available({ amount: "3.50", currency: "USD" }));
    running = agentify;

    const before = Date.now();
    await agentify.start();
    await waitUntil(() => bodies.length === 1, "the price to reach the gateway");
    const after = Date.now();

    const stamped = Date.parse(String(bodies[0]?.as_of));

    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);

    // Not the question's own moment, the nearest wrong answer.
    expect(bodies[0]?.as_of).not.toBe(question.expires_at);
  });

  it("answers that there is none, and carries no price when it does", async () => {
    const bodies: unknown[] = [];

    const agentify = await clientOver({
      poll_worker: polling(batch(envelopes.quote)),
      answer_quote: (call) => {
        bodies.push(call.body);
        return { body: { used: true } };
      },
    });

    agentify.on("quote", (asked) => asked.unavailable(AT));
    running = agentify;
    await agentify.start();

    await waitUntil(() => bodies.length === 1, "the answer to reach the gateway");
    expect(bodies[0]).toStrictEqual({ available: false, as_of: AT });
  });
});

describe("where problems go", () => {
  it("reaches the reporter the client was given", async () => {
    const problems: WorkerProblem[] = [];

    const agentify = await clientOver({ poll_worker: polling(batch(envelopes.order)) });

    agentify.on("quote", (asked) => asked.unavailable(AT));
    agentify.on("problem", (problem) => problems.push(problem));
    running = agentify;
    await agentify.start();

    await waitUntil(() => problems.length > 0, "the problem to reach the reporter");
    expect(problems[0]?.kind).toBe("no_handler");
    expect(problems[0]?.message).toMatch(/on\('order'\)/);
  });

  it("names the registration that is missing, and not another one", async () => {
    // The sentence tells the merchant which line to write; naming the wrong
    // kind would send them to add a handler they already have.
    const problems: WorkerProblem[] = [];

    const agentify = await clientOver({
      poll_worker: polling(batch(envelopes.quote, envelopes.event)),
    });

    agentify.on("order", (arrived) => arrived.accepted());
    agentify.on("problem", (problem) => problems.push(problem));
    running = agentify;
    await agentify.start();

    await waitUntil(() => problems.length === 2, "both kinds to go unhandled");

    const said = problems.map((problem) => problem.message);

    expect(said[0]).toMatch(/on\('quote'\)/);
    expect(said[0]).not.toMatch(/on\('order'\)|on\('event'\)/);
    expect(said[1]).toMatch(/on\('event'\)/);
    expect(said[1]).not.toMatch(/on\('order'\)|on\('quote'\)/);
  });

  it("survives a reporter that fails a turn later, not only one that throws", async () => {
    // An async reporter satisfies a signature returning nothing, and its
    // rejection arrives after any try/catch around the call; unhandled, it
    // ends the host process under Node's default, most likely during shutdown
    // when the reporter is busiest.
    const escaped: unknown[] = [];
    const noticed = (reason: unknown): void => {
      escaped.push(reason);
    };

    process.on("unhandledRejection", noticed);

    try {
      const reported: WorkerProblem[] = [];
      const agentify = await clientOver({ poll_worker: polling(batch(envelopes.order)) });

      agentify.on("quote", (asked) => asked.unavailable(AT));
      agentify.on("problem", async (problem) => {
        reported.push(problem);
        await Promise.resolve();
        throw new Error("the merchant's logger was closed during shutdown");
      });

      running = agentify;
      await agentify.start();

      await waitUntil(() => reported.length > 0, "the problem to reach the reporter");

      // Long enough for a rejection to be noticed as unhandled, a turn after
      // it settles.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(escaped).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", noticed);
    }
  });

  it("goes to the error console when the merchant registered none", async () => {
    // A worker that stopped in silence is worse than a library writing to the
    // console.
    const written = vi.spyOn(console, "error").mockImplementation(() => {});

    const agentify = await clientOver({ poll_worker: polling(batch(envelopes.order)) });

    agentify.on("quote", (asked) => asked.unavailable(AT));
    running = agentify;
    await agentify.start();

    await waitUntil(() => written.mock.calls.length > 0, "the problem to reach the console");
    expect(String(written.mock.calls[0]?.[0])).toMatch(/no_handler/);
  });
});

/**
 * What the compiler refuses. None of this runs: every `@ts-expect-error`
 * fails the build the day the line under it starts compiling, and every line
 * without one fails the day it stops.
 */
const compilerHoldsTheseTrue = (agentify: AgentifyClient, kind: HandlerKind): void => {
  // What a handler receives and returns is inferred from the kind, with no
  // annotation.
  agentify.on("order", (order) => order.delivered({ access_url: order.id }));
  agentify.on("quote", (question) => question.available({ amount: "1.00", currency: "USD" }));
  agentify.on("event", (event) => {
    void event.order_id;
  });
  agentify.on("problem", (problem) => {
    void problem.kind;
  });

  // A handler for one kind under another would fail at the first message, and
  // every sale of that card would fall back to the card's own price.
  // @ts-expect-error an order handler is not what answers a price question
  agentify.on("quote", (order) => order.delivered({ access_url: order.id }));

  // A kind not known at the call site cannot say which handler is right.
  // @ts-expect-error the kind has to be narrowed to one kind first
  agentify.on(kind, (order) => order.delivered({ access_url: order.id }));

  for (const each of ["order", "quote"] as const) {
    // @ts-expect-error and the same holds for a loop over several of them
    agentify.on(each, (order) => order.delivered({ access_url: order.id }));
  }

  // The answer a handler returns is held to the three the contract carries.
  // @ts-expect-error a bare delivery is not one of them
  agentify.on("order", (order) => ({ access_url: order.id }));

  // And a word nothing on the stream is registered under.
  // @ts-expect-error there is no such kind
  agentify.on("orders", () => {});
};

void compilerHoldsTheseTrue;

import type {
  HandlerAnswer,
  Order,
  OrderEvent,
  QuoteRequest,
  WorkerEnvelope,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_RETRY_MS, RETRY_CEILING_MS } from "./backoff.js";
import { createClient, type QuoteHandler } from "./client.js";
import { contractVersion } from "./contract.js";
import { type FakeGateway, startFakeGateway } from "./testing/fake-gateway.js";
import { waitUntil } from "./testing/waiting.js";
import { batch, polling } from "./testing/worker-stream.js";
import {
  POLL_DEADLINE_MS,
  POLL_WAIT_SECONDS,
  QUIET_POLL_FLOOR_MS,
  startWorker,
  systemClock,
  WORKER_PROBLEM_KINDS,
  type WorkerClock,
  type WorkerProblem,
} from "./worker.js";

const API_KEY = "merchant-key-for-the-tests";
const AT = "2026-08-26T10:20:00Z";

const order: Order = {
  id: "order-1",
  merchant_item_id: "access-monthly",
  params: { email: "buyer@example.com" },
  price: { amount: "5.00", currency: "USD", at: AT, as_of: AT },
  test: false,
};

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

/** A clock that records what it was asked to wait for and waits for none of it. */
const recordingClock = (): WorkerClock & { readonly waits: number[]; elapse(ms: number): void } => {
  const waits: number[] = [];
  let clock = 0;

  return {
    waits,
    elapse: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    random: () => 1,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
};

let gateway: FakeGateway | undefined;
let running: { stop(): Promise<void> } | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  await gateway?.close();
  gateway = undefined;
});

interface Subscribed {
  readonly problems: WorkerProblem[];
  readonly events: OrderEvent[];
}

const workerOver = async (
  routes: Parameters<typeof startFakeGateway>[0]["routes"],
  handlers: {
    order?: (given: Order) => HandlerAnswer | Promise<HandlerAnswer>;
    quote?: QuoteHandler;
  },
): Promise<Subscribed> => {
  gateway = await startFakeGateway({ apiKey: API_KEY, routes });

  const problems: WorkerProblem[] = [];
  const events: OrderEvent[] = [];
  const agentify = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

  const answering = handlers.order;

  if (answering !== undefined) {
    agentify.on("order", (arrived) => answering(arrived));
    agentify.on("event", (arrived) => {
      events.push(arrived);
    });
  }
  if (handlers.quote !== undefined) {
    agentify.on("quote", handlers.quote);
  }

  agentify.on("problem", (problem) => problems.push(problem));
  running = agentify;
  await agentify.start();

  return { problems, events };
};

describe("an order off the worker stream", () => {
  it("reaches the handler as an order, not as the envelope it travelled in", async () => {
    // The promise: the merchant's code never learns what the transport is, so
    // changing it does not touch their handler.
    const seen: Order[] = [];

    await workerOver(
      {
        poll_worker: polling(batch(envelopes.order)),
        answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      },
      {
        order: (given) => {
          seen.push(given);
          return { delivered: { access_url: "https://example.com/a" } };
        },
      },
    );

    await waitUntil(() => seen.length === 1, "the order to reach the handler");

    // The handler is also given the calls that close the order, so the fields
    // are compared, not the whole object.
    const { id, merchant_item_id, params, price, test } = seen[0] as Order;

    expect({ id, merchant_item_id, params, price, test }).toStrictEqual(order);
  });

  it.each([
    ["the goods", { delivered: { access_url: "https://example.com/a" } }],
    ["a refusal", { refused: { code: "out_of_stock", message: "Мест на тарифе нет" } }],
    ["an acceptance", { accepted: {} }],
  ])(
    "sends what the handler returned — %s — to the order's answer route",
    async (_what, answer) => {
      // The handler's return has its own route, posted in every mode; without
      // it a synchronous handler's answer reaches nobody.
      await workerOver(
        {
          poll_worker: polling(batch(envelopes.order)),
          answer_order: () => ({ body: { ok: true, result: "delivered" } }),
        },
        { order: () => answer as HandlerAnswer },
      );

      await waitUntil(() => (gateway?.callsTo("answer_order").length ?? 0) === 1, "the answer");

      const sent = gateway?.callsTo("answer_order")[0];
      expect(sent?.params).toStrictEqual({ order_id: order.id });
      expect(sent?.body).toStrictEqual(answer);
    },
  );

  it("answers nothing when the handler throws, and handles the redelivery", async () => {
    // An exception means the order was not delivered: it comes back on the
    // gateway's timer and the handler runs again. A retry on this side would
    // be a second opinion about how often a merchant's code may run.
    let attempts = 0;

    await workerOver(
      {
        poll_worker: polling(batch(envelopes.order), batch(envelopes.order)),
        answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      },
      {
        order: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("the supplier timed out");
          return { delivered: { access_url: "https://example.com/a" } };
        },
      },
    );

    await waitUntil(
      () => (gateway?.callsTo("answer_order").length ?? 0) === 1,
      "the second answer",
    );
    expect(attempts).toBe(2);
    expect(gateway?.callsTo("answer_order")).toHaveLength(1);
  });

  it("says so when the handler threw, naming the order", async () => {
    const { problems } = await workerOver(
      { poll_worker: polling(batch(envelopes.order)) },
      {
        order: () => {
          throw new Error("the supplier timed out");
        },
      },
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");
    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.HANDLER_FAILED);
    expect(problems[0]?.subject).toBe(order.id);
    expect(problems[0]?.message).toMatch(/the supplier timed out/);
    expect(problems[0]?.fatal).toBe(false);
  });

  it("sends nothing when the handler answers with something the contract refuses", async () => {
    // "Not right now" is not one of the three answers. Held back, the order
    // is redelivered and the merchant is told why.
    const { problems } = await workerOver(
      { poll_worker: polling(batch(envelopes.order)) },
      {
        order: () => ({ later: true }) as unknown as HandlerAnswer,
      },
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");
    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.HANDLER_ANSWER_REFUSED);
    expect(gateway?.callsTo("answer_order")).toHaveLength(0);
  });

  it("says so when the gateway would not take the answer", async () => {
    // The order closed while the handler worked; the merchant needs to know
    // their delivery landed nowhere.
    const { problems } = await workerOver(
      {
        poll_worker: polling(batch(envelopes.order)),
        answer_order: () => ({
          status: 409,
          body: {
            ok: false,
            error: { code: "order_already_closed", message: "it expired", retryable: false },
          },
        }),
      },
      { order: () => ({ delivered: { access_url: "https://example.com/a" } }) },
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");
    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.ANSWER_REFUSED);
    expect(problems[0]?.message).toMatch(/order_already_closed/);
  });

  it("leaves an order unanswered when nobody subscribed, and says so", async () => {
    // Orders still arrive at a process with only a price handler, and
    // swallowing them would look like a gateway fault.
    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: { poll_worker: polling(batch(envelopes.order)) },
    });

    const problems: WorkerProblem[] = [];
    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: (problem) => problems.push(problem) },
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");
    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.NO_HANDLER);
    expect(gateway.callsTo("answer_order")).toHaveLength(0);
  });
});

describe("a price question off the same stream", () => {
  it("goes to the price handler and is answered against its own identifier", async () => {
    const seen: QuoteRequest[] = [];

    await workerOver(
      {
        poll_worker: polling(batch(envelopes.quote)),
        answer_quote: () => ({ body: { used: true } }),
      },
      {
        quote: (asked) => {
          seen.push(asked);
          return { available: true, price: { amount: "6.50", currency: "USD" }, as_of: AT };
        },
      },
    );

    await waitUntil(() => (gateway?.callsTo("answer_quote").length ?? 0) === 1, "the price answer");

    // The handler is also given its two answers, so the fields are compared.
    const { merchant_item_id, price_id, purpose, expires_at } = seen[0] as QuoteRequest;

    expect({ merchant_item_id, price_id, purpose, expires_at }).toStrictEqual(question);
    expect(gateway?.callsTo("answer_quote")[0]?.params).toStrictEqual({ price_id: "price-1" });
    expect(gateway?.callsTo("answer_quote")[0]?.body).toStrictEqual({
      available: true,
      price: { amount: "6.50", currency: "USD" },
      as_of: AT,
    });
  });

  it("holds the price handler's answer to the contract before sending it", async () => {
    // Held to the contract before sending, as the order's answer is: an amount
    // written as a number would otherwise come back as the gateway's complaint
    // about a document, burying the merchant's own field.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(batch(envelopes.quote)),
        answer_quote: () => ({ body: { used: true } }),
      },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      {
        quote: () =>
          ({ available: true, price: { amount: 6.5, currency: "USD" }, as_of: AT }) as never,
        problem: (problem) => problems.push(problem),
      },
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.HANDLER_ANSWER_REFUSED);
    expect(problems[0]?.subject).toBe("price-1");
    expect(problems[0]?.message).toMatch(/price\.amount/);
    expect(gateway.callsTo("answer_quote")).toHaveLength(0);
  });

  it("holds the price handler's answer to the price rule before sending it", async () => {
    // A price of zero, without cents or in a currency the gateway cannot
    // charge is caught here and named as the merchant's own field.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(batch(envelopes.quote)),
        answer_quote: () => ({ body: { used: true } }),
      },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      {
        quote: () => ({ available: true, price: { amount: "0.00", currency: "USD" }, as_of: AT }),
        problem: (problem) => problems.push(problem),
      },
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.HANDLER_ANSWER_REFUSED);
    expect(problems[0]?.subject).toBe("price-1");
    expect(problems[0]?.message).toMatch(/price\.amount/);
    expect(gateway.callsTo("answer_quote")).toHaveLength(0);
  });

  it("tells the merchant when their price arrived too late to be used", async () => {
    // The acknowledgement is the only notice that stock set aside can be
    // released.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(batch(envelopes.quote)),
        answer_quote: () => ({ body: { used: false } }),
      },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      {
        quote: () => ({ available: false, as_of: AT }),
        problem: (problem) => problems.push(problem),
      },
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");
    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.QUOTE_ANSWER_UNUSED);
    expect(problems[0]?.subject).toBe("price-1");
  });
});

describe("an event off the same stream", () => {
  it("arrives with the identity of the message it travelled in", async () => {
    // An event is answered against nothing, so the envelope's identifier and
    // delivery time are the only way to name the message.
    const delivered: { id: string; sent_at: string }[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: { poll_worker: polling(batch(envelopes.event)) },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      {
        event: (_arrived, identity) => {
          delivered.push(identity);
        },
        problem: () => {},
      },
    );

    await waitUntil(() => delivered.length === 1, "the event to arrive");
    expect(delivered[0]).toStrictEqual({
      id: envelopes.event.id,
      sent_at: envelopes.event.sent_at,
    });
  });

  it("is handed over and acknowledged with nothing", async () => {
    // An event notifies and asks for no work, so nothing is sent back.
    const { events } = await workerOver(
      { poll_worker: polling(batch(envelopes.event)) },
      {
        order: () => ({ delivered: { access_url: "https://example.com/a" } }),
      },
    );

    await waitUntil(() => events.length === 1, "the event to arrive");

    expect(events[0]).toStrictEqual(event);
    expect(gateway?.calls.filter((call) => call.route !== "poll_worker")).toStrictEqual([]);
  });
});

describe("a gateway speaking another dialect", () => {
  it("stops the worker and names both versions", async () => {
    // Failing at startup rather than on somebody's first order.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: () => ({ body: { contract_version: "99", envelopes: [] } }),
      },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: (problem) => problems.push(problem) },
    );

    await waitUntil(() => problems.length > 0, "the mismatch to be reported");

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.CONTRACT_VERSION_MISMATCH);
    expect(problems[0]?.fatal).toBe(true);
    expect(problems[0]?.message).toContain("99");
    expect(problems[0]?.message).toContain(contractVersion);

    const pollsWhenItStopped = gateway.callsTo("poll_worker").length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.callsTo("poll_worker")).toHaveLength(pollsWhenItStopped);
  });

  it("passes on the version it saw in an answer it could not read, and keeps going", async () => {
    // The version a body this SDK refuses names is worth telling the merchant,
    // but that body was held to no schema: acted on, a proxy's error page
    // could stop a worker for good. So it is a remark in a retryable problem.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: () => ({
          status: 503,
          text: JSON.stringify({ contract_version: "99", error: "no worker here" }),
        }),
      },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: (problem) => problems.push(problem) },
      recordingClock(),
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.POLL_FAILED);
    expect(problems[0]?.fatal).toBe(false);
    expect(problems[0]?.message).toContain("99");
    expect(problems[0]?.message).toContain("may mean");

    // And it went on asking.
    await waitUntil(() => (gateway?.callsTo("poll_worker").length ?? 0) >= 3, "further polls");
  });

  it.each([
    ["a proxy's own page", { status: 502, text: "<html>bad gateway</html>" }],
    ["an error envelope somebody added", { text: JSON.stringify({ error: "no such worker" }) }],
    ["a version that is not a word", { text: JSON.stringify({ contract_version: 99 }) }],
  ])("still blames the transport for %s", async (_what, answer) => {
    // A proxy's page, an error envelope or a field of the wrong type is not
    // another version, and must not stop a worker for good.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({ apiKey: API_KEY, routes: { poll_worker: () => answer } });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: (problem) => problems.push(problem) },
      recordingClock(),
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.POLL_FAILED);
    expect(problems[0]?.fatal).toBe(false);
  });

  it("keeps the merchant's handlers and reporter when a loop is started again", async () => {
    // The loop ended and the client did not: everything registered stays, so
    // starting again is one line.
    const problems: WorkerProblem[] = [];
    const orders: string[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: (_call, index) =>
          index === 0
            ? { body: { contract_version: "99", envelopes: [] } }
            : batch(envelopes.order),
        answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      },
    });

    const agentify = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

    agentify.on("order", (arrived) => {
      orders.push(arrived.id);
      return arrived.delivered({ access_url: "https://a.example" });
    });
    agentify.on("problem", (problem) => problems.push(problem));

    await agentify.start();

    await waitUntil(() => problems.length === 1, "the mismatch that ends the first loop");
    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.CONTRACT_VERSION_MISMATCH);

    // The loop ended on its own, so nothing has to be stopped first.
    running = agentify;
    await agentify.start();

    await waitUntil(() => orders.length > 0, "the order handler to keep receiving");
    expect(orders[0]).toBe(order.id);

    // Stopping still stops what is running: no further order reaches the
    // handler. Polls are not counted, since the gateway may record one a
    // moment after the caller has gone.
    await agentify.stop();

    const deliveredWhenItStopped = orders.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(orders).toHaveLength(deliveredWhenItStopped);
  });

  it("meets a gateway of another dialect again rather than pretending to run", async () => {
    // Starting again after a mismatch must not report "started" over nothing;
    // the reason has not gone away, and the merchant hears it again.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: { poll_worker: () => ({ body: { contract_version: "99", envelopes: [] } }) },
    });

    const agentify = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

    agentify.on("order", (arrived) => arrived.accepted());
    agentify.on("problem", (problem) => problems.push(problem));
    running = agentify;

    await agentify.start();
    await waitUntil(() => problems.length === 1, "the first mismatch");

    await agentify.start();
    await waitUntil(() => problems.length === 2, "a loop that ran again and reported");

    expect(problems[1]?.kind).toBe(WORKER_PROBLEM_KINDS.CONTRACT_VERSION_MISMATCH);
    expect(gateway.callsTo("poll_worker").length).toBeGreaterThanOrEqual(2);
  });
});

describe("a poll that goes quiet", () => {
  it("is given up on, rather than waited for as long as the runtime allows", async () => {
    // A connection dropped silently in the middle leaves this side waiting for
    // ever; without its own deadline the worker would wait out the runtime's
    // default of minutes.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({ apiKey: API_KEY, routes: { poll_worker: polling() } });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: (problem) => problems.push(problem) },
      recordingClock(),
      30,
    );

    await waitUntil(() => problems.length > 0, "the poll to be given up on");

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.POLL_FAILED);
    expect(problems[0]?.fatal).toBe(false);

    // And it goes on asking.
    await waitUntil(() => (gateway?.callsTo("poll_worker").length ?? 0) >= 2, "a further poll");
  });

  it("is given up on soon enough that a watcher can still tell an outage from a recovery", () => {
    // A gateway that accepts a poll and never answers fails it only when the
    // deadline runs out, so two reports are the deadline plus the longest rest
    // apart. `DOUBT_MS` in packages/slice/src/subscription.ts waits ninety
    // seconds before calling the quiet a recovery; this side's two terms must
    // stay under it.
    expect(POLL_DEADLINE_MS + RETRY_CEILING_MS).toBeLessThan(90_000);
  });
});

describe("what the worker asks of a poll", () => {
  it("names the wait window the decision gave it", async () => {
    // The worker asks for a window of about twenty-five seconds, so a gateway
    // can see what it expects.
    gateway = await startFakeGateway({ apiKey: API_KEY, routes: { poll_worker: polling() } });

    running = startWorker({ apiKey: API_KEY, baseUrl: gateway.url }, { problem: () => {} });

    await waitUntil(() => (gateway?.callsTo("poll_worker").length ?? 0) === 1, "the first poll");

    // The literal, not the sender's constant, which could not fail.
    expect(gateway.callsTo("poll_worker")[0]?.body).toStrictEqual({ wait_seconds: 25 });
    expect(POLL_WAIT_SECONDS).toBe(25);
  });
});

describe("a gateway that is not answering", () => {
  it("waits longer after each failure in a row and starts over after a success", async () => {
    // The promise: an outage does not become a flood of requests, and the
    // worker comes back on its own.
    const clock = recordingClock();
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: (_call, index) =>
          index < 3
            ? { status: 502, text: "bad gateway" }
            : index === 3
              ? batch()
              : { status: 502, text: "bad gateway" },
      },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: (problem) => problems.push(problem) },
      clock,
    );

    await waitUntil(() => clock.waits.length >= 5, "five waits");
    await running.stop();

    expect(problems.every((problem) => problem.kind === WORKER_PROBLEM_KINDS.POLL_FAILED)).toBe(
      true,
    );
    expect(clock.waits.slice(0, 3)).toStrictEqual([
      FIRST_RETRY_MS,
      FIRST_RETRY_MS * 2,
      FIRST_RETRY_MS * 4,
    ]);
    // The fourth poll succeeded empty, so what follows is the quiet floor; the
    // failure after it starts from the top.
    expect(clock.waits[3]).toBe(QUIET_POLL_FLOOR_MS);
    expect(clock.waits[4]).toBe(FIRST_RETRY_MS);
  });

  it("does not go on to the next poll until the wait is over", async () => {
    // The clock above records which delays are asked for; this checks that
    // the loop waits for them, with a wait the test itself resolves.
    let waitIsOver: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      waitIsOver = resolve;
    });

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: { poll_worker: () => ({ status: 502, text: "bad gateway" }) },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: () => {} },
      {
        now: () => 0,
        random: () => 1,
        sleep: () => waiting,
      },
    );

    await waitUntil(() => (gateway?.callsTo("poll_worker").length ?? 0) === 1, "the first poll");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.callsTo("poll_worker")).toHaveLength(1);

    waitIsOver?.();
    await waitUntil(() => (gateway?.callsTo("poll_worker").length ?? 0) >= 2, "the second poll");
  });
});

describe("the clock the worker runs on by default", () => {
  it("waits the whole time it was given, and gives up the moment it is stopped", async () => {
    // The real clock, tested once, since the others replace it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    try {
      const controller = new AbortController();
      let over = false;

      void systemClock.sleep(FIRST_RETRY_MS, controller.signal).then(() => {
        over = true;
      });

      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS - 1);
      expect(over).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(over).toBe(true);

      // Stopping cuts a wait short, so a parked worker shuts down at once.
      let cutShort = false;
      const second = new AbortController();

      void systemClock.sleep(FIRST_RETRY_MS, second.signal).then(() => {
        cutShort = true;
      });

      second.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(cutShort).toBe(true);

      // A wait asked for after the stop does not happen at all.
      let afterwards = false;

      void systemClock.sleep(FIRST_RETRY_MS, second.signal).then(() => {
        afterwards = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(afterwards).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a quiet stream", () => {
  it("asks again at once when the gateway held the request, and paces itself when it did not", async () => {
    // A batch that took the window is followed by another poll at once, which
    // keeps a waiting agent's price question free of lag. The floor applies
    // only to a gateway that answers empty instantly and so holds nothing.
    const clock = recordingClock();

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: (_call, index) => {
          clock.elapse(index === 0 ? 0 : QUIET_POLL_FLOOR_MS * 25);
          return batch();
        },
      },
    });

    running = startWorker({ apiKey: API_KEY, baseUrl: gateway.url }, { problem: () => {} }, clock);

    await waitUntil(() => clock.waits.length >= 1, "the floor after the first empty batch");
    await waitUntil(() => (gateway?.callsTo("poll_worker").length ?? 0) >= 3, "three polls");
    await running.stop();

    // One wait, after the instant batch; pacing every quiet poll would cost
    // three.
    expect(clock.waits).toStrictEqual([QUIET_POLL_FLOOR_MS]);
  });
});

describe("an answer that could not be delivered", () => {
  it("promises the redelivery only where nothing was handed over", async () => {
    // An answer refused a connection certainly left the order unanswered, so
    // it comes back, and the merchant is told so.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: { poll_worker: polling(batch(envelopes.order)) },
    });

    const closing = gateway;

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      {
        order: async () => {
          // The gateway goes away between the order and the answer, so the
          // answer is refused a connection.
          await closing.close();
          return { delivered: { access_url: "https://a.example" } };
        },
        problem: (problem) => problems.push(problem),
      },
    );

    await waitUntil(
      () => problems.some((problem) => problem.kind === WORKER_PROBLEM_KINDS.ANSWER_FAILED),
      "the failed answer to be reported",
    );

    await running.stop();
    running = undefined;
    gateway = undefined;
  });
});

describe("a delivery carrying the field this contract removes", () => {
  it("tells the merchant it will not reach the agent", async () => {
    // A `__proto__` field leaves the handler and does not arrive; without
    // this nobody is told.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(batch(envelopes.order)),
        answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      {
        order: () => ({
          delivered: JSON.parse('{"access_url": "https://a.example", "__proto__": "gone"}'),
        }),
        problem: (problem) => problems.push(problem),
      },
    );

    await waitUntil(() => (gateway?.callsTo("answer_order").length ?? 0) === 1, "the answer");

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.DELIVERY_FIELD_DROPPED);
    expect(problems[0]?.subject).toBe(order.id);
    expect(gateway.callsTo("answer_order")[0]?.body).toStrictEqual({
      delivered: { access_url: "https://a.example" },
    });
  });
});

describe("a merchant who passed no reporter at all", () => {
  it("is given the exception as well as the sentence", async () => {
    // The console is the only channel a merchant without a reporter has. The
    // stack goes beside the sentence, since it is what someone debugging their
    // handler needs.
    const written: unknown[][] = [];
    const console_error = console.error;

    console.error = (...given: unknown[]): void => {
      written.push(given);
    };

    try {
      gateway = await startFakeGateway({
        apiKey: API_KEY,
        routes: { poll_worker: polling(batch(envelopes.order)) },
      });

      const agentify = createClient({ apiKey: API_KEY, baseUrl: gateway.url });
      const thrown = new Error("the supplier timed out");

      agentify.on("order", () => {
        throw thrown;
      });
      running = agentify;
      await agentify.start();

      await waitUntil(() => written.length > 0, "the problem to reach the console");

      expect(String(written[0]?.[0])).toMatch(/handler_failed/);
      expect(written[0]?.[1]).toBe(thrown);
    } finally {
      console.error = console_error;
    }
  });
});

describe("a reporter that itself fails", () => {
  it("does not take the worker, or the merchant's process, down with it", async () => {
    // The reporter is the merchant's code; an exception from it would escape as
    // an unhandled rejection and, under Node's default, end their process. This
    // listens for exactly that.
    const escaped: unknown[] = [];
    const catchIt = (reason: unknown): void => {
      escaped.push(reason);
    };

    process.on("unhandledRejection", catchIt);

    try {
      gateway = await startFakeGateway({
        apiKey: API_KEY,
        routes: { poll_worker: polling(batch(envelopes.order), batch(envelopes.order)) },
      });

      let reported = 0;
      const worker = startWorker(
        { apiKey: API_KEY, baseUrl: gateway.url },
        {
          problem: () => {
            reported += 1;
            throw new Error("the merchant's logger was not configured");
          },
        },
      );

      await waitUntil(() => reported >= 2, "the worker to keep going past a failing reporter");
      await expect(worker.stop()).resolves.toBeUndefined();

      // Rejections are reported at the end of a turn, so give the loop one.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(escaped).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", catchIt);
    }
  });
});

describe("the loop failing in a way nothing in it anticipated", () => {
  it("hands the merchant the defect instead of ending in silence", async () => {
    // Every failure the loop expects has its own kind; reaching this one means
    // a defect in the SDK, and the worker is down until the process restarts.
    // A stopped loop reports nothing more, so this report is the merchant's
    // only notice. The defect is injected through the clock, failing after one
    // healthy poll.
    const problems: WorkerProblem[] = [];
    const broken = new Error("the clock stopped");
    let asked = 0;

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: { poll_worker: polling(batch()) },
    });

    const worker = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: (problem) => problems.push(problem) },
      {
        ...recordingClock(),
        now: () => {
          asked += 1;
          if (asked > 1) throw broken;
          return 0;
        },
      },
    );

    await waitUntil(() => problems.length > 0, "the worker to report its own failure");

    const failed = problems.find((problem) => problem.kind === WORKER_PROBLEM_KINDS.WORKER_FAILED);

    // Fatal: nothing restarts the loop from here.
    expect(failed?.fatal).toBe(true);
    // The exception travels with it, for the merchant to send in.
    expect(failed?.cause).toBe(broken);
    expect(failed?.message).toMatch(/defect in the Agentify SDK/);
    expect(failed?.message).toContain(String(broken));
    // Not a failed poll, which a merchant waits out.
    expect(problems.map((problem) => problem.kind)).not.toContain(WORKER_PROBLEM_KINDS.POLL_FAILED);
    // One poll went out and came back first.
    expect(gateway.callsTo("poll_worker")).toHaveLength(1);
    // `running()` agrees, so a supervisor sees the worker is down.
    await waitUntil(() => !worker.running(), "the loop to be over");
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});

describe("stopping", () => {
  it("says so when an answer the handler produced did not get through", async () => {
    // The handler has run and goods may have been issued, so a merchant
    // reconciling a shutdown is told this answer went nowhere.
    const problems: WorkerProblem[] = [];
    let answering: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      answering = resolve;
    });

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(batch(envelopes.order)),
        answer_order: () => {
          answering?.();
          return new Promise<never>(() => {});
        },
      },
    });

    const worker = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      {
        order: () => ({ delivered: { access_url: "https://a.example" } }),
        problem: (problem) => problems.push(problem),
      },
    );

    await held;
    await worker.stop();

    expect(problems.map((problem) => problem.kind)).toContain(WORKER_PROBLEM_KINDS.ANSWER_FAILED);
    expect(problems[0]?.subject).toBe(order.id);
    // Abandoned when the worker stopped, so whether the gateway has it is not
    // known, and no redelivery is promised.
    expect(problems[0]?.message).toMatch(/not known here/);
    expect(problems[0]?.message).not.toMatch(/will be delivered again/);
    // An abort carries no code to say whether the request was fully written,
    // so "it was sent" would be a fact nobody has.
    expect(problems[0]?.message).not.toMatch(/it was sent/);
  });

  it("says how much of a batch it left unread", async () => {
    // Orders and price questions come back on their own, an event does not;
    // the merchant is told what went unread.
    const problems: WorkerProblem[] = [];
    let handling: (() => void) | undefined;
    const inTheHandler = new Promise<void>((resolve) => {
      handling = resolve;
    });

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(
          batch(
            ...Array.from({ length: 4 }, (_, i) => ({
              ...envelopes.order,
              id: `env-${i}`,
              payload: { ...order, id: `order-${i}` },
            })),
            envelopes.quote,
            envelopes.event,
          ),
        ),
        // Held open, so the loop is certainly inside the first envelope when
        // the worker stops, whatever the machine's speed.
        answer_order: () => {
          handling?.();
          return new Promise<never>(() => {});
        },
      },
    });

    const worker = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      {
        order: () => ({ delivered: { access_url: "https://a.example" } }),
        problem: (problem) => problems.push(problem),
      },
    );

    await inTheHandler;
    await worker.stop();

    const abandoned = problems.find(
      (problem) => problem.kind === WORKER_PROBLEM_KINDS.BATCH_ABANDONED,
    );

    expect(abandoned?.message).toMatch(/2 of this batch's 6/);
    expect(abandoned?.message).toMatch(/quote_request, order_event/);
  });

  it("abandons the parked poll and asks for nothing more", async () => {
    gateway = await startFakeGateway({ apiKey: API_KEY, routes: { poll_worker: polling() } });

    const worker = startWorker({ apiKey: API_KEY, baseUrl: gateway.url }, { problem: () => {} });

    await waitUntil(() => (gateway?.callsTo("poll_worker").length ?? 0) === 1, "the first poll");
    await worker.stop();
    await worker.stop();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.callsTo("poll_worker")).toHaveLength(1);
  });
});

describe("shutting down a subscription the merchant built", () => {
  it("sends the last problems to the reporter that subscription was given", async () => {
    // Everything the loop reports while stopping goes to the reporter
    // registered at that moment; torn down early, that is the console, and
    // the merchant hears nothing.
    const problems: WorkerProblem[] = [];
    let answering: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      answering = resolve;
    });

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(
          batch(
            ...Array.from({ length: 4 }, (_, i) => ({
              ...envelopes.order,
              id: `env-${i}`,
              payload: { ...order, id: `order-${i}` },
            })),
            envelopes.quote,
          ),
        ),
        answer_order: () => {
          answering?.();
          return new Promise<never>(() => {});
        },
      },
    });

    const agentify = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

    agentify.on("order", (arrived) => arrived.delivered({ access_url: "https://a.example" }));
    agentify.on("problem", (problem) => problems.push(problem));
    await agentify.start();

    await held;
    await agentify.stop();

    const kinds = problems.map((problem) => problem.kind);

    expect(kinds).toContain(WORKER_PROBLEM_KINDS.ANSWER_FAILED);
    expect(kinds).toContain(WORKER_PROBLEM_KINDS.BATCH_ABANDONED);
  });

  it("waits for the loop however many callers ask it to stop", async () => {
    // Two callers of stop() are ordinary; a second that returned at once would
    // let the process exit with a delivery in flight.
    let inTheHandler: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      inTheHandler = resolve;
    });
    let handlerFinished = false;
    let releaseHandler: (() => void) | undefined;
    const handlerMayFinish = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(batch(envelopes.order)),
        answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      },
    });

    const agentify = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

    agentify.on("order", async (arrived) => {
      inTheHandler?.();
      await handlerMayFinish;
      // A turn between release and done, so a stop() that returned without
      // waiting is caught rather than saved by microtask order.
      await new Promise((resolve) => setTimeout(resolve, 0));
      handlerFinished = true;
      return arrived.delivered({ access_url: "https://a.example" });
    });
    await agentify.start();

    await reached;

    const first = agentify.stop();
    const second = agentify.stop();

    releaseHandler?.();

    // Awaited on its own: awaiting both would pass even if this one returned
    // at once.
    await second;
    expect(handlerFinished).toBe(true);
    await first;
  });

  it("refuses to start again while a stop is still in flight", async () => {
    // Two loops would open two long polls, and an envelope handed to the one
    // going away is lost. Registering during a stop is allowed: handlers
    // belong to the client and are in place for the next loop.
    let inTheHandler: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      inTheHandler = resolve;
    });
    let releaseHandler: (() => void) | undefined;
    const handlerMayFinish = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(batch(envelopes.order)),
        answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      },
    });

    const agentify = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

    agentify.on("order", async (arrived) => {
      inTheHandler?.();
      await handlerMayFinish;
      return arrived.delivered({ access_url: "https://a.example" });
    });
    await agentify.start();

    await reached;

    const stopping = agentify.stop();

    await expect(agentify.start()).rejects.toThrow(/being stopped/);
    agentify.on("quote", (asked) => asked.unavailable(AT));

    releaseHandler?.();
    await stopping;

    // Once stopped, starting works again, with the handler registered during
    // the stop as well as the earlier one.
    running = agentify;
    await agentify.start();
  });
});

describe("one loop for one process", () => {
  it("carries the orders and the prices of one process on one subscription", async () => {
    // One subscription for all three kinds: what is counted is how many polls
    // were in flight together.
    const script = polling(batch(envelopes.order, envelopes.quote));
    let inFlight = 0;
    let mostAtOnce = 0;

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: async (call, index) => {
          inFlight += 1;
          mostAtOnce = Math.max(mostAtOnce, inFlight);
          try {
            return await script(call, index);
          } finally {
            inFlight -= 1;
          }
        },
        answer_order: () => ({ body: { ok: true, result: "delivered" } }),
        answer_quote: () => ({ body: { used: true } }),
      },
    });

    const agentify = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

    agentify.on("order", (arrived) => arrived.delivered({ access_url: "https://a.example" }));
    agentify.on("quote", (asked) => asked.unavailable(AT));
    running = agentify;
    await agentify.start();

    await waitUntil(
      () =>
        (gateway?.callsTo("answer_order").length ?? 0) === 1 &&
        (gateway?.callsTo("answer_quote").length ?? 0) === 1,
      "both answers",
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mostAtOnce).toBe(1);
  });
});

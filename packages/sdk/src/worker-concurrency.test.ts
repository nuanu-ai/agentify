import type { Order, WorkerEnvelope } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentifyClient, createClient } from "./client.js";
import { type FakeGateway, startFakeGateway } from "./testing/fake-gateway.js";
import { waitUntil } from "./testing/waiting.js";
import { batch, polling } from "./testing/worker-stream.js";
import type { WorkerProblem } from "./worker.js";

const at = "2026-10-21T10:00:00Z";
const order = (id: string): WorkerEnvelope => ({
  kind: "order",
  id: `env-${id}`,
  sent_at: at,
  payload: {
    id,
    merchant_item_id: "access-monthly",
    params: {},
    test: true,
    price: { amount: "5.00", currency: "USD", at, as_of: at },
  },
});
const quote: WorkerEnvelope = {
  kind: "quote_request",
  id: "quote",
  sent_at: at,
  payload: {
    price_id: "price",
    merchant_item_id: "access-monthly",
    purpose: "purchase",
    expires_at: "2026-10-21T10:05:00Z",
  },
};
const event = (id: string): WorkerEnvelope => ({
  kind: "order_event",
  id: `event-${id}`,
  sent_at: at,
  payload: {
    type: "order.unfulfilled",
    order_id: id,
    at,
    price: { amount: "5.00", currency: "USD" },
    reason: "deadline_passed",
  },
});

let client: AgentifyClient | undefined;
let gateway: FakeGateway | undefined;
const releases: (() => void)[] = [];
const held = () => new Promise<void>((resolve) => releases.push(resolve));
afterEach(async () => {
  releases.splice(0).forEach((release) => {
    release();
  });
  await client?.stop();
  await gateway?.close();
  client = undefined;
  gateway = undefined;
});

const subscribe = async (stream: WorkerEnvelope[], handle: (given: Order) => Promise<void>) => {
  const answers: string[] = [];
  const problems: WorkerProblem[] = [];
  gateway = await startFakeGateway({
    apiKey: "test-key",
    routes: {
      poll_worker: polling(...stream.map((envelope) => batch(envelope))),
      answer_order: (call) => {
        answers.push(call.params.order_id ?? "");
        return { body: { ok: true, result: "delivered" } };
      },
      answer_quote: () => {
        answers.push("price");
        return { body: { used: true } };
      },
    },
  });
  client = createClient({ apiKey: "test-key", baseUrl: gateway.url });
  client.on("order", async (given) => {
    await handle(given);
    return given.delivered({ access_url: `https://service.example/${given.id}` });
  });
  client.on("quote", (given) => given.unavailable(at));
  client.on("problem", (problem) => problems.push(problem));
  return { answers, problems };
};

describe("bounded concurrent merchant work", () => {
  it("answers a later order and price while an earlier order is still running", async () => {
    const gate = held();
    const { answers } = await subscribe([order("slow"), order("fast"), quote], async (given) => {
      if (given.id === "slow") await gate;
    });
    await client?.start();
    await waitUntil(
      () => answers.includes("fast") && answers.includes("price"),
      "independent answers",
    );
    expect(answers).not.toContain("slow");
  });

  it("stops drawing at four unfinished envelopes and resumes when capacity returns", async () => {
    const gates = Array.from({ length: 5 }, held);
    const started: string[] = [];
    const { answers } = await subscribe(
      Array.from({ length: 5 }, (_, i) => order(String(i))),
      async (given) => {
        started.push(given.id);
        await gates[Number(given.id)];
      },
    );
    await client?.start();
    await waitUntil(() => started.length >= 4, "four handlers");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(started).toEqual(["0", "1", "2", "3"]);
    expect(gateway?.callsTo("poll_worker")).toHaveLength(4);
    releases[0]?.();
    await waitUntil(() => started.includes("4"), "the next handler after capacity returned");
    expect(answers).toContain("0");
  });

  it("coalesces an in-flight repeat but allows a retry after that attempt finishes", async () => {
    const gate = held();
    const retry = Promise.withResolvers<void>();
    const started: string[] = [];
    let firstFinished = false;
    let priced = false;
    const original = order("same");
    gateway = await startFakeGateway({
      apiKey: "test-key",
      routes: {
        poll_worker: async (_call, index) => {
          if (index === 0) return batch(original);
          if (index === 1) return batch({ ...original, id: "redelivery" });
          if (index === 2) return batch(event("same"));
          if (index === 3) return batch(quote);
          if (index === 4) {
            await retry.promise;
            return batch({ ...original, id: "later-retry" });
          }
          return new Promise<never>(() => {});
        },
        answer_order: () => ({ body: { ok: true, result: "delivered" } }),
        answer_quote: () => {
          priced = true;
          return { body: { used: true } };
        },
      },
    });
    client = createClient({ apiKey: "test-key", baseUrl: gateway.url });
    client.on("order", async (given) => {
      started.push(given.id);
      await gate;
      return given.delivered({ access_url: "https://service.example/access" });
    });
    client.on("quote", (given) => given.unavailable(at));
    client.on("event", () => {
      firstFinished = true;
    });
    await client.start();
    await waitUntil(() => priced, "the price behind the in-flight repeat");
    expect(started).toEqual(["same"]);
    releases[0]?.();
    await waitUntil(() => firstFinished, "the original order's event after its answer");
    expect(started).toEqual(["same"]);
    retry.resolve();
    await waitUntil(() => started.length === 2, "the later retry in the same subscription");
    expect(started).toEqual(["same", "same"]);
  });

  it("keeps an order's event behind its handler while another order progresses", async () => {
    const gate = held();
    const seen: string[] = [];
    const { answers } = await subscribe(
      [order("slow"), event("slow"), order("fast")],
      async (given) => {
        if (given.id === "slow") await gate;
        seen.push(given.id);
      },
    );
    client?.on("event", (given) => {
      seen.push(`event:${given.order_id}`);
    });
    await client?.start();
    await waitUntil(() => answers.includes("fast"), "the independent order");
    expect(seen).toEqual(["fast"]);
    releases[0]?.();
    await waitUntil(() => seen.includes("event:slow"), "the ordered event");
    expect(seen).toEqual(["fast", "slow", "event:slow"]);
  });

  it("waits for every started handler when stopped and draws no more work", async () => {
    const gates = Array.from({ length: 4 }, held);
    const started: string[] = [];
    const finished: string[] = [];
    await subscribe(
      Array.from({ length: 5 }, (_, i) => order(String(i))),
      async (given) => {
        started.push(given.id);
        await gates[Number(given.id)];
        finished.push(given.id);
      },
    );
    await client?.start();
    await waitUntil(() => started.length >= 4, "four handlers");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(started).toHaveLength(4);
    let stopped = false;
    const stopping = client?.stop().then(() => {
      stopped = true;
    });
    releases.slice(0, 3).forEach((release) => {
      release();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    releases[3]?.();
    await stopping;
    expect(finished.sort()).toEqual(["0", "1", "2", "3"]);
    expect(gateway?.callsTo("poll_worker")).toHaveLength(4);
  });

  it("reports a throwing handler and still answers independent work", async () => {
    const { answers, problems } = await subscribe(
      [order("broken"), order("fast"), quote],
      async (given) => {
        if (given.id === "broken") throw new Error("merchant failed");
      },
    );
    await client?.start();
    await waitUntil(
      () => answers.includes("fast") && answers.includes("price"),
      "answers after a failure",
    );
    expect(answers).not.toContain("broken");
    expect(
      problems.some((problem) => problem.kind === "handler_failed" && problem.subject === "broken"),
    ).toBe(true);
  });
});

it("does not restart after a fatal mismatch until all started handlers finish", async () => {
  const gate = held();
  const problems: WorkerProblem[] = [];
  let started = false;
  let finished = false;
  gateway = await startFakeGateway({
    apiKey: "test-key",
    routes: {
      poll_worker: polling(batch(order("slow")), {
        body: { contract_version: "999", envelopes: [] },
      }),
    },
  });
  client = createClient({ apiKey: "test-key", baseUrl: gateway.url });
  client.on("order", async (given) => {
    started = true;
    await gate;
    finished = true;
    return given.delivered({ access_url: "https://service.example/access" });
  });
  client.on("problem", (problem) => problems.push(problem));
  await client.start();
  await waitUntil(() => problems.some((problem) => problem.fatal), "the fatal mismatch");
  expect(started).toBe(true);
  expect(finished).toBe(false);
  await expect(client.start()).rejects.toThrow();
  releases[0]?.();
  await client.stop();
  expect(finished).toBe(true);
  expect(gateway.callsTo("poll_worker")).toHaveLength(2);
});

it("keeps later events ordered after their order's original handler has finished", async () => {
  const orderGate = held();
  const eventGate = held();
  const later = Promise.withResolvers<void>();
  const seen: string[] = [];
  gateway = await startFakeGateway({
    apiKey: "test-key",
    routes: {
      poll_worker: async (_call, index) => {
        if (index === 0) return batch(order("same"));
        if (index === 1) return batch(event("same"));
        if (index === 2) {
          await later.promise;
          return batch({ ...event("same"), id: "later-event" });
        }
        return new Promise<never>(() => {});
      },
      answer_order: () => ({ body: { ok: true, result: "delivered" } }),
    },
  });
  client = createClient({ apiKey: "test-key", baseUrl: gateway.url });
  client.on("order", async (given) => {
    await orderGate;
    return given.delivered({ access_url: "https://service.example/access" });
  });
  client.on("event", async (_given, delivery) => {
    seen.push(delivery.id);
    if (delivery.id !== "later-event") await eventGate;
  });
  await client.start();
  await waitUntil(
    () => (gateway?.callsTo("poll_worker").length ?? 0) === 3,
    "the first event to be queued",
  );
  releases[0]?.();
  await waitUntil(() => seen.length === 1, "the first event to start");
  later.resolve();
  await waitUntil(
    () => (gateway?.callsTo("poll_worker").length ?? 0) === 4,
    "the later event to be queued",
  );
  expect(seen).toEqual(["event-same"]);
  releases[1]?.();
  await waitUntil(() => seen.length === 2, "the later event after the first");
  expect(seen).toEqual(["event-same", "later-event"]);
});

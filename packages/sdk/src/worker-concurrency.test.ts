import type { Order, WorkerEnvelope } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createClient, type AgentifyClient } from "./client.js";
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
  releases.splice(0).forEach((release) => release());
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
    await waitUntil(() => started.length >= 1, "the first handler");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(started).toEqual(["0", "1", "2", "3"]);
    expect(gateway?.callsTo("poll_worker")).toHaveLength(4);
    releases[0]?.();
    await waitUntil(() => started.includes("4"), "the next handler after capacity returned");
    expect(answers).toContain("0");
  });

  it("coalesces an in-flight repeat but allows a retry after that attempt finishes", async () => {
    const gate = held();
    const started: string[] = [];
    const original = order("same");
    const { answers } = await subscribe(
      [original, { ...original, id: "redelivery" }, quote],
      async (given) => {
        started.push(given.id);
        await gate;
      },
    );
    await client?.start();
    await waitUntil(() => answers.includes("price"), "the price behind the repeat");
    expect(started).toEqual(["same"]);
    releases[0]?.();
    await waitUntil(() => answers.includes("same"), "the original answer");
    await client?.stop();
    // Restart has no process-local claim left; durable idempotency still belongs to the merchant.
    await gateway?.close();
    gateway = undefined;
    const next = await subscribe([order("same")], async (given) => {
      started.push(given.id);
    });
    await client?.start();
    await waitUntil(() => next.answers.includes("same"), "the retry answer");
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
    await waitUntil(() => started.length >= 1, "the handlers");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(started).toHaveLength(4);
    let stopped = false;
    const stopping = client?.stop().then(() => {
      stopped = true;
    });
    releases.slice(0, 3).forEach((release) => release());
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

/**
 * The one line a worker says when it starts: which gateway it is working
 * against, and whether the money there is real.
 *
 * The keys are built with `keyPrefixFor` from `@agentify/core`, where the rule
 * lives. The SDK cannot import that private module and carries its own copy of
 * the two prefixes, so building the keys from core's answer turns a drift
 * between the copies into a failed test. The import is a devDependency and
 * reaches nothing published.
 */

import { keyPrefixFor } from "@agentify/core";
import type { Order, WorkerEnvelope } from "@nuanu-ai/agentify-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "./client.js";
import { type FakeGateway, startFakeGateway } from "./testing/fake-gateway.js";
import { waitUntil } from "./testing/waiting.js";
import { batch, polling } from "./testing/worker-stream.js";

const AT = "2026-08-26T10:20:00Z";

const order: Order = {
  id: "order-1",
  merchant_item_id: "access-monthly",
  params: { email: "buyer@example.com" },
  price: { amount: "5.00", currency: "USD", at: AT, as_of: AT },
  test: false,
};

const arriving = {
  kind: "order",
  id: "env-1",
  sent_at: AT,
  payload: order,
} satisfies WorkerEnvelope;

/**
 * Everything that reached the console during one test, both streams together,
 * so a line sent anywhere is seen. Every test registers a problem reporter, so
 * a connect notice sent there instead would leave this empty and fail.
 */
const written: string[] = [];
const realInfo = console.info;
const realError = console.error;

let gateway: FakeGateway | undefined;
let running: { stop(): Promise<void> } | undefined;

const capture = (...given: unknown[]): void => {
  written.push(given.map(String).join(" "));
};

beforeEach(() => {
  written.length = 0;
  console.info = capture;
  console.error = capture;
});

afterEach(async () => {
  try {
    await running?.stop();
    await gateway?.close();
  } finally {
    running = undefined;
    gateway = undefined;
    console.info = realInfo;
    console.error = realError;
  }
});

/**
 * A worker against a gateway that hands it two orders and then holds its poll
 * open, so the loop goes round more than once before anything is counted.
 */
const workerHolding = async (
  apiKey: string,
): Promise<{ url: string; agentify: ReturnType<typeof createClient> }> => {
  gateway = await startFakeGateway({
    apiKey,
    routes: {
      poll_worker: polling(batch(arriving), batch(arriving)),
      answer_order: () => ({ body: { ok: true, result: "delivered" } }),
    },
  });

  const agentify = createClient({ apiKey, baseUrl: gateway.url });

  // A reporter of the merchant's own, so what is left on the console is the
  // connect line alone.
  agentify.on("problem", () => {});
  agentify.on("order", (arrived) => arrived.delivered({ access_url: "https://a.example" }));

  running = agentify;
  await agentify.start();

  const url = gateway.url;

  await waitUntil(
    () => (gateway?.callsTo("answer_order").length ?? 0) === 2,
    "two orders answered",
  );

  return { url, agentify };
};

describe("the line a worker says at connect", () => {
  it("names the gateway and says the money there is not real, for a test key", async () => {
    // The promise: someone tailing a worker's log can tell which deployment it
    // joined without looking for the key.
    const { url } = await workerHolding(`${keyPrefixFor("test")}9f2c4a`);

    expect(written).toHaveLength(1);
    expect(written[0]).toContain(url);
    expect(written[0]).toContain("test key");
    expect(written[0]).toMatch(/money there is not real/);
  });

  it("names the gateway and says the money there is real, for a live key", async () => {
    const { url } = await workerHolding(`${keyPrefixFor("live")}9f2c4a`);

    expect(written).toHaveLength(1);
    expect(written[0]).toContain(url);
    expect(written[0]).toContain("live key");
    expect(written[0]).toMatch(/money there is real/);
    expect(written[0]).not.toMatch(/not real/);
  });

  it("says nothing at all about the world for a key that names none", async () => {
    // The negative control: a key with neither prefix gets no line, since
    // there is nothing to guess from and a wrong claim about whose money is at
    // stake is worse than none.
    await workerHolding("csk_9f2c4ad1e0b7");

    expect(written).toStrictEqual([]);

    await running?.stop();
    await gateway?.close();
    running = undefined;
    gateway = undefined;

    await workerHolding("merchant-key-from-somewhere-else");

    expect(written).toStrictEqual([]);
  });

  it("does not say it a second time when a client is stopped and started again", async () => {
    // Stopping and starting the same client repeats nothing new, and a line
    // repeated every cycle is one people learn to scroll past.
    const { agentify } = await workerHolding(`${keyPrefixFor("test")}9f2c4a`);

    expect(written).toHaveLength(1);

    await agentify.stop();
    await agentify.start();
    await waitUntil(
      () => (gateway?.callsTo("poll_worker").length ?? 0) >= 3,
      "the loop to poll again",
    );

    expect(written).toHaveLength(1);
  });
});

/**
 * What Health says of the running gateway: the revision only where a build
 * wrote one, and payment recovery by its host alone, since the rest of an RPC
 * address may be the provider's key.
 */

import { describe, expect, it } from "vitest";
import { gatewayHealthFacts } from "./health-facts.js";

const payment = (rpcUrl?: string) => ({
  facilitatorUrl: "https://x402.org/facilitator",
  network: "eip155:8453",
  payTo: null,
  cdpApiKeyId: null,
  cdpApiKeySecret: null,
  ...(rpcUrl === undefined ? {} : { rpcUrl }),
});

describe("the gateway's own health facts", () => {
  it("name recovery's host and nothing else of its address", () => {
    const facts = gatewayHealthFacts(
      {
        surfaceMode: "live",
        payment: payment("https://base-mainnet.example.io/v2/secret-key-123"),
      },
      {},
    );

    expect(facts.recovery).toStrictEqual({ configured: true, host: "base-mainnet.example.io" });
    expect(JSON.stringify(facts)).not.toContain("secret-key-123");
  });

  it("say recovery is off where no chain endpoint is configured", () => {
    expect(
      gatewayHealthFacts({ surfaceMode: "live", payment: payment() }, {}).recovery,
    ).toStrictEqual({ configured: false });
  });

  it("carry the revision a build wrote, and none for an image built without one", () => {
    const at = (revision?: string) =>
      gatewayHealthFacts(
        { surfaceMode: "test", payment: payment() },
        revision === undefined ? {} : { AGENTIFY_SOURCE_REVISION: revision },
      ).revision;

    expect(at("ea229fdd")).toBe("ea229fdd");
    expect(at("unknown")).toBeNull();
    expect(at("")).toBeNull();
    expect(at()).toBeNull();
  });

  it("give the window the purchase guard waits, ten and a half minutes", () => {
    expect(gatewayHealthFacts({ surfaceMode: "live", payment: payment() }, {}).workerWindowMs).toBe(
      630_000,
    );
  });
});

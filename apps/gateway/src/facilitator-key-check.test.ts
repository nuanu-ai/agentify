/**
 * The facilitator-key check the operator runs from Health: what it asked
 * Coinbase and what came back, in words written here. Coinbase is a stand-in
 * fetch; nothing here reaches the network.
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PaymentConfig } from "./config.js";
import { checkFacilitatorKey } from "./facilitator-key-check.js";

const AT = Date.parse("2026-10-24T09:00:00.000Z");
const COINBASE = "https://api.cdp.coinbase.com/platform/v2/x402";
const SAID_BY_COINBASE = "correlation-said-by-coinbase 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

/** A key of the shape Coinbase issues, made here and opening nothing. */
const aSecret = (): string => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const published = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return Buffer.concat([seed, published]).toString("base64");
};

const payment = (overrides: Partial<PaymentConfig> = {}): PaymentConfig => ({
  facilitatorUrl: COINBASE,
  network: "eip155:84532",
  payTo: null,
  cdpApiKeyId: "an-api-key",
  cdpApiKeySecret: aSecret(),
  ...overrides,
});

/** A Coinbase that answers every request with `status`, and counts what reached it. */
const coinbaseAnswering = (status: number) => {
  const asked: string[] = [];
  const post = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ said: SAID_BY_COINBASE }), { status });
  }) as typeof fetch;
  return { asked, post };
};

describe("checking the facilitator key now", () => {
  it("says the key was taken when Coinbase judges the empty payment instead", async () => {
    const coinbase = coinbaseAnswering(400);

    const checked = await checkFacilitatorKey(payment(), coinbase.post, () => AT);

    expect(checked.outcome).toBe("taken");
    expect(checked.checkedAt).toBe(AT);
    expect(coinbase.asked).toStrictEqual([`${COINBASE}/verify`]);
  });

  it("says the key was refused, naming both variables, when Coinbase refuses it", async () => {
    const checked = await checkFacilitatorKey(payment(), coinbaseAnswering(401).post, () => AT);

    expect(checked.outcome).toBe("refused");
    expect(checked.said).toMatch(/CDP_API_KEY_ID/);
    expect(checked.said).toMatch(/CDP_API_KEY_SECRET/);
  });

  it("says nothing is known when Coinbase cannot be reached, which is not a refusal", async () => {
    const unreachable = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const checked = await checkFacilitatorKey(payment(), unreachable, () => AT);

    expect(checked.outcome).toBe("unconfirmed");
    expect(checked.said).toMatch(/unconfirmed/);
  });

  it("refuses a secret that cannot sign without asking Coinbase anything", async () => {
    const coinbase = coinbaseAnswering(400);

    const checked = await checkFacilitatorKey(
      payment({ cdpApiKeySecret: aSecret().slice(0, 20) }),
      coinbase.post,
      () => AT,
    );

    expect(checked.outcome).toBe("refused");
    expect(coinbase.asked).toStrictEqual([]);
  });

  it("asks nobody when the channel's facilitator is not Coinbase's", async () => {
    const coinbase = coinbaseAnswering(400);

    const checked = await checkFacilitatorKey(
      payment({
        facilitatorUrl: "https://x402.org/facilitator",
        cdpApiKeyId: null,
        cdpApiKeySecret: null,
      }),
      coinbase.post,
      () => AT,
    );

    expect(checked.outcome).toBe("not_coinbase");
    expect(coinbase.asked).toStrictEqual([]);
  });

  it("speaks of the gateway that is running, never in the start's words that it cannot start", async () => {
    const unreachable = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const checks = [
      await checkFacilitatorKey(payment(), coinbaseAnswering(401).post, () => AT),
      await checkFacilitatorKey(payment(), coinbaseAnswering(503).post, () => AT),
      await checkFacilitatorKey(payment(), unreachable, () => AT),
      await checkFacilitatorKey(
        payment({ cdpApiKeySecret: aSecret().slice(0, 20) }),
        coinbaseAnswering(400).post,
        () => AT,
      ),
    ];

    for (const checked of checks) {
      expect(checked.said).not.toMatch(/cannot start|starts without knowing|started anyway/i);
    }
  });

  it("never hands on what Coinbase said in its own words", async () => {
    for (const status of [400, 401, 403, 503]) {
      const checked = await checkFacilitatorKey(
        payment(),
        coinbaseAnswering(status).post,
        () => AT,
      );
      expect(JSON.stringify(checked)).not.toContain("correlation-said-by-coinbase");
    }
  });
});

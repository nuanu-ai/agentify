/**
 * The reference rate shown beside the merchant's own: Coinbase's public
 * exchange rates for one US dollar, read from Coinbase's recorded answers in
 * `@agentify/recorded`. What matters is that "Coinbase gives no rate for this
 * currency" is never said when all that is known is that Coinbase did not
 * answer.
 */

import { coinbaseRateOf, coinbaseRates, coinbaseUnknownBase } from "@agentify/recorded";
import { describe, expect, it } from "vitest";
import { type ReferenceRequest, referenceRateOf } from "./woo-reference.js";

const READ_AT = coinbaseRates.readAt;

const answering =
  (status: number, body: string): ReferenceRequest =>
  async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });

const asked: string[] = [];
const recorded: ReferenceRequest = async (url, init) => {
  asked.push(url);
  return await answering(coinbaseRates.status, coinbaseRates.body)(url, init);
};

describe("Coinbase's rate for a shop's currency", () => {
  it("is read for one US dollar, with the moment Agentify read it", async () => {
    const read = await referenceRateOf("IDR", { request: recorded, now: () => READ_AT });

    expect(read).toEqual({
      ok: true,
      rate: coinbaseRateOf("IDR"),
      source: "Coinbase",
      readAt: READ_AT,
    });
    expect(asked.at(-1)).toBe(coinbaseRates.url);
  });

  it("is read for every currency Coinbase lists, a three-decimal one among them", async () => {
    for (const currency of ["EUR", "JPY", "VND", "KWD"]) {
      const read = await referenceRateOf(currency, { request: recorded, now: () => READ_AT });
      expect(read.ok, currency).toBe(true);
    }
  });

  it("says Coinbase lists no rate only when it answered and lists none", async () => {
    expect(await referenceRateOf("IRT", { request: recorded, now: () => READ_AT })).toEqual({
      ok: false,
      listed: false,
    });
  });

  it("says nothing is known when Coinbase did not answer, refused, or answered something else", async () => {
    const unanswered: ReferenceRequest[] = [
      async () => {
        throw new TypeError("fetch failed");
      },
      answering(503, "upstream unavailable"),
      answering(429, ""),
      answering(200, "<html>Attention required</html>"),
      answering(coinbaseUnknownBase.status, coinbaseUnknownBase.body),
      answering(200, '{"data":{"currency":"EUR","rates":{"IDR":"20238.3"}}}'),
      answering(200, '{"data":{"currency":"USD","rates":{"IDR":"-18035"}}}'),
      answering(200, '{"data":{"currency":"USD","rates":{"IDR":"0"}}}'),
    ];
    for (const request of unanswered) {
      expect(await referenceRateOf("IDR", { request, now: () => READ_AT })).toEqual({
        ok: false,
        listed: null,
      });
    }
  });

  it("stops waiting for a Coinbase that never answers", async () => {
    const never: ReferenceRequest = () => new Promise(() => undefined);
    expect(
      await referenceRateOf("IDR", { request: never, now: () => READ_AT, withinMs: 20 }),
    ).toEqual({ ok: false, listed: null });
  });
});

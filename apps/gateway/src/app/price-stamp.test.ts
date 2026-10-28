import { describe, expect, it } from "vitest";
import {
  decodePriceStamp,
  orderIdForPrice,
  type PriceOffer,
  priceFactsDigest,
  stampPrice,
  verifyPriceStamp,
} from "./price-stamp.js";

const current = "the-current-channel-signing-key-at-least32bytes";
const previous = "the-previous-channel-signing-key-at-least32bytes";
const offer: PriceOffer = {
  version: 1,
  priceId: "prc_27",
  itemId: "item_23",
  merchantId: "mch_27",
  integration: "woocommerce",
  cardDigest: "a".repeat(64),
  paramsDigest: "b".repeat(64),
  placeDigest: "c".repeat(64),
  amount: "5.40",
  currency: "USDC",
  source: "merchant_answer",
  asOf: 1_800_000_000_000,
  quotedAt: 1_800_000_000_000,
  expiresAt: 1_800_000_030_000,
  network: "eip155:84532",
  payTo: "0x0000000000000000000000000000000000000001",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  assetName: "USDC",
  assetVersion: "2",
  maxTimeoutSeconds: 50,
};

describe("the authenticated price codec", () => {
  it.each(Object.keys(offer))("refuses to sign without %s", (field) => {
    const facts = { ...offer } as Record<string, unknown>;
    delete facts[field];
    expect(() => stampPrice(facts as unknown as PriceOffer, current)).toThrow(field);
  });

  it("accepts an outstanding offer only while its signing key is current or previous", () => {
    const token = stampPrice(offer, previous);
    expect(verifyPriceStamp(token, { current, previous })).toStrictEqual({
      offer,
      key: "previous",
    });
    expect(verifyPriceStamp(token, { current: previous })).toStrictEqual({ offer, key: "current" });
    expect(verifyPriceStamp(token, { current })).toBeNull();
    const rekeyed = verifyPriceStamp(stampPrice(offer, current), { current });
    if (rekeyed === null) throw new Error("the current key did not authenticate its offer");
    expect(orderIdForPrice(rekeyed.offer)).toBe(orderIdForPrice(offer));
  });

  it("rejects malformed or oversized transport before using any offered facts", () => {
    const token = stampPrice(offer, current);
    const [version, payload, signature] = token.split(".");
    for (const invalid of [
      "x".repeat(4097),
      `${version}.${payload}=.${signature}`,
      `${version}._w.${signature}`,
      `v2.${payload}.${signature}`,
      `${version}.${Buffer.from("{}").toString("base64url")}.${signature}`,
    ]) {
      expect(decodePriceStamp(invalid)).toBeNull();
      expect(verifyPriceStamp(invalid, { current })).toBeNull();
    }
  });

  it("digests canonical private JSON under a channel key and a purpose", () => {
    const place = { city: "Bali", country: "ID" };
    expect(priceFactsDigest(place, current, "place")).toBe(
      priceFactsDigest({ country: "ID", city: "Bali" }, current, "place"),
    );
    expect(priceFactsDigest(place, current, "place")).not.toBe(
      priceFactsDigest(place, previous, "place"),
    );
    expect(priceFactsDigest(place, current, "place")).not.toBe(
      priceFactsDigest(place, current, "params"),
    );
    expect(priceFactsDigest([1, 2], current, "params")).not.toBe(
      priceFactsDigest([2, 1], current, "params"),
    );
    expect(priceFactsDigest({ ...place, state: undefined }, current, "place")).toBe(
      priceFactsDigest(place, current, "place"),
    );
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const invalid of [cycle, Number.NaN, new Array(1)]) {
      expect(() => priceFactsDigest(invalid, current, "params")).toThrow();
    }
  });
});

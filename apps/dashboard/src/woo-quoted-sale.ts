/** Public quote facts whose integrity is established by the gateway's price stamp. */
import type { Money } from "@nuanu-ai/agentify-contracts";
import { z } from "zod";
import { dollarsAt, minorOf } from "./woo-money.js";
import type { AppliedRate } from "./woo-shops.js";

export interface QuotedSale {
  readonly fingerprint: string;
  readonly inTheShop: Money;
  readonly paid: Money;
  readonly rate: AppliedRate | null;
}

const text = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x20-\x7e]+$/);
const amount = z
  .string()
  .max(64)
  .regex(/^\d+(?:\.\d{1,2})?$/);
const base = [text, amount, z.string().regex(/^[A-Z]{3}$/), amount] as const;
const ReferenceSchema = z.union([
  z.tuple(base),
  z.tuple([
    ...base,
    z.number().int().positive(),
    z
      .string()
      .max(64)
      .regex(/^\d+(?:\.\d{1,6})?$/),
    z.iso.datetime(),
  ]),
]);

/** Contains only a product digest and money facts; no protected source or destination. */
export const quoteReferenceOf = (sale: QuotedSale): string => {
  const tuple: unknown[] = [
    sale.fingerprint,
    sale.inTheShop.amount,
    sale.inTheShop.currency,
    sale.paid.amount,
  ];
  if (sale.rate !== null)
    tuple.push(sale.rate.version, sale.rate.rate, sale.rate.setAt.toISOString());
  const reference = Buffer.from(JSON.stringify(tuple)).toString("base64url");
  if (reference.length > 512)
    throw new Error("The WooCommerce quote facts exceed the merchant reference limit.");
  return reference;
};

/** Read only on a paid order: the gateway has authenticated these exact opaque bytes. */
export const saleFromQuoteReference = (reference: string | undefined): QuotedSale | null => {
  if (reference === undefined || reference.length > 512 || !/^[A-Za-z0-9_-]+$/.test(reference))
    return null;
  let document: unknown;
  try {
    document = JSON.parse(Buffer.from(reference, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = ReferenceSchema.safeParse(document);
  if (!parsed.success) return null;
  const [fingerprint, shopAmount, currency, dollars, version, rate, setAt] = parsed.data;
  const shop = minorOf(shopAmount);
  if (shop === null || ![0, 2].includes(shop.decimals)) return null;
  if (currency === "USD") {
    if (parsed.data.length !== 4 || shopAmount !== dollars) return null;
    return {
      fingerprint,
      inTheShop: { amount: shopAmount, currency },
      paid: { amount: dollars, currency: "USD" },
      rate: null,
    };
  }
  if (
    version === undefined ||
    rate === undefined ||
    setAt === undefined ||
    dollarsAt(shopAmount, rate) !== dollars
  )
    return null;
  return {
    fingerprint,
    inTheShop: { amount: shopAmount, currency },
    paid: { amount: dollars, currency: "USD" },
    rate: { version, rate, currency, setAt: new Date(setAt) },
  };
};

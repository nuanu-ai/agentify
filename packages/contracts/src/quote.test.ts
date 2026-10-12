import { describe, expect, it } from "vitest";
import { QuotePurposeSchema, QuoteRequestSchema, QuoteResponseSchema } from "./quote.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

const request = {
  merchant_item_id: "access-monthly",
  params: { email: "buyer@example.com" },
  price_id: "prc_31a8c0",
  purpose: "purchase",
  expires_at: "2026-08-26T10:20:00Z",
};

describe("the purpose of a price question", () => {
  // The promise: the merchant can tell a buyer at the till from a scheduled
  // refresh, and spend an expensive stock lookup on the first only.
  it("separates a purchase from a scheduled poll", () => {
    expect(QuotePurposeSchema.parse("purchase")).toBe("purchase");
    expect(QuotePurposeSchema.parse("poll")).toBe("poll");
  });

  it("refuses a purpose the merchant cannot act on", () => {
    for (const purpose of ["", "refresh", "PURCHASE", "check"]) {
      expect(QuotePurposeSchema.safeParse(purpose).success, JSON.stringify(purpose)).toBe(false);
    }
  });
});

describe("the price question", () => {
  it("accepts the question both transports carry", () => {
    expect(QuoteRequestSchema.parse(request)).toStrictEqual(request);
  });

  it("accepts a question about a card that takes no purchase parameters", () => {
    const { params, ...withoutParams } = request;
    expect(params).toBeDefined();
    expect(QuoteRequestSchema.safeParse(withoutParams).success).toBe(true);
  });

  for (const field of ["merchant_item_id", "price_id", "purpose", "expires_at"]) {
    it(`refuses a question without ${field} and names it`, () => {
      expectMissingFieldRejected(QuoteRequestSchema, request, field);
    });
  }

  it("refuses a deadline that is not a moment in time", () => {
    // `expires_at` is how long a merchant holds stock, and no separate expiry
    // message is sent; a value that cannot be compared with a clock would hold
    // it for ever or release it at once.
    for (const expires of ["soon", "2026-08-26", 1_787_000_000, ""]) {
      expect(
        QuoteRequestSchema.safeParse({ ...request, expires_at: expires }).success,
        JSON.stringify(expires),
      ).toBe(false);
    }
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(QuoteRequestSchema, { ...request, quantity: 2 })).toContain("quantity");
  });
});

describe("the price answer", () => {
  const available = {
    available: true,
    price: { amount: "5.00", currency: "USD" },
    as_of: "2026-08-26T10:15:00Z",
  };
  const unavailable = { available: false, as_of: "2026-08-26T10:15:00Z" };

  it("accepts a price with the moment it was true", () => {
    expect(QuoteResponseSchema.parse(available)).toStrictEqual(available);
  });

  it("accepts a refusal without a price", () => {
    expect(QuoteResponseSchema.parse(unavailable)).toStrictEqual(unavailable);
  });

  it("refuses an answer that says available and names no price", () => {
    // The promise: an available answer carries the price the sale goes
    // through at; without one the sale would quietly fall back to the card.
    expect(errorOf(QuoteResponseSchema, { available: true, as_of: available.as_of })).toContain(
      "price",
    );
  });

  it("refuses a price attached to an answer that says the product is gone", () => {
    // A price beside `available: false` is two answers at once.
    expect(
      errorOf(QuoteResponseSchema, { ...unavailable, price: { amount: "5.00", currency: "USD" } }),
    ).toContain("price");
  });

  it("refuses an answer that does not say whether the product is there", () => {
    expectMissingFieldRejected(QuoteResponseSchema, available, "available");
    expectMissingFieldRejected(QuoteResponseSchema, unavailable, "available");
  });

  it("refuses an answer with no as_of on either branch", () => {
    // Without `as_of`, whoever reconciles the charge cannot tell how old the
    // number behind it was.
    expectMissingFieldRejected(QuoteResponseSchema, available, "as_of");
    expectMissingFieldRejected(QuoteResponseSchema, unavailable, "as_of");
  });

  it("refuses availability written as anything but true or false", () => {
    for (const value of ["true", 1, 0, null, "yes"]) {
      expect(
        QuoteResponseSchema.safeParse({ ...unavailable, available: value }).success,
        JSON.stringify(value),
      ).toBe(false);
    }
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(QuoteResponseSchema, { ...available, stock: 3 })).toContain("stock");
  });
});

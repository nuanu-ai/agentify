import { describe, expect, it } from "vitest";
import { PayoutWalletSchema, SellerNameRequestSchema, SellerNameSchema } from "./merchant.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

describe("the name buyers read beside a merchant's products", () => {
  // The promise: a merchant can find out what they are listed under and change
  // it, but cannot go back to none once they have one.
  const named = { seller_name: "Someone's shop", seller_site: "https://someones.example" };
  const unnamed = { seller_name: null, seller_site: null };

  it("carries the name a merchant chose", () => {
    expect(SellerNameSchema.parse(named)).toStrictEqual(named);
  });

  it("says a merchant has no name rather than leaving the field out", () => {
    // Null means nobody has chosen a name, where every merchant starts; an
    // absent field would leave a screen guessing.
    expect(SellerNameSchema.parse(unnamed)).toStrictEqual(unnamed);
    expect(SellerNameSchema.safeParse({}).success).toBe(false);
  });

  it("refuses a document without seller_name and names it", () => {
    expectMissingFieldRejected(SellerNameSchema, named, "seller_name");
  });

  it("refuses a document without seller_site and names it", () => {
    // The same for the site: null is "none given", and absent is refused.
    expectMissingFieldRejected(SellerNameSchema, named, "seller_site");
  });

  it("holds the site to the rule an agent's link is held to", () => {
    expect(
      SellerNameSchema.safeParse({ ...named, seller_site: "https://someones.example/about" })
        .success,
    ).toBe(false);
  });

  it("holds the name to the rule of the catalogue that will carry it", () => {
    // The discovery catalog's rule: refused here, the merchant is told; passed
    // here, they would trade under a mangled name and nothing would say so.
    expect(SellerNameSchema.safeParse({ ...unnamed, seller_name: "" }).success).toBe(false);
    expect(SellerNameSchema.safeParse({ ...unnamed, seller_name: "x".repeat(33) }).success).toBe(
      false,
    );
    expect(SellerNameSchema.safeParse({ ...unnamed, seller_name: "Магазин" }).success).toBe(false);
    expect(SellerNameSchema.safeParse({ ...unnamed, seller_name: " padded " }).success).toBe(false);
    expect(SellerNameSchema.safeParse({ ...unnamed, seller_name: "x".repeat(32) }).success).toBe(
      true,
    );
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(SellerNameSchema, { ...named, merchant_id: "mch_4d21bb" })).toContain(
      "merchant_id",
    );
  });
});

describe("what a merchant sends to change that name", () => {
  const asked = { seller_name: "Someone's shop" };

  it("takes the name, held to the same rule the answer is", () => {
    expect(SellerNameRequestSchema.parse(asked)).toStrictEqual(asked);
    expect(SellerNameRequestSchema.safeParse({ seller_name: "x".repeat(33) }).success).toBe(false);
    expect(SellerNameRequestSchema.safeParse({ seller_name: "Магазин" }).success).toBe(false);
    expect(SellerNameRequestSchema.safeParse({ seller_name: " padded " }).success).toBe(false);
    expect(SellerNameRequestSchema.safeParse({ seller_name: "" }).success).toBe(false);
  });

  it("refuses null, because a name cannot be taken away", () => {
    // Having no name is a state a merchant starts in and cannot return to:
    // their cards would stay on sale under a payment request naming no seller.
    // A merchant who wants to stop selling pauses instead.
    expect(SellerNameRequestSchema.safeParse({ seller_name: null }).success).toBe(false);
  });

  it("says what to do instead, rather than that a string was expected", () => {
    // "expected string, received null" gives the shape, not the reason; the
    // sentence names the act that stops a merchant being listed.
    const complaint = errorOf(SellerNameRequestSchema, { seller_name: null });

    expect(complaint).toContain("pause");
    expect(complaint).not.toContain("expected string");
  });

  it("takes the site alone, the name alone, or both", () => {
    // One call carries the name, the site or both; either may come alone.
    const site = { seller_site: "https://someones.example" };

    expect(SellerNameRequestSchema.parse(site)).toStrictEqual(site);
    expect(SellerNameRequestSchema.parse({ ...asked, ...site })).toStrictEqual({
      ...asked,
      ...site,
    });
    expect(SellerNameRequestSchema.parse(asked)).toStrictEqual(asked);
  });

  it("refuses a request that changes nothing, and says what it takes", () => {
    const complaint = errorOf(SellerNameRequestSchema, {});

    expect(complaint).toContain("seller_name");
    expect(complaint).toContain("seller_site");
    // A client that dropped the field has a bug, not a wish to remove the
    // name, so it is not told about pausing.
    expect(complaint).not.toContain("pause");
  });

  it("refuses null for the site, because a site cannot be taken away either, only changed", () => {
    expect(errorOf(SellerNameRequestSchema, { seller_site: null })).toContain("changed");
  });

  it("holds the site to the rule an agent's link is held to", () => {
    expect(
      SellerNameRequestSchema.safeParse({ seller_site: "http://someones.example" }).success,
    ).toBe(false);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(SellerNameRequestSchema, { ...asked, merchant_id: "mch_4d21bb" })).toContain(
      "merchant_id",
    );
  });
});

describe("the wallet a merchant's sales are paid into", () => {
  // The promise: what a merchant reads back as their payout address is what a
  // buyer's agent will be told to pay.
  const paid = { payout_wallet: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", pending: null };
  const unpaid = { payout_wallet: null, pending: null };
  /** A change asked for on the live deployment, announced and not yet in effect. */
  const waiting = {
    payout_wallet: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    pending: {
      payout_wallet: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      takes_effect_at: "2026-09-26T12:00:00.000Z",
    },
  };

  it("carries the wallet a merchant chose", () => {
    expect(PayoutWalletSchema.parse(paid)).toStrictEqual(paid);
  });

  it("carries a change that is waiting, beside the wallet that is paid now", () => {
    // A merchant reading the old address back during the wait learns the
    // change is waiting, not lost, and what replaces it when.
    expect(PayoutWalletSchema.parse(waiting)).toStrictEqual(waiting);
  });

  it("says nothing is waiting rather than leaving the pending field out", () => {
    // Null means nothing is waiting, as on the test channel and in a sandbox;
    // an absent field could hide a change that is.
    expect(PayoutWalletSchema.parse(unpaid)).toStrictEqual(unpaid);
    expectMissingFieldRejected(PayoutWalletSchema, paid, "pending");
  });

  it("refuses a waiting change that does not say what replaces the wallet, or when", () => {
    // An address without a moment, or a moment without an address, is not a
    // pending change.
    for (const field of ["payout_wallet", "takes_effect_at"] as const) {
      const pending = Object.fromEntries(
        Object.entries(waiting.pending).filter(([name]) => name !== field),
      );
      const refused = PayoutWalletSchema.safeParse({ ...waiting, pending });
      expect(refused.success, `a pending change without ${field} was accepted`).toBe(false);
      expect(
        refused.error?.issues.some((issue) => issue.path.join(".") === `pending.${field}`),
      ).toBe(true);
    }
  });

  it("holds the waiting address to the rule an address is written by", () => {
    // The address to be paid after the wait is a destination for money too.
    expect(
      PayoutWalletSchema.safeParse({
        ...waiting,
        pending: {
          ...waiting.pending,
          payout_wallet: "0xfb6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
        },
      }).success,
    ).toBe(false);
    expect(
      PayoutWalletSchema.safeParse({
        ...waiting,
        pending: { ...waiting.pending, takes_effect_at: "in two days" },
      }).success,
    ).toBe(false);
  });

  it("says a merchant has none rather than leaving the field out", () => {
    // Null means nobody has said where the money goes; an absent field could
    // tell a merchant they are set up to be paid when they are not.
    expect(PayoutWalletSchema.parse(unpaid)).toStrictEqual(unpaid);
    expect(PayoutWalletSchema.safeParse({}).success).toBe(false);
  });

  it("refuses a document without payout_wallet and names it", () => {
    expectMissingFieldRejected(PayoutWalletSchema, paid, "payout_wallet");
  });

  it("holds the wallet to the rule an address is written by", () => {
    expect(PayoutWalletSchema.safeParse({ ...paid, payout_wallet: "" }).success).toBe(false);
    expect(PayoutWalletSchema.safeParse({ ...paid, payout_wallet: "0x1234" }).success).toBe(false);
    // The checksummed spelling is an address; the same with one letter's case
    // wrong is a paste that went through something.
    expect(
      PayoutWalletSchema.safeParse({
        ...paid,
        payout_wallet: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      }).success,
    ).toBe(true);
    expect(
      PayoutWalletSchema.safeParse({
        ...paid,
        payout_wallet: "0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      }).success,
    ).toBe(false);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(PayoutWalletSchema, { ...paid, private_key: "0xdead" })).toContain(
      "private_key",
    );
  });
});

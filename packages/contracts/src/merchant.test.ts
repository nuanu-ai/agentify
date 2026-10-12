import { describe, expect, it } from "vitest";
import {
  DisabledKeySchema,
  IssuedKeySchema,
  IssueKeyRequestSchema,
  MerchantKeyListSchema,
  MerchantKeySchema,
  PayoutWalletSchema,
  SellerNameRequestSchema,
  SellerNameSchema,
} from "./merchant.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

const working = {
  id: "mk_4d21bb",
  label: "the shop's own worker",
  created_at: "2026-08-26T09:00:00Z",
  last_used_at: "2026-08-30T14:05:00Z",
  disabled_at: null,
};

const revoked = { ...working, id: "mk_9f2c4a", disabled_at: "2026-08-27T10:20:00Z" };

const secret = "csk_9tGqk3xLm2QvR8bN4pZs7YwF1cJd6HeA";

describe("one of a merchant's keys", () => {
  // The promise: a merchant can see the keys they hold, tell one from another,
  // and tell which of them still work.

  it("accepts a key that still opens the door", () => {
    expect(MerchantKeySchema.parse(working)).toStrictEqual(working);
  });

  it("accepts a revoked key and says when it stopped", () => {
    // Revoked keys stay in the list, so "when did this key stop" has an
    // answer.
    expect(MerchantKeySchema.parse(revoked)).toStrictEqual(revoked);
  });

  for (const field of ["id", "label", "created_at", "disabled_at", "last_used_at"]) {
    it(`refuses a key without ${field} and names it`, () => {
      expectMissingFieldRejected(MerchantKeySchema, working, field);
    });
  }

  it("accepts a key with no call recorded against it", () => {
    // A key nothing has called and a key older than the record carry the same
    // null; the document does not claim to tell them apart.
    const quiet = { ...working, last_used_at: null };

    expect(MerchantKeySchema.parse(quiet)).toStrictEqual(quiet);
  });

  it("says when a key was last used rather than leaving the field out", () => {
    // Absent, the field could be read as used at some unstated time or never,
    // and a screen would be inventing the answer.
    const { last_used_at, ...withoutIt } = working;

    expect(last_used_at).not.toBeUndefined();
    expect(MerchantKeySchema.safeParse(withoutIt).success).toBe(false);
  });

  it("refuses a last use that names no moment in time", () => {
    expect(MerchantKeySchema.safeParse({ ...working, last_used_at: "2026-08-30" }).success).toBe(
      false,
    );
  });

  it("says a key works rather than leaving the field out", () => {
    // Null means not revoked; an absent field would leave a screen guessing,
    // and guessing wrong shows a revoked key as live.
    const { disabled_at, ...withoutIt } = working;

    expect(disabled_at).toBeNull();
    expect(MerchantKeySchema.safeParse(withoutIt).success).toBe(false);
    expect(MerchantKeySchema.parse(working).disabled_at).toBeNull();
  });

  it("refuses a label nobody could tell from another", () => {
    // A blank label is an empty row, and a padded one looks identical to
    // another label.
    expect(MerchantKeySchema.safeParse({ ...working, label: "" }).success).toBe(false);
    expect(MerchantKeySchema.safeParse({ ...working, label: "   " }).success).toBe(false);
    expect(MerchantKeySchema.safeParse({ ...working, label: "the worker " }).success).toBe(false);
    expect(errorOf(MerchantKeySchema, { ...working, label: "" })).toContain("label");
  });

  it("takes a label in whatever alphabet its owner writes in", () => {
    // A label never leaves the merchant's own screens, so it is not held to
    // ASCII.
    expect(MerchantKeySchema.safeParse({ ...working, label: "рабочий магазина" }).success).toBe(
      true,
    );
  });

  it("refuses an instant that names no moment in time", () => {
    // A local time with no offset cannot answer "when did this key stop".
    expect(MerchantKeySchema.safeParse({ ...working, created_at: "2026-08-26" }).success).toBe(
      false,
    );
    expect(
      MerchantKeySchema.safeParse({ ...working, disabled_at: "2026-08-27T10:20:00" }).success,
    ).toBe(false);
  });

  it("carries no secret, whatever is put beside it", () => {
    // This document is drawn on every visit; the secret is shown once, by the
    // call that made the key.
    expect(errorOf(MerchantKeySchema, { ...working, secret })).toContain("secret");
    expect(errorOf(MerchantKeySchema, { ...working, digest: "9f2c4a" })).toContain("digest");
  });
});

describe("the keys a merchant holds", () => {
  const list = { keys: [working, revoked], this_call: working.id };

  it("accepts a merchant's keys, working and revoked together", () => {
    expect(MerchantKeyListSchema.parse(list)).toStrictEqual(list);
  });

  it("names the key this very call was made with", () => {
    // A merchant cannot disable the key their own call was made with, so a
    // client needs to know which key that was. Its absence is covered by the
    // loop below; a blank one names no key and would match no row.
    expect(MerchantKeyListSchema.parse(list).this_call).toBe(working.id);
    expect(MerchantKeyListSchema.safeParse({ ...list, this_call: "" }).success).toBe(false);
  });

  for (const field of ["keys", "this_call"]) {
    it(`refuses the list without ${field} and names it`, () => {
      expectMissingFieldRejected(MerchantKeyListSchema, list, field);
    });
  }

  it("is an object rather than a bare array", () => {
    // A bare array has nowhere to put the key the call was made with.
    expect(MerchantKeyListSchema.safeParse([working]).success).toBe(false);
  });

  it("holds every key in the list to the key document", () => {
    expect(
      MerchantKeyListSchema.safeParse({ keys: [{ id: working.id }], this_call: working.id })
        .success,
    ).toBe(false);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(MerchantKeyListSchema, { ...list, merchant_id: "mch_1" })).toContain(
      "merchant_id",
    );
  });
});

describe("asking for a key", () => {
  it("takes the name its owner will know it by", () => {
    expect(IssueKeyRequestSchema.parse({ label: "the shop's own worker" })).toStrictEqual({
      label: "the shop's own worker",
    });
  });

  it("refuses a request with no label and names it", () => {
    expectMissingFieldRejected(IssueKeyRequestSchema, { label: "a worker" }, "label");
  });

  it("refuses a label that names nothing", () => {
    expect(IssueKeyRequestSchema.safeParse({ label: "" }).success).toBe(false);
    expect(IssueKeyRequestSchema.safeParse({ label: " " }).success).toBe(false);
  });

  it("takes a label of a hundred characters and refuses a longer one, in words", () => {
    // On the live deployment the message about a new key or a wallet change
    // names the key by its label; unbounded, a leaked key could issue one too
    // long for that message to be sent.
    expect(IssueKeyRequestSchema.safeParse({ label: "k".repeat(100) }).success).toBe(true);
    expect(errorOf(IssueKeyRequestSchema, { label: "k".repeat(101) })).toContain("100");
  });

  it("refuses a label that is more than one line", () => {
    // A line break in a label would put a paragraph of somebody else's words
    // inside a message Agentify sends.
    for (const label of ["the stock\nworker", "the stock\r\nworker", "the stock\tworker"]) {
      expect(IssueKeyRequestSchema.safeParse({ label }).success, JSON.stringify(label)).toBe(false);
    }
  });

  it("refuses a secret somebody chose for themselves", () => {
    // A key is generated, never taken from a caller: one somebody picks is one
    // somebody reuses.
    expect(errorOf(IssueKeyRequestSchema, { label: "a worker", secret })).toContain("secret");
  });
});

describe("a key just issued", () => {
  const issued = { key: working, secret };

  it("hands the secret over beside the row it belongs to", () => {
    // The only moment the secret is readable, beside the row that says which
    // key it is.
    expect(IssuedKeySchema.parse(issued)).toStrictEqual(issued);
  });

  for (const field of ["key", "secret"]) {
    it(`refuses an issued key without ${field} and names it`, () => {
      expectMissingFieldRejected(IssuedKeySchema, issued, field);
    });
  }

  it("refuses a secret that could not travel as a key", () => {
    // A key travels as a bearer token, which carries no whitespace.
    expect(IssuedKeySchema.safeParse({ key: working, secret: "" }).success).toBe(false);
    expect(IssuedKeySchema.safeParse({ key: working, secret: "csk_ two halves" }).success).toBe(
      false,
    );
    expect(IssuedKeySchema.safeParse({ key: working, secret: " csk_padded" }).success).toBe(false);
  });

  it("holds the row to the key document", () => {
    expect(IssuedKeySchema.safeParse({ key: { id: working.id }, secret }).success).toBe(false);
  });
});

describe("a key that has been disabled", () => {
  const answered = { key: revoked };

  it("answers with the key as it now stands", () => {
    // The instant it stopped is read back, not taken on the call's word.
    expect(DisabledKeySchema.parse(answered)).toStrictEqual(answered);
    expect(DisabledKeySchema.parse(answered).key.disabled_at).toBe(revoked.disabled_at);
  });

  it("refuses an answer with no key in it and names it", () => {
    expectMissingFieldRejected(DisabledKeySchema, answered, "key");
  });

  it("is an object rather than the bare key", () => {
    // An object, so the answer can say more than the key without changing
    // shape.
    expect(DisabledKeySchema.safeParse(revoked).success).toBe(false);
  });
});

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
    // One call carries the name, the site or both, and a client that sends
    // the name alone is answered as before.
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

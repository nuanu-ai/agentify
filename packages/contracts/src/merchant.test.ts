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
  // and tell which of them still opens the door. Everything below is a way that
  // stops being true.

  it("accepts a key that still opens the door", () => {
    expect(MerchantKeySchema.parse(working)).toStrictEqual(working);
  });

  it("accepts a revoked key and says when it stopped", () => {
    // Revoked keys stay in the list. A merchant working out what happened after
    // an incident asks when a key stopped, and a list that dropped it answers
    // nothing at all.
    expect(MerchantKeySchema.parse(revoked)).toStrictEqual(revoked);
  });

  for (const field of ["id", "label", "created_at", "disabled_at", "last_used_at"]) {
    it(`refuses a key without ${field} and names it`, () => {
      expectMissingFieldRejected(MerchantKeySchema, working, field);
    });
  }

  it("accepts a key with no call recorded against it", () => {
    // The blank, which is one field and not two. A key nothing has called and a
    // key older than this record carry the same null here, and this document
    // does not claim to tell them apart — the field is what was written down,
    // and the words that admit the ambiguity live on the screen that draws it.
    const quiet = { ...working, last_used_at: null };

    expect(MerchantKeySchema.parse(quiet)).toStrictEqual(quiet);
  });

  it("says when a key was last used rather than leaving the field out", () => {
    // The same reason `disabled_at` is required: an absent field is a silence a
    // reader cannot tell from an oversight, and this one would be read as the
    // key having been used at some unstated time or never at all, either of
    // which is a screen inventing an answer.
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
    // Null is the fact "this key has not been revoked". An absent field is a
    // silence, and a screen cannot tell a silence from an oversight — it would
    // have to guess, and guessing wrong means showing a revoked key as live.
    const { disabled_at, ...withoutIt } = working;

    expect(disabled_at).toBeNull();
    expect(MerchantKeySchema.safeParse(withoutIt).success).toBe(false);
    expect(MerchantKeySchema.parse(working).disabled_at).toBeNull();
  });

  it("refuses a label nobody could tell from another", () => {
    // A blank label is a row in a list of keys with nothing in it, and a padded
    // one is two labels that look identical wherever they are printed. Both
    // defeat the only thing a label is for.
    expect(MerchantKeySchema.safeParse({ ...working, label: "" }).success).toBe(false);
    expect(MerchantKeySchema.safeParse({ ...working, label: "   " }).success).toBe(false);
    expect(MerchantKeySchema.safeParse({ ...working, label: "the worker " }).success).toBe(false);
    expect(errorOf(MerchantKeySchema, { ...working, label: "" })).toContain("label");
  });

  it("takes a label in whatever alphabet its owner writes in", () => {
    // Unlike the name a discovery catalog lists a seller under, a label never
    // leaves the merchant's own screens, so nothing about it is held to ASCII.
    expect(MerchantKeySchema.safeParse({ ...working, label: "рабочий магазина" }).success).toBe(
      true,
    );
  });

  it("refuses an instant that names no moment in time", () => {
    // A local time with no offset is an hour of the day rather than a moment,
    // and "when did this key stop" cannot be answered by one.
    expect(MerchantKeySchema.safeParse({ ...working, created_at: "2026-08-26" }).success).toBe(
      false,
    );
    expect(
      MerchantKeySchema.safeParse({ ...working, disabled_at: "2026-08-27T10:20:00" }).success,
    ).toBe(false);
  });

  it("carries no secret, whatever is put beside it", () => {
    // This document is what a screen lists, and the secret is shown once by the
    // one call that made it. A key document that could carry a secret is a key
    // document that eventually does, on a page that is drawn again and again.
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
    // The one fact the list cannot be assembled without. A merchant cannot
    // disable the key their own call was made with, so a client that did not
    // know which key that was would offer a button the route refuses. It names
    // the key on the call, which is always one of the rows beside it.
    // Its absence is covered by the loop below, with every other required
    // field; what is here is that it survives a parse and that a blank one is
    // refused, because an empty identifier names no key and a client reading it
    // would match none of the rows beside it.
    expect(MerchantKeyListSchema.parse(list).this_call).toBe(working.id);
    expect(MerchantKeyListSchema.safeParse({ ...list, this_call: "" }).success).toBe(false);
  });

  for (const field of ["keys", "this_call"]) {
    it(`refuses the list without ${field} and names it`, () => {
      expectMissingFieldRejected(MerchantKeyListSchema, list, field);
    });
  }

  it("is an object rather than a bare array", () => {
    // A bare array has nowhere to put the key the call was made with, and could
    // never grow one without breaking every reader that already parses it.
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
    // A label is what a merchant reads to find a key on a list, and it is also
    // what the live site's message about a new key or a wallet change names
    // the key by (ADR-0019). Unbounded, a leaked key could issue one long
    // enough that the message about it cannot be sent at all.
    expect(IssueKeyRequestSchema.safeParse({ label: "k".repeat(100) }).success).toBe(true);
    expect(errorOf(IssueKeyRequestSchema, { label: "k".repeat(101) })).toContain("100");
  });

  it("refuses a label that is more than one line", () => {
    // A line break in a label is a paragraph of somebody else's words inside a
    // message Agentify sends.
    for (const label of ["the stock\nworker", "the stock\r\nworker", "the stock\tworker"]) {
      expect(IssueKeyRequestSchema.safeParse({ label }).success, JSON.stringify(label)).toBe(false);
    }
  });

  it("refuses a secret somebody chose for themselves", () => {
    // A key is generated and never taken from a caller: one somebody picks is
    // one somebody reuses. There is nowhere in this request to put one.
    expect(errorOf(IssueKeyRequestSchema, { label: "a worker", secret })).toContain("secret");
  });
});

describe("a key just issued", () => {
  const issued = { key: working, secret };

  it("hands the secret over beside the row it belongs to", () => {
    // The only moment the secret is readable. Without the row beside it the
    // merchant has a string and no way to say which of their keys it is.
    expect(IssuedKeySchema.parse(issued)).toStrictEqual(issued);
  });

  for (const field of ["key", "secret"]) {
    it(`refuses an issued key without ${field} and names it`, () => {
      expectMissingFieldRejected(IssuedKeySchema, issued, field);
    });
  }

  it("refuses a secret that could not travel as a key", () => {
    // A key is presented as a bearer token, which carries no whitespace: a
    // secret with a space in it is one the door would read as something else,
    // or not read at all, and the merchant would spend an afternoon on it.
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
    // The instant it stopped is the whole answer: a merchant who pressed the
    // button reads it back rather than taking our word that something happened.
    expect(DisabledKeySchema.parse(answered)).toStrictEqual(answered);
    expect(DisabledKeySchema.parse(answered).key.disabled_at).toBe(revoked.disabled_at);
  });

  it("refuses an answer with no key in it and names it", () => {
    expectMissingFieldRejected(DisabledKeySchema, answered, "key");
  });

  it("is an object rather than the bare key", () => {
    // Same reason every list here is: the day this answer has to say anything
    // beside the key — how many keys still work, say — a bare document would
    // have to change shape under every reader.
    expect(DisabledKeySchema.safeParse(revoked).success).toBe(false);
  });
});

describe("the name buyers read beside a merchant's products", () => {
  // The promise: a merchant can find out what they are listed under and change
  // it. What they cannot do is have none once they have one, and the two
  // documents differ in exactly that.
  const named = { seller_name: "Someone's shop", seller_site: "https://someones.example" };
  const unnamed = { seller_name: null, seller_site: null };

  it("carries the name a merchant chose", () => {
    expect(SellerNameSchema.parse(named)).toStrictEqual(named);
  });

  it("says a merchant has no name rather than leaving the field out", () => {
    // Null is the fact "nobody has chosen one", which is every merchant on the
    // day they register. An absent field is a silence, and the screen that
    // reads it cannot tell a silence from a field somebody forgot to send: it
    // would have to guess, and guessing wrong means a settings page that says
    // a merchant is listed under nothing when they are listed under something.
    expect(SellerNameSchema.parse(unnamed)).toStrictEqual(unnamed);
    expect(SellerNameSchema.safeParse({}).success).toBe(false);
  });

  it("refuses a document without seller_name and names it", () => {
    expectMissingFieldRejected(SellerNameSchema, named, "seller_name");
  });

  it("refuses a document without seller_site and names it", () => {
    // The same fact for the site as for the name: null is "none given", which
    // is every merchant until they give one, and an absent field is a silence.
    expectMissingFieldRejected(SellerNameSchema, named, "seller_site");
  });

  it("holds the site to the rule an agent's link is held to", () => {
    expect(
      SellerNameSchema.safeParse({ ...named, seller_site: "https://someones.example/about" })
        .success,
    ).toBe(false);
  });

  it("holds the name to the rule of the catalogue that will carry it", () => {
    // The same rule the catalogue applies before it drops what it cannot
    // render. Refused here, a merchant is told what is wrong with the name they
    // typed; accepted here, they trade under a mangled version of it and
    // nothing anywhere says so.
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
    // The difference between this document and the answer, and the whole of it.
    // Having no name is a state a merchant starts in and cannot go back to:
    // their cards would stay on sale while the payment request an agent reads
    // named no seller. A merchant who wants a different name sets a different
    // name, and one who wants to stop selling pauses selling, which leaves
    // their cards where they can find them again.
    expect(SellerNameRequestSchema.safeParse({ seller_name: null }).success).toBe(false);
  });

  it("says what to do instead, rather than that a string was expected", () => {
    // The reader here is whoever wrote the client, and "expected string,
    // received null" tells them the shape and not the reason. Somebody who
    // wanted a merchant to stop being listed has an act that does that, and
    // this is where they find out which.
    const complaint = errorOf(SellerNameRequestSchema, { seller_name: null });

    expect(complaint).toContain("pause");
    expect(complaint).not.toContain("expected string");
  });

  it("takes the site alone, the name alone, or both", () => {
    // A merchant gives the site where they set the name (ADR-0034), and the
    // one call carries either. A client written before the site existed sends
    // the name alone and is answered as it always was.
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
    // A client that dropped the field has a bug, and a client that sent null
    // has a misunderstanding. Told the same sentence, whoever wrote the first
    // one would go looking for a decision nobody made.
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
  // The promise: a merchant can find out where their money goes and change it,
  // and what they read back is what a buyer's agent will actually be told to
  // pay. Nothing else in this contract carries an address, because nothing else
  // is money leaving somebody's hands.
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
    // The promise a caller reading its old address back depends on: the write
    // did not fail, it is waiting, and here is what replaces the address and
    // when. Without this a merchant whose change is announced and pending reads
    // the old address and takes the change for lost.
    expect(PayoutWalletSchema.parse(waiting)).toStrictEqual(waiting);
  });

  it("says nothing is waiting rather than leaving the pending field out", () => {
    // Null is "no change is waiting", which is every answer on the test channel
    // and in a sandbox. An absent field is a silence a screen cannot tell from a
    // client that dropped it, and a screen that guessed "nothing waiting" over
    // a change that is would hide the one thing its owner has to see.
    expect(PayoutWalletSchema.parse(unpaid)).toStrictEqual(unpaid);
    expectMissingFieldRejected(PayoutWalletSchema, paid, "pending");
  });

  it("refuses a waiting change that does not say what replaces the wallet, or when", () => {
    // Half a pending change is not one: an address with no moment tells a
    // merchant nothing about when their money moves, and a moment with no
    // address tells them it moves without saying where.
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
    // The address that will be paid after the wait is as much money's
    // destination as the one paid now, and a checksum that disagrees is a
    // character that is wrong in either.
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
    // Null is the fact "nobody has said where the money goes", which is every
    // merchant on the day they register. An absent field is a silence, and a
    // settings screen cannot tell a silence from a client that dropped the
    // field — it would have to guess, and guessing wrong means telling a
    // merchant they are set up to be paid when they are not.
    expect(PayoutWalletSchema.parse(unpaid)).toStrictEqual(unpaid);
    expect(PayoutWalletSchema.safeParse({}).success).toBe(false);
  });

  it("refuses a document without payout_wallet and names it", () => {
    expectMissingFieldRejected(PayoutWalletSchema, paid, "payout_wallet");
  });

  it("holds the wallet to the rule an address is written by", () => {
    expect(PayoutWalletSchema.safeParse({ ...paid, payout_wallet: "" }).success).toBe(false);
    expect(PayoutWalletSchema.safeParse({ ...paid, payout_wallet: "0x1234" }).success).toBe(false);
    // The checksummed spelling a wallet shows, and the same address with one
    // letter's case wrong: the first is an address, the second is a paste that
    // went through something.
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

/**
 * Registering a merchant, and the keys they keep afterwards.
 *
 * A merchant is made the way the dashboard makes one, inside the process
 * (ADR-0030), and their first key is issued the way a person signed in to the
 * dashboard issues it. Everything after that goes through `serve`, so the door,
 * the mounting loop and the flows all run, and what is asserted is the answer a
 * merchant's own client would receive. Two of the rules below cannot be shown
 * with one merchant at all — that another merchant's key is answered as a key
 * that does not exist, and that registering twice makes two merchants rather
 * than one — so those tests make two and assert about both, the way
 * `tenancy.test.ts` does and for the same reason.
 *
 * The rule this file exists for most is the smallest one to write and the
 * worst one to get wrong: a call cannot disable the key it was made with.
 * Without it, one call leaves whoever holds that key with something the
 * gateway no longer takes.
 */

import type { Card, MerchantKeyList } from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyDigest } from "../app/merchants.js";
import { type Harness, harness, type Served, serve } from "../testing/harness.js";
import { PAYMENT_REQUIRED_HEADER } from "./x402.js";

const PAY_TO = "0x0000000000000000000000000000000000000001";

/** The session every in-process call here is made as. */
const SIGNED_IN = { kind: "signed_in", email: "owner@example.com" } as const;

const cardFor = (merchantItemId: string, title: string): Card => ({
  merchant_item_id: merchantItemId,
  title,
  description: `${title}, sold by whoever published this card`,
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
});

let open: { harnessed: Harness; served: Served } | null = null;

const started = async (overrides: Record<string, string> = {}) => {
  const harnessed = await harness({ PAY_TO_ADDRESS: PAY_TO, ...overrides });
  const served = await serve(harnessed);
  open = { harnessed, served };
  return open;
};

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
  // One case silences the log to read it. Left standing it would silence every
  // case after it in this file, including the ones a failure is reported by.
  vi.restoreAllMocks();
});

const bearer = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });

interface Registered {
  readonly merchant_id: string;
  /** The first key, issued from the dashboard. */
  readonly secret: string;
  readonly keyId: string;
}

/**
 * A merchant made the way the dashboard makes one, with the first key issued
 * the way a person signed in to it issues one — the road every merchant takes
 * before their code calls anything.
 */
const registered = async (harnessed: Harness): Promise<Registered> => {
  const merchantId = await harnessed.gateway.registerMerchant();
  const first = await harnessed.gateway.issueMerchantKey(merchantId, "the first worker", SIGNED_IN);
  return { merchant_id: merchantId, secret: first.secret, keyId: first.key.id };
};

/**
 * What this merchant's products are sold under, and where their sales are paid,
 * set the way the dashboard sets them.
 *
 * The two travel together here because they are the two things a merchant made
 * by registering has to say before anything of theirs can be published, and
 * nothing in this file is about either — what it is about is keys. A test that
 * set only one would be refused at its first card for a reason it is not
 * testing; `seller-name.test.ts` and `payout-wallet.test.ts` are where each
 * refusal is the subject.
 */
const readyToSell = async (harnessed: Harness, served: Served, made: Registered, name: string) => {
  const named = await served.call("POST", "/v0/seller-name", {
    body: { seller_name: name },
    headers: bearer(made.secret),
  });
  expect(named.status, JSON.stringify(named.body)).toBe(200);

  const paidAt = await harnessed.gateway.setPayoutWallet(
    made.merchant_id,
    "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
    SIGNED_IN,
  );
  expect(typeof paidAt, JSON.stringify(paidAt)).toBe("object");
};

const keysWith = async (served: Served, key: string): Promise<MerchantKeyList> => {
  const answered = await served.call("GET", "/v0/keys", { headers: bearer(key) });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return answered.body as MerchantKeyList;
};

/** Whether a key still opens the door, asked with the smallest call there is. */
const opensTheDoor = async (served: Served, key: string): Promise<boolean> =>
  (await served.call("GET", "/v0/cards", { headers: bearer(key) })).status === 200;

const publish = async (served: Served, key: string, card: Card): Promise<string> => {
  const answered = await served.call("POST", "/v0/catalog/publish", {
    body: card,
    headers: bearer(key),
  });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return (answered.body as { id: string }).id;
};

/** What a crawler asking the price of one product is told about its seller. */
const sellerInTheChallenge = async (
  served: Served,
  itemId: string,
): Promise<{ serviceName?: string; extensions: unknown }> => {
  const answered = await served.call("GET", `/x402/${itemId}/purchase`);
  expect(answered.status).toBe(402);
  const challenge = decodePaymentRequiredHeader(
    answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
  ) as unknown as {
    resource: { serviceName?: string };
    extensions?: Record<string, unknown>;
  };
  return { serviceName: challenge.resource.serviceName, extensions: challenge.extensions?.bazaar };
};

describe("the calls a key made for a dashboard was for", () => {
  it("are calls this gateway does not have, and the wallet is still read here", async () => {
    // The dashboard calls the gateway inside the process the two share and
    // holds no key (ADR-0030): registering, the dashboard's own keys and the
    // wallet write were its calls, and they are gone from the door. Reading
    // the wallet is a call a merchant's own code makes, and it stays.
    const { served, harnessed } = await started();

    for (const [method, path, body] of [
      ["POST", "/v0/merchants", { invitation: "the-code-from-the-invitation" }],
      ["POST", "/v0/keys/dashboard", undefined],
      ["DELETE", "/v0/keys/dashboard", undefined],
      ["POST", "/v0/payout-wallet", { payout_wallet: PAY_TO }],
    ] as const) {
      const answered = await served.call(method, path, {
        ...(body === undefined ? {} : { body }),
        headers: bearer(harnessed.merchant.key),
      });
      expect(answered.status, `${method} ${path}`).toBe(404);
      expect((answered.body as { error: { code: string } }).error.code).toBe("no_such_route");
    }
    const read = await served.call("GET", "/v0/payout-wallet", {
      headers: bearer(harnessed.merchant.key),
    });
    expect(read.status).toBe(200);
  });
});

describe("registering a merchant", () => {
  it("makes a merchant with no key, listed under nothing and paid nowhere", async () => {
    // The press in the dashboard makes the merchant and nothing beside it. A
    // key is issued when the merchant asks for one, so the first keys screen
    // is empty; the name buyers read and the wallet are chosen on the screens
    // after this one, where there is room to say what each is for.
    const { harnessed } = await started();

    const merchantId = await harnessed.gateway.registerMerchant();

    expect(await harnessed.gateway.merchantKeys(merchantId)).toStrictEqual([]);
    expect(await harnessed.gateway.sellerName(merchantId)).toStrictEqual({
      seller_name: null,
      seller_site: null,
    });
    expect(await harnessed.gateway.payoutWallet(merchantId)).toStrictEqual({
      payout_wallet: null,
      pending: null,
    });
  });

  it("lists the new merchant under the name they choose afterwards", async () => {
    // Not decoration. A merchant with no name publishes nothing, and a card
    // published under one carries it into the payment challenge a discovery
    // catalogue reads — which is the whole road from registering to being found.
    const { served, harnessed } = await started();
    const made = await registered(harnessed);
    await readyToSell(harnessed, served, made, "Someone's shop");

    const itemId = await publish(served, made.secret, cardFor("a-room", "A room"));
    const seller = await sellerInTheChallenge(served, itemId);

    expect(seller.serviceName).toBe("Someone's shop");
    expect(seller.extensions).toBeDefined();
  });

  it("gives each registration a merchant of its own", async () => {
    // Two people pressing for a merchant are two merchants, not two people at
    // one. Registering into a shared merchant would hand the second one the
    // first one's cards, orders and receipts on their first screen.
    const { served, harnessed } = await started();

    const first = await registered(harnessed);
    const second = await registered(harnessed);
    await readyToSell(harnessed, served, first, "First shop");
    const itemId = await publish(served, first.secret, cardFor("a-room", "A room"));

    expect(second.merchant_id).not.toBe(first.merchant_id);
    const seenBySecond = await served.call("GET", "/v0/cards", { headers: bearer(second.secret) });
    expect((seenBySecond.body as { cards: unknown[] }).cards).toStrictEqual([]);
    const seenByFirst = await served.call("GET", "/v0/cards", { headers: bearer(first.secret) });
    expect(
      (seenByFirst.body as { cards: { id: string }[] }).cards.map((card) => card.id),
    ).toContain(itemId);
  });
});

describe("the keys a merchant holds", () => {
  it("lists every key of theirs, and the key the call came in on is one of them", async () => {
    // Every key a merchant has is one they asked for, so the list is all of
    // them, whichever key reads it — and the key that made the call is always
    // a row on it, so a screen can draw the disable button beside every row
    // but that one.
    const { served, harnessed } = await started();
    const made = await registered(harnessed);
    const worker = await issued(served, made.secret, "the worker on the small box");

    const asTheFirst = await keysWith(served, made.secret);
    const asTheWorker = await keysWith(served, worker.secret);

    expect(asTheFirst.keys.map((key) => key.id)).toStrictEqual([made.keyId, worker.key.id]);
    expect(asTheWorker.keys.map((key) => key.id)).toStrictEqual([made.keyId, worker.key.id]);
    expect(asTheFirst.keys.map((key) => key.id)).toContain(asTheFirst.this_call);
  });

  it("names a different key when the call is made with a different key", async () => {
    // The half a merchant with one key cannot show, and the whole promise of
    // the field: `this_call` is the key that opened this call rather than the
    // merchant's first, their oldest, or whichever the list happens to start
    // with. Named wrongly, a screen would hide the disable button on a key
    // that works and offer it on the one the gateway answers 409 to, which is
    // the exact failure the field exists to prevent.
    const { served, harnessed } = await started();
    const made = await registered(harnessed);
    const second = await issued(served, made.secret, "a second worker");

    const asTheFirst = await keysWith(served, made.secret);
    const asTheSecond = await keysWith(served, second.secret);

    expect(asTheFirst.this_call).toBe(made.keyId);
    expect(asTheSecond.this_call).toBe(second.key.id);
    // And the same keys are listed both times: which key asked decides what
    // this_call says and not who is on the list. The rows are not identical
    // between the two reads and should not be — this call is itself a call, so
    // the second read has marked the key it was made with as used.
    expect(asTheSecond.keys.map((key) => key.id)).toStrictEqual(
      asTheFirst.keys.map((key) => key.id),
    );
  });

  it("lists no key of another merchant's", async () => {
    // One merchant reading another's keys learns how many workers they run and
    // what each is called. Made with two, because a list scoped to nobody
    // passes every assertion one merchant can make about their own.
    const { served, harnessed } = await started();
    const first = await registered(harnessed);
    const second = await registered(harnessed);

    const forFirst = await keysWith(served, first.secret);
    const forSecond = await keysWith(served, second.secret);

    expect(forFirst.keys.map((key) => key.id)).toStrictEqual([first.keyId]);
    expect(forSecond.keys.map((key) => key.id)).toStrictEqual([second.keyId]);
  });

  it("keeps a revoked key in the list with the instant it stopped", async () => {
    // The question after an incident is when a key stopped working, and a list
    // that dropped the key answers nothing at all.
    const { served, harnessed } = await started();
    const made = await registered(harnessed);
    const second = await issued(served, made.secret, "a second worker");

    await served.call("POST", `/v0/keys/${second.key.id}/disable`, {
      headers: bearer(made.secret),
    });

    const listed = await keysWith(served, made.secret);
    const revoked = listed.keys.find((key) => key.id === second.key.id);
    expect(revoked?.disabled_at).toBe(new Date(harnessed.now()).toISOString());
  });
});

/** One key issued through the route, with the answer read back. */
const issued = async (
  served: Served,
  key: string,
  label: string,
): Promise<{ key: { id: string; label: string }; secret: string }> => {
  const answered = await served.call("POST", "/v0/keys", { body: { label }, headers: bearer(key) });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return answered.body as { key: { id: string; label: string }; secret: string };
};

describe("issuing another key", () => {
  it("issues a key that opens the door, leaving the one that asked for it working", async () => {
    // The whole reason a key is a row: a merchant hands one to each worker.
    const { served, harnessed } = await started();
    const made = await registered(harnessed);

    const second = await issued(served, made.secret, "a second worker");

    expect(second.key.label).toBe("a second worker");
    expect(await opensTheDoor(served, second.secret)).toBe(true);
    expect(await opensTheDoor(served, made.secret)).toBe(true);
  });

  it("issues the key to the merchant who asked and to nobody else", async () => {
    const { served, harnessed } = await started();
    const first = await registered(harnessed);
    const second = await registered(harnessed);
    await readyToSell(harnessed, served, first, "First shop");
    const itemId = await publish(served, first.secret, cardFor("a-room", "A room"));

    const another = await issued(served, first.secret, "another of the first shop's");

    const seen = await served.call("GET", "/v0/cards", { headers: bearer(another.secret) });
    expect((seen.body as { cards: { id: string }[] }).cards.map((card) => card.id)).toStrictEqual([
      itemId,
    ]);
    expect((await keysWith(served, second.secret)).keys.map((key) => key.id)).toStrictEqual([
      second.keyId,
    ]);
  });
});

describe("disabling a key", () => {
  it("stops the named key and leaves the one that asked for it working", async () => {
    const { served, harnessed } = await started();
    const made = await registered(harnessed);
    const second = await issued(served, made.secret, "a second worker");

    const answered = await served.call("POST", `/v0/keys/${second.key.id}/disable`, {
      headers: bearer(made.secret),
    });

    expect(answered.status).toBe(200);
    expect(
      (answered.body as { key: { disabled_at: string | null } }).key.disabled_at,
    ).not.toBeNull();
    expect(await opensTheDoor(served, second.secret)).toBe(false);
    expect(await opensTheDoor(served, made.secret)).toBe(true);
  });

  it("refuses to disable the key the call was made with", async () => {
    // ADR-0014 §5. One call otherwise, and whoever holds that key meets "the
    // gateway will not take this key" on every call afterwards.
    const { served, harnessed } = await started();
    const made = await registered(harnessed);

    const answered = await served.call("POST", `/v0/keys/${made.keyId}/disable`, {
      headers: bearer(made.secret),
    });

    expect(answered.status).toBe(409);
    expect((answered.body as { error: { code: string } }).error.code).toBe("key_opened_this_call");
    // And the key is still working afterwards, which is the half that matters:
    // a refusal that had already written the revocation would be worse than no
    // rule at all.
    expect(await opensTheDoor(served, made.secret)).toBe(true);
  });

  it("refuses the caller's own key even where the merchant has others", async () => {
    // The rule is about the key this call was made with and not about the last
    // working key: a merchant with two keys still cannot disable the one the
    // call in front of the gateway came in on.
    const { served, harnessed } = await started();
    const made = await registered(harnessed);
    const worker = await issued(served, made.secret, "the worker on the small box");

    const answered = await served.call("POST", `/v0/keys/${worker.key.id}/disable`, {
      headers: bearer(worker.secret),
    });

    expect(answered.status).toBe(409);
    expect(await opensTheDoor(served, worker.secret)).toBe(true);
  });

  it("disables any key from the dashboard, which holds none", async () => {
    // A session calls inside the process with no key, so no key on its list
    // is the one its call was made with, and every one of them — the one the
    // merchant's code calls with included — is the merchant's to switch off.
    const { served, harnessed } = await started();
    const made = await registered(harnessed);

    const disabled = await harnessed.gateway.disableMerchantKey(
      made.merchant_id,
      made.keyId,
      SIGNED_IN,
    );

    expect(disabled).toMatchObject({ key: { id: made.keyId } });
    expect(await opensTheDoor(served, made.secret)).toBe(false);
  });

  it("answers another merchant's key exactly as a key that never existed", async () => {
    // Answered differently, this call would count somebody else's keys: a
    // stranger walking identifiers would learn which of them are real.
    const { served, harnessed } = await started();
    const first = await registered(harnessed);
    const second = await registered(harnessed);

    const theirs = await served.call("POST", `/v0/keys/${second.keyId}/disable`, {
      headers: bearer(first.secret),
    });
    const nobodys = await served.call("POST", "/v0/keys/mk_nobody_was_issued/disable", {
      headers: bearer(first.secret),
    });

    expect(theirs.status).toBe(404);
    expect(theirs.body).toStrictEqual(nobodys.body);
    // And the other merchant's key is untouched, which is what the refusal is
    // actually protecting.
    expect(await opensTheDoor(served, second.secret)).toBe(true);
  });

  it("answers a second disabling the same way and keeps the first instant", async () => {
    // A retry after a dropped connection is safe, and the instant somebody
    // reconstructs an incident from is not moved by it.
    const { served, harnessed } = await started();
    const made = await registered(harnessed);
    const second = await issued(served, made.secret, "a second worker");

    const first = await served.call("POST", `/v0/keys/${second.key.id}/disable`, {
      headers: bearer(made.secret),
    });
    harnessed.advance(60_000);
    const again = await served.call("POST", `/v0/keys/${second.key.id}/disable`, {
      headers: bearer(made.secret),
    });

    expect(again.status).toBe(200);
    expect(again.body).toStrictEqual(first.body);
  });

  it("takes no key of a merchant who presents none", async () => {
    // The three key routes are behind the merchant's door like every other
    // merchant route, so a call with no key never reaches a handler.
    const { served } = await started();

    expect((await served.call("GET", "/v0/keys")).status).toBe(401);
    expect((await served.call("POST", "/v0/keys", { body: { label: "x" } })).status).toBe(401);
    expect((await served.call("POST", "/v0/keys/mk_whichever/disable")).status).toBe(401);
  });
});

/** The code and the sentence out of a refusal, which is what this door says. */
const refusalIn = (answered: { readonly body: unknown }): { code: string; message: string } =>
  (answered.body as { error: { code: string; message: string } }).error;

/**
 * What makes a harness a live one: Base mainnet, and the one facilitator a live
 * chain is allowed. The harness wires the scripted facilitator whatever the
 * configuration says, so naming Coinbase's here buys the derivation and nothing
 * else.
 */
const LIVE_CHAIN = {
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  CDP_API_KEY_ID: "key-id",
  CDP_API_KEY_SECRET: "secret",
};

describe("what a presented value's prefix says", () => {
  it("is told only which prefix it begins with and where keys with that prefix work", async () => {
    // The gateway under test is live; the value presented merely begins like a
    // test key. No digest lookup follows this branch, so the gateway knows
    // nothing about whether this fabricated value is or ever was a key.
    const { served } = await started(LIVE_CHAIN);

    const answered = await served.call("GET", "/v0/cards", {
      headers: bearer("csk_test_a-made-up-value"),
    });

    expect(answered.status).toBe(401);
    // The same code every other refusal at this door carries. What changes is
    // the sentence: a new machine-readable code would be a new value in a
    // closed response enum, which by ADR-0006 moves CONTRACT_VERSION from "1"
    // and stops every installed worker at startup — a heavy price for words,
    // and the charter's answer to a finding is honest words at the door rather
    // than a wider surface.
    const said = refusalIn(answered);
    expect(said.code).toBe("not_authorised");
    expect(said.message).toContain("this value begins with csk_test_");
    expect(said.message).toContain("keys with that prefix work on test.agentify.ad");
    expect(said.message).not.toContain("this is a test key");
  });

  it("says nothing more to a value that names no environment at all", async () => {
    // The bare prefix, a guess, a stranger's key: all one answer, because a
    // door that told them apart would confirm which guesses had once been real
    // keys — which is exactly what revoking one has to stop. A key that names
    // the other environment is the one exception, and it gives nothing away:
    // whoever presents the value can read its prefix.
    const { served } = await started();

    const answered = await served.call("GET", "/v0/cards", {
      headers: bearer("csk_not-an-environment"),
    });

    expect(answered.status).toBe(401);
    const said = refusalIn(answered);
    expect(said.code).toBe("not_authorised");
    expect(said.message).not.toContain("agentify.ad");
  });

  it("turns away a key from before this change, whose digest is still in the database", async () => {
    // The delete-first promise, made by the door rather than by a database
    // somebody emptied: the row is there, the digest matches, and the key still
    // opens nothing. Without this the promise would hold only because the host
    // reset destroyed both volumes, which is a fact about an afternoon rather
    // than about the system.
    const { harnessed, served } = await started();
    const legacy = "a-merchant-key-long-enough";
    await harnessed.store.addKey(
      {
        id: "mk_legacy",
        merchantId: harnessed.merchant.id,
        label: "issued before the split",
        digest: keyDigest(legacy),
      },
      harnessed.now(),
    );

    // The premise, asserted rather than assumed. This is the lookup the door
    // makes, and it finds the row — so what turns the key away below is the
    // prefix and not a write that never landed. Left out, a change that made
    // this `addKey` do nothing would leave the test green and testing nothing.
    expect(await harnessed.store.workingKey(keyDigest(legacy))).not.toBeNull();
    expect(await opensTheDoor(served, legacy)).toBe(false);
  });

  it("lets this environment's own key through to the lookup", async () => {
    const { harnessed, served } = await started();

    expect(await opensTheDoor(served, harnessed.merchant.key)).toBe(true);
  });

  it("lets a live gateway's own key through, which is the same rule the other way", async () => {
    // The rule read in the other direction, and the fixture every HTTP test in
    // this repository leans on. A harness whose key was a constant carrying
    // `csk_test_` handed a live gateway a key its own door refuses, so a test
    // that overrode the chain would fail at its first call for a reason that
    // had nothing to do with what it was testing — and the smoke, which boots
    // through the same shape one package over, would fail wholesale on the day
    // it was first pointed at mainnet.
    const { harnessed, served } = await started(LIVE_CHAIN);

    // Asserted, so that a door which accepted everything could not pass this.
    expect(harnessed.merchant.key.startsWith("csk_live_")).toBe(true);
    expect(await opensTheDoor(served, harnessed.merchant.key)).toBe(true);
  });
});

/**
 * The mark the door leaves on the key a call was made with.
 *
 * It is the one thing on that screen a merchant cannot work out for
 * themselves: three keys, and which of them is safe to revoke. Everything below
 * is about the two ways of getting it wrong. Writing it on every call would put
 * a database write in front of every purchase for the sake of a column somebody
 * reads once a week; writing it too rarely, or against the wrong row, would
 * answer the question wrongly on the one screen where being wrong ends with a
 * live key revoked.
 *
 * The instants are read out of the store rather than off the surface, because
 * the surface carries the key's own mark and these cases are about a key the
 * call was not made with.
 */
describe("the mark a call leaves on the key it was made with", () => {
  /** When the store last saw a call on one key, straight off the row. */
  const markOn = async (
    harnessed: Harness,
    merchantId: string,
    keyId: string,
  ): Promise<number | null> => {
    const found = (await harnessed.store.keysOf(merchantId)).find((key) => key.id === keyId);
    if (found === undefined) {
      throw new Error(`the key ${keyId} is not among ${merchantId}'s`);
    }
    return found.lastUsedAt;
  };

  /** Another key of one merchant's own, and the row it is. */
  const spareKey = async (served: Served, key: string, label: string): Promise<string> => {
    const answered = await served.call("POST", "/v0/keys", {
      body: { label },
      headers: bearer(key),
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    return (answered.body as { key: { id: string } }).key.id;
  };

  /** The smallest call there is, made with one key. */
  const callWith = async (served: Served, key: string): Promise<void> => {
    const answered = await served.call("GET", "/v0/cards", { headers: bearer(key) });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  };

  it("marks the key the call came in on and leaves the merchant's others blank", async () => {
    // The row and not the merchant. A merchant hands one key to each worker
    // precisely so that one can be revoked without touching the rest, and a
    // mark that landed on all of them would say every key is in use — which is
    // the answer that stops anybody revoking anything.
    const { served, harnessed } = await started();
    const { merchant } = harnessed;
    const idle = await spareKey(served, merchant.key, "the one nobody calls");

    await callWith(served, merchant.key);

    expect(await markOn(harnessed, merchant.id, merchant.keyId)).toBe(harnessed.now());
    expect(await markOn(harnessed, merchant.id, idle)).toBeNull();
  });

  it("leaves the mark where it is on a second call made straight after the first", async () => {
    // The door reads this row on every call behind it, and writing to it on
    // every call would be a write in front of every purchase for a fact nobody
    // reads twice a day. So the mark is refreshed only once it has gone stale,
    // and this is that: the thinning is behaviour rather than an optimisation,
    // and without a case it would come out in a refactor with nothing failing.
    const { served, harnessed } = await started();
    const { merchant } = harnessed;

    await callWith(served, merchant.key);
    const first = await markOn(harnessed, merchant.id, merchant.keyId);

    harnessed.advance(60_000);
    await callWith(served, merchant.key);

    expect(first).toBe(harnessed.now() - 60_000);
    expect(await markOn(harnessed, merchant.id, merchant.keyId)).toBe(first);
  });

  it("moves the mark on for a call that comes in long after the last one", async () => {
    // The other half of the same rule, and the half a merchant is looking at.
    // A mark that stopped moving would answer "last used in August" about a key
    // somebody's worker is calling with this morning.
    const { served, harnessed } = await started();
    const { merchant } = harnessed;

    await callWith(served, merchant.key);
    harnessed.advance(60 * 60_000);
    await callWith(served, merchant.key);

    expect(await markOn(harnessed, merchant.id, merchant.keyId)).toBe(harnessed.now());
  });

  it("does not move one merchant's mark when another merchant calls", async () => {
    // Two merchants prove what one cannot. A gateway that wrote the mark
    // without scoping it to the row would pass every assertion a single
    // merchant can make, and would report a key as busy on the strength of
    // somebody else's traffic.
    const { served, harnessed } = await started();
    const theirs = await harnessed.addMerchant();
    const ours = harnessed.merchant;
    await callWith(served, ours.key);
    const before = await markOn(harnessed, ours.id, ours.keyId);

    harnessed.advance(60 * 60_000);
    await callWith(served, theirs.key);

    expect(await markOn(harnessed, theirs.id, theirs.keyId)).toBe(harnessed.now());
    expect(await markOn(harnessed, ours.id, ours.keyId)).toBe(before);
  });

  it("answers the call when the mark cannot be written, and says so in the log", async () => {
    // The mark is what somebody reads on a screen; the call behind it is
    // somebody's purchase. A database that will not take the one must not
    // refuse the other — and it must not do it quietly either, or the column
    // goes stale across a deployment with nothing anywhere saying why.
    const { served, harnessed } = await started();
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    harnessed.store.noteKeyUse = async () => {
      throw new Error("the database would not take it");
    };

    const answered = await served.call("GET", "/v0/cards", {
      headers: bearer(harnessed.merchant.key),
    });

    expect(answered.status).toBe(200);
    // The line names the key and what was not written, not just any error.
    expect(said).toHaveBeenCalledWith(
      expect.stringContaining(
        `the last use of the key ${harnessed.merchant.keyId} was not written down`,
      ),
      expect.objectContaining({ message: "the database would not take it" }),
    );
  });
});

describe("the merchant every ordinary test sells as", () => {
  it("still reaches its own keys, which is what the seeded merchant is for", async () => {
    // The harness writes a merchant straight into the store, with no
    // registration involved, the way the sandbox's seed does and the way every
    // merchant a database already held came to be. Its key resolves to a key
    // row like any other, so the list names it — a door that could only name a
    // key registration made would break every one of those.
    const { served, harnessed } = await started();

    const listed = await keysWith(served, harnessed.merchant.key);

    expect(listed.this_call).toBe(harnessed.merchant.keyId);
    expect(listed.keys.map((key) => key.id)).toStrictEqual([harnessed.merchant.keyId]);
  });
});

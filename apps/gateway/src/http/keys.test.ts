/**
 * Registering a merchant, and the keys they keep afterwards. A merchant and
 * their first key are made in-process, the way the dashboard makes them;
 * everything after goes through `serve`, so what is asserted is the answer a
 * merchant's own client receives. Rules about another merchant's keys, or
 * about registering twice, are tested with two merchants, because one cannot
 * show them.
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
  // One case silences the console to read it; left mocked, it would hide every
  // later case's failure output.
  vi.restoreAllMocks();
});

const bearer = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });

interface Registered {
  readonly merchant_id: string;
  /** The first key, issued from the dashboard. */
  readonly secret: string;
  readonly keyId: string;
}

/** A merchant and their first key, made the way the dashboard makes them. */
const registered = async (harnessed: Harness): Promise<Registered> => {
  const merchantId = await harnessed.gateway.registerMerchant();
  const first = await harnessed.gateway.issueMerchantKey(merchantId, "the first worker", SIGNED_IN);
  return { merchant_id: merchantId, secret: first.secret, keyId: first.key.id };
};

/**
 * Sets the seller name and the payout wallet, both required before a merchant
 * can publish. Their refusals are tested in `seller-name.test.ts` and
 * `payout-wallet.test.ts`.
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
    // The dashboard calls the gateway in-process and holds no key, so
    // registering, dashboard keys and setting the wallet have no HTTP route.
    // Reading the wallet is a call a merchant's own code makes.
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
    // Registering makes only the merchant; the key, the seller name and the
    // wallet are each set afterwards on their own screens.
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
    // A published card carries the seller name into the payment challenge that
    // discovery catalogues read.
    const { served, harnessed } = await started();
    const made = await registered(harnessed);
    await readyToSell(harnessed, served, made, "Someone's shop");

    const itemId = await publish(served, made.secret, cardFor("a-room", "A room"));
    const seller = await sellerInTheChallenge(served, itemId);

    expect(seller.serviceName).toBe("Someone's shop");
    expect(seller.extensions).toBeDefined();
  });

  it("gives each registration a merchant of its own", async () => {
    // Registering into a shared merchant would hand the second person the first
    // one's cards, orders and receipts.
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
    // The calling key is always on the list, so a screen can offer to disable
    // every row but that one.
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
    // `this_call` is the key that opened this call, not the merchant's first
    // key or the list's first row. Named wrongly, a screen would offer to
    // disable the one key the gateway answers 409 to.
    const { served, harnessed } = await started();
    const made = await registered(harnessed);
    const second = await issued(served, made.secret, "a second worker");

    const asTheFirst = await keysWith(served, made.secret);
    const asTheSecond = await keysWith(served, second.secret);

    expect(asTheFirst.this_call).toBe(made.keyId);
    expect(asTheSecond.this_call).toBe(second.key.id);
    // The same keys are listed both times. Only ids are compared: each read is
    // itself a call and marks its own key as used, so the rows differ.
    expect(asTheSecond.keys.map((key) => key.id)).toStrictEqual(
      asTheFirst.keys.map((key) => key.id),
    );
  });

  it("lists no key of another merchant's", async () => {
    // Another merchant's list would reveal how many workers they run and what
    // each is called. An unscoped list passes every single-merchant assertion.
    const { served, harnessed } = await started();
    const first = await registered(harnessed);
    const second = await registered(harnessed);

    const forFirst = await keysWith(served, first.secret);
    const forSecond = await keysWith(served, second.secret);

    expect(forFirst.keys.map((key) => key.id)).toStrictEqual([first.keyId]);
    expect(forSecond.keys.map((key) => key.id)).toStrictEqual([second.keyId]);
  });

  it("keeps a revoked key in the list with the instant it stopped", async () => {
    // After an incident the question is when a key stopped working.
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
    // Otherwise one call would lock out whoever holds that key.
    const { served, harnessed } = await started();
    const made = await registered(harnessed);

    const answered = await served.call("POST", `/v0/keys/${made.keyId}/disable`, {
      headers: bearer(made.secret),
    });

    expect(answered.status).toBe(409);
    expect((answered.body as { error: { code: string } }).error.code).toBe("key_opened_this_call");
    // A refusal that had already written the revocation would be worse than no
    // rule at all.
    expect(await opensTheDoor(served, made.secret)).toBe(true);
  });

  it("refuses the caller's own key even where the merchant has others", async () => {
    // The rule is about the calling key, not about the last working key.
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
    // A signed-in session calls with no key, so it may disable any key,
    // including the one the merchant's code calls with.
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
    // Answered differently, a caller walking identifiers would learn which of
    // them are other merchants' real keys.
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
    expect(await opensTheDoor(served, second.secret)).toBe(true);
  });

  it("answers a second disabling the same way and keeps the first instant", async () => {
    // A retry after a dropped connection must not move the instant an incident
    // is reconstructed from.
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
    const { served } = await started();

    expect((await served.call("GET", "/v0/keys")).status).toBe(401);
    expect((await served.call("POST", "/v0/keys", { body: { label: "x" } })).status).toBe(401);
    expect((await served.call("POST", "/v0/keys/mk_whichever/disable")).status).toBe(401);
  });
});

/** The code and the message of a refusal. */
const refusalIn = (answered: { readonly body: unknown }): { code: string; message: string } =>
  (answered.body as { error: { code: string; message: string } }).error;

/**
 * Base mainnet and the one facilitator a live chain allows. The harness still
 * wires its scripted facilitator, so this changes only what the gateway derives
 * from its configuration.
 */
const LIVE_CHAIN = {
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  CDP_API_KEY_ID: "key-id",
  CDP_API_KEY_SECRET: "secret",
};

describe("what a presented value's prefix says", () => {
  it("is told only which prefix it begins with and where keys with that prefix work", async () => {
    // The gateway is live and the value merely begins like a test key. No
    // digest lookup happens on this branch, so the answer reveals nothing about
    // whether the value is or ever was a key.
    const { served } = await started(LIVE_CHAIN);

    const answered = await served.call("GET", "/v0/cards", {
      headers: bearer("csk_test_a-made-up-value"),
    });

    expect(answered.status).toBe(401);
    // The same code as every other refusal here; only the message differs. A
    // new code would be a new value in a closed response enum, which bumps
    // CONTRACT_VERSION and stops every installed worker at startup.
    const said = refusalIn(answered);
    expect(said.code).toBe("not_authorised");
    expect(said.message).toContain("this value begins with csk_test_");
    expect(said.message).toContain("keys with that prefix work on test.agentify.ad");
    expect(said.message).not.toContain("this is a test key");
  });

  it("says nothing more to a value that names no environment at all", async () => {
    // Every value that names no environment gets one answer: telling them apart
    // would confirm which guesses were once real keys. A value naming the other
    // environment is the one exception, and its prefix is already the caller's.
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
    // A key without an environment prefix is refused by the door even when its
    // row and digest are in the database, not merely because a database was
    // emptied.
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

    // The premise: the door's own lookup finds the row, so what turns the key
    // away below is the prefix and not a write that never landed.
    expect(await harnessed.store.workingKey(keyDigest(legacy))).not.toBeNull();
    expect(await opensTheDoor(served, legacy)).toBe(false);
  });

  it("lets this environment's own key through to the lookup", async () => {
    const { harnessed, served } = await started();

    expect(await opensTheDoor(served, harnessed.merchant.key)).toBe(true);
  });

  it("lets a live gateway's own key through, which is the same rule the other way", async () => {
    // Every HTTP test leans on the harness key matching the gateway's
    // environment. A live harness handing out a `csk_test_` key would be
    // refused at its first call, and so would the smoke run against mainnet.
    const { harnessed, served } = await started(LIVE_CHAIN);

    // Asserted, so that a door which accepted everything could not pass this.
    expect(harnessed.merchant.key.startsWith("csk_live_")).toBe(true);
    expect(await opensTheDoor(served, harnessed.merchant.key)).toBe(true);
  });
});

/**
 * The last-use mark tells a merchant which keys are safe to revoke. Written on
 * every call, it would put a database write in front of every purchase; written
 * too rarely or on the wrong row, it would get a live key revoked. The instants
 * are read from the store, because a read over the route is itself a call and
 * these cases are about keys a call was not made with.
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

  /** Issues another key for the same merchant and returns its id. */
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
    // A mark on every key of the merchant would show all of them in use, and
    // nobody could tell which one is safe to revoke.
    const { served, harnessed } = await started();
    const { merchant } = harnessed;
    const idle = await spareKey(served, merchant.key, "the one nobody calls");

    await callWith(served, merchant.key);

    expect(await markOn(harnessed, merchant.id, merchant.keyId)).toBe(harnessed.now());
    expect(await markOn(harnessed, merchant.id, idle)).toBeNull();
  });

  it("leaves the mark where it is on a second call made straight after the first", async () => {
    // The mark is refreshed only once stale, to keep a write out of every
    // purchase. Without this case a refactor could drop that with nothing failing.
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
    // A mark that stopped moving would show a key a worker calls with today as
    // long idle.
    const { served, harnessed } = await started();
    const { merchant } = harnessed;

    await callWith(served, merchant.key);
    harnessed.advance(60 * 60_000);
    await callWith(served, merchant.key);

    expect(await markOn(harnessed, merchant.id, merchant.keyId)).toBe(harnessed.now());
  });

  it("does not move one merchant's mark when another merchant calls", async () => {
    // A mark not scoped to the row passes every single-merchant assertion and
    // would report a key as busy on somebody else's traffic.
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

  it("records what the caller says it runs beside the mark, so the team can see who runs which release", async () => {
    // Read straight off the row: nothing a merchant reads carries it.
    const { served, harnessed } = await started();
    const { merchant } = harnessed;
    const clientOn = async (): Promise<string | null | undefined> =>
      (await harnessed.store.keysOf(merchant.id)).find((key) => key.id === merchant.keyId)
        ?.lastUserAgent;
    const callAs = async (userAgent: string): Promise<void> => {
      const answered = await served.call("GET", "/v0/cards", {
        headers: { ...bearer(merchant.key), "user-agent": userAgent },
      });
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    };

    await callAs("agentify-sdk/0.7.1");
    expect(await clientOn()).toBe("agentify-sdk/0.7.1");

    harnessed.advance(60 * 60_000);
    await callAs("agentify-sdk/0.8.0");
    expect(await clientOn()).toBe("agentify-sdk/0.8.0");
  });

  it("answers the call when the mark cannot be written, and says so in the log", async () => {
    // A mark that cannot be written must not fail the purchase behind it, and
    // must be logged, or the column goes stale with nothing saying why.
    const { served, harnessed } = await started();
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    harnessed.store.noteKeyUse = async () => {
      throw new Error("the database would not take it");
    };

    const answered = await served.call("GET", "/v0/cards", {
      headers: bearer(harnessed.merchant.key),
    });

    expect(answered.status).toBe(200);
    // The line names the key and what was not written, in one line of its own.
    expect(said).toHaveBeenCalledWith(
      expect.stringContaining(
        `the last use of the key ${harnessed.merchant.keyId} was not written down`,
      ),
    );
  });
});

describe("the merchant every ordinary test sells as", () => {
  it("still reaches its own keys, which is what the seeded merchant is for", async () => {
    // The harness writes its merchant straight into the store, as the sandbox
    // seed does, with no registration. Its key must still resolve to a key row
    // that the list names.
    const { served, harnessed } = await started();

    const listed = await keysWith(served, harnessed.merchant.key);

    expect(listed.this_call).toBe(harnessed.merchant.keyId);
    expect(listed.keys.map((key) => key.id)).toStrictEqual([harnessed.merchant.keyId]);
  });
});

/**
 * Registering a merchant, and the keys they keep afterwards. Merchants and
 * their keys are made, listed and disabled in-process, the way the dashboard
 * does it, since no key reaches those calls; what a key then opens goes
 * through `serve`, so it is the answer a merchant's own client receives. Rules about another merchant's keys, or
 * about registering twice, are tested with two merchants, because one cannot
 * show them.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
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

describe("a merchant's key", () => {
  // Keys are issued and disabled only from a signed-in dashboard session. A
  // key that could issue keys would outlive its own revocation through the
  // successors it issued, and one that could disable keys would lock the
  // merchant's own code out.

  it("cannot issue another key, and nothing is issued", async () => {
    const { served, harnessed } = await started();
    const before = await harnessed.store.keysOf(harnessed.merchant.id);

    const asked = await served.call("POST", "/v0/keys", {
      body: { label: "a key of its own" },
      headers: bearer(harnessed.merchant.key),
    });

    expect(asked.status).toBe(404);
    expect(refusalIn(asked).code).toBe("no_such_route");
    expect(await harnessed.store.keysOf(harnessed.merchant.id)).toStrictEqual(before);
  });

  it("cannot disable another of the merchant's keys, which goes on working", async () => {
    const { served, harnessed } = await started();
    const theirs = await harnessed.addKey(harnessed.merchant.id, "the merchant's own worker");
    const theirsId = (await harnessed.store.keysOf(harnessed.merchant.id)).find(
      (key) => key.id !== harnessed.merchant.keyId,
    )?.id;

    const asked = await served.call("POST", `/v0/keys/${theirsId}/disable`, {
      headers: bearer(harnessed.merchant.key),
    });

    expect(asked.status).toBe(404);
    expect(refusalIn(asked).code).toBe("no_such_route");
    expect(await opensTheDoor(served, theirs)).toBe(true);
  });

  it("cannot read the merchant's list of keys", async () => {
    // The list existed to tell a caller which key not to disable; nothing a
    // merchant's code does needs it, and it would show a stolen key every
    // other key's name and last use.
    const { served, harnessed } = await started();

    const asked = await served.call("GET", "/v0/keys", {
      headers: bearer(harnessed.merchant.key),
    });

    expect(asked.status).toBe(404);
    expect(refusalIn(asked).code).toBe("no_such_route");
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

/** The ids of a merchant's keys, as the dashboard lists them. */
const keyIdsOf = async (harnessed: Harness, merchantId: string): Promise<string[]> =>
  (await harnessed.gateway.merchantKeys(merchantId)).map((key) => key.id);

/** One more key, issued the way the dashboard issues it. */
const issued = (harnessed: Harness, merchantId: string, label: string) =>
  harnessed.gateway.issueMerchantKey(merchantId, label, SIGNED_IN);

describe("the keys a merchant holds", () => {
  it("lists every key of theirs and no key of another merchant's", async () => {
    // Another merchant's list would reveal how many workers they run and what
    // each is called. An unscoped list passes every single-merchant assertion.
    const { harnessed } = await started();
    const first = await registered(harnessed);
    const second = await registered(harnessed);
    const worker = await issued(harnessed, first.merchant_id, "the worker on the small box");

    expect(await keyIdsOf(harnessed, first.merchant_id)).toStrictEqual([
      first.keyId,
      worker.key.id,
    ]);
    expect(await keyIdsOf(harnessed, second.merchant_id)).toStrictEqual([second.keyId]);
  });

  it("keeps a revoked key in the list with the instant it stopped", async () => {
    // After an incident the question is when a key stopped working.
    const { harnessed } = await started();
    const made = await registered(harnessed);
    const second = await issued(harnessed, made.merchant_id, "a second worker");

    await harnessed.gateway.disableMerchantKey(made.merchant_id, second.key.id);

    const listed = await harnessed.gateway.merchantKeys(made.merchant_id);
    const revoked = listed.find((key) => key.id === second.key.id);
    expect(revoked?.disabled_at).toBe(new Date(harnessed.now()).toISOString());
  });
});

describe("issuing another key", () => {
  it("issues a key that opens the door, leaving the merchant's others working", async () => {
    const { served, harnessed } = await started();
    const made = await registered(harnessed);

    const second = await issued(harnessed, made.merchant_id, "a second worker");

    expect(second.key.label).toBe("a second worker");
    expect(await opensTheDoor(served, second.secret)).toBe(true);
    expect(await opensTheDoor(served, made.secret)).toBe(true);
  });

  it("issues the key to the merchant it was asked for and to nobody else", async () => {
    const { served, harnessed } = await started();
    const first = await registered(harnessed);
    const second = await registered(harnessed);
    await readyToSell(harnessed, served, first, "First shop");
    const itemId = await publish(served, first.secret, cardFor("a-room", "A room"));

    const another = await issued(harnessed, first.merchant_id, "another of the first shop's");

    const seen = await served.call("GET", "/v0/cards", { headers: bearer(another.secret) });
    expect((seen.body as { cards: { id: string }[] }).cards.map((card) => card.id)).toStrictEqual([
      itemId,
    ]);
    expect(await keyIdsOf(harnessed, second.merchant_id)).toStrictEqual([second.keyId]);
  });
});

describe("disabling a key", () => {
  it("stops the named key and leaves the merchant's others working", async () => {
    const { served, harnessed } = await started();
    const made = await registered(harnessed);
    const second = await issued(harnessed, made.merchant_id, "a second worker");

    const disabled = await harnessed.gateway.disableMerchantKey(made.merchant_id, second.key.id);

    expect(disabled?.disabled_at).not.toBeNull();
    expect(await opensTheDoor(served, second.secret)).toBe(false);
    expect(await opensTheDoor(served, made.secret)).toBe(true);
  });

  it("disables any key from the dashboard, the one the merchant's code calls with too", async () => {
    // A signed-in session calls with no key, so no key is its own to keep.
    const { served, harnessed } = await started();
    const made = await registered(harnessed);

    const disabled = await harnessed.gateway.disableMerchantKey(made.merchant_id, made.keyId);

    expect(disabled).toMatchObject({ id: made.keyId });
    expect(await opensTheDoor(served, made.secret)).toBe(false);
  });

  it("answers another merchant's key exactly as a key that never existed", async () => {
    // Answered differently, a session walking identifiers would learn which of
    // them are other merchants' real keys.
    const { served, harnessed } = await started();
    const first = await registered(harnessed);
    const second = await registered(harnessed);

    const theirs = await harnessed.gateway.disableMerchantKey(first.merchant_id, second.keyId);
    const nobodys = await harnessed.gateway.disableMerchantKey(
      first.merchant_id,
      "mk_nobody_was_issued",
    );

    expect(theirs).toBeNull();
    expect(nobodys).toBeNull();
    expect(await opensTheDoor(served, second.secret)).toBe(true);
  });

  it("answers a second disabling the same way and keeps the first instant", async () => {
    // A retry after a dropped connection must not move the instant an incident
    // is reconstructed from.
    const { harnessed } = await started();
    const made = await registered(harnessed);
    const second = await issued(harnessed, made.merchant_id, "a second worker");

    const first = await harnessed.gateway.disableMerchantKey(made.merchant_id, second.key.id);
    harnessed.advance(60_000);
    const again = await harnessed.gateway.disableMerchantKey(made.merchant_id, second.key.id);

    expect(again).toStrictEqual(first);
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
  const spareKey = async (harnessed: Harness, merchantId: string, label: string) =>
    (await harnessed.gateway.issueMerchantKey(merchantId, label, SIGNED_IN)).key.id;

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
    const idle = await spareKey(harnessed, merchant.id, "the one nobody calls");

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
  it("holds the one key it opens the door with, which is what the seeded merchant is for", async () => {
    // The harness writes its merchant straight into the store, as the sandbox
    // seed does, with no registration. Its key must still open the door and be
    // the one key its list names.
    const { served, harnessed } = await started();

    expect(await opensTheDoor(served, harnessed.merchant.key)).toBe(true);
    expect(await keyIdsOf(harnessed, harnessed.merchant.id)).toStrictEqual([
      harnessed.merchant.keyId,
    ]);
  });
});

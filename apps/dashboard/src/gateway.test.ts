/**
 * What a page relies on and no screen test pins down: input is held to the
 * contract's request schema before anything is done; a refusal reaches a page
 * in the words and status the HTTP route gives it, and a wallet change's
 * refusal in words that are true about a mailbox; a call that does not finish
 * is given up on at its deadline and said to be possibly done, while our own
 * failure is not dressed up as an answer; and a message names the account the
 * session is signed in as. The application is the real one on the gateway's
 * in-memory harness.
 */

import { type Gateway, payoutSplitFor, SPLITS_PER_PAYOUT } from "@agentify/gateway";
import { type Harness, harness, type Served, serve, workOnce } from "@agentify/gateway/testing";
import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayFor } from "./gateway.js";

/** Base mainnet and its one facilitator. */
const LIVE = {
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  CDP_API_KEY_ID: "key-id",
  CDP_API_KEY_SECRET: "key-secret",
};

const OWNER = "owner@example.com";
const A_WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

let open: { harnessed: Harness; served: Served | null } | null = null;

const started = async (overrides: Record<string, string> = {}) => {
  const harnessed = await harness(overrides);
  open = { harnessed, served: null };
  return harnessed;
};

afterEach(async () => {
  await open?.served?.close();
  await open?.harnessed.stop();
  open = null;
});

const asTheOwner = (harnessed: Harness, answerWithinMs?: number) =>
  gatewayFor(
    harnessed.gateway,
    { merchantId: harnessed.merchant.id, email: OWNER },
    answerWithinMs,
  );

/** Goods that arrive after the purchase, which is what late goods are for. */
const AN_ESIM: Card = {
  merchant_item_id: "esim-7d",
  title: "A seven day eSIM",
  description: "Seven days of data",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
};

const aPaidOrder = async (harnessed: Harness, merchantId: string): Promise<string> => {
  const published = await harnessed.gateway.publishCard(merchantId, AN_ESIM);
  if (!published.ok) throw new Error(`the card was refused: ${JSON.stringify(published)}`);
  const offered = await harnessed.gateway.beginPurchase(published.id, {});
  if (offered.step !== "pay") throw new Error("no price was offered");
  await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
  return offered.order.order.id;
};

const silenced = (application: Gateway): Gateway =>
  new Proxy(application, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? () => new Promise(() => undefined) : value;
    },
  });

const answering = (application: Gateway, name: keyof Gateway, answer: () => unknown): Gateway =>
  new Proxy(application, {
    get(target, property, receiver) {
      if (property === name) {
        return async () => answer();
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

describe("what goes in", () => {
  it("refuses an address that is not one in the schema's words, and changes nothing", async () => {
    // The page checks the address first; this second check says what the
    // contract says rather than something of its own.
    const harnessed = await started();

    const refused = await asTheOwner(harnessed).setPayoutWallet("0x1234");

    expect(refused).toMatchObject({ ok: false, status: 400, code: "malformed_body" });
    expect(refused.ok ? "" : refused.why).toMatch(/40 hexadecimal|address/i);
    expect((await harnessed.store.merchantById(harnessed.merchant.id))?.payoutWallet.address).toBe(
      harnessed.merchant.wallet,
    );
  });

  it("refuses a key name of two lines, and issues nothing", async () => {
    const harnessed = await started();
    const before = (await harnessed.store.keysOf(harnessed.merchant.id)).length;

    const refused = await asTheOwner(harnessed).issueKey("the stock worker\nhttps://example.com");

    expect(refused).toMatchObject({ ok: false, status: 400, code: "malformed_body" });
    expect((await harnessed.store.keysOf(harnessed.merchant.id)).length).toBe(before);
  });

  it("refuses a wait the contract does not take, as the door would, and draws nothing", async () => {
    const harnessed = await started();

    const drawn = await asTheOwner(harnessed).pollWorker(1.5);

    expect(drawn).toMatchObject({ ok: false, status: 400, code: "malformed_body" });
  });
});

describe("a refusal", () => {
  it("reaches the page in the words and under the status the route at the door gives it", async () => {
    // A merchant on the keys screen and their engineer reading the API are told
    // the same thing about a missing key.
    const harnessed = await started();
    const served = await serve(harnessed);
    if (open !== null) open.served = served;

    const onThePage = await asTheOwner(harnessed).disableKey("mk_nobody_was_issued");
    const atTheDoor = await served.call("POST", "/v0/keys/mk_nobody_was_issued/disable", {
      headers: { authorization: `Bearer ${harnessed.merchant.key}` },
    });

    const refused = (atTheDoor.body as { error: { code: string; message: string } }).error;
    expect(onThePage).toStrictEqual({
      ok: false,
      status: atTheDoor.status,
      code: refused.code,
      why: refused.message,
    });
    expect(refused.code).toBe("no_such_key");
  });

  it("answers an order of another merchant's as one that is not there", async () => {
    // The same answer an unknown identifier gets, so reading orders does not
    // reveal what somebody else sold.
    const harnessed = await started();
    const other = await harnessed.addMerchant();
    const theirs = await aPaidOrder(harnessed, other.id);

    const read = await asTheOwner(harnessed).getOrder(theirs);

    expect(read).toStrictEqual({
      ok: false,
      status: 404,
      code: "no_such_order",
      why: "there is no such order",
    });
    const asTheirs = gatewayFor(harnessed.gateway, {
      merchantId: other.id,
      email: "other@example.com",
    });
    expect((await asTheirs.getOrder(theirs)).ok).toBe(true);
  });
});

describe("a wallet change the gateway would not record", () => {
  // Nothing was written in any case. A merchant who has read a message about a
  // change must not be told nothing was sent, and one who has none must not be
  // sent looking for it.
  const ANOTHER_WALLET = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

  it("says there is nobody to tell where no account names the merchant", async () => {
    const harnessed = await started(LIVE);
    harnessed.announcer.answer = "nobody_to_tell";

    const refused = await asTheOwner(harnessed).setPayoutWallet(A_WALLET);

    expect(refused).toMatchObject({ ok: false, status: 409 });
    expect(refused.ok ? "" : refused.why).toMatch(/nobody to tell/);
    expect((await harnessed.store.merchantById(harnessed.merchant.id))?.payoutWallet.address).toBe(
      harnessed.merchant.wallet,
    );
  });

  it("says a message may still have arrived when telling did not finish", async () => {
    const harnessed = await started(LIVE);
    harnessed.announcer.answer = "not_handed_over";

    const refused = await asTheOwner(harnessed).setPayoutWallet(A_WALLET);

    expect(refused).toMatchObject({ ok: false, status: 503 });
    expect(refused.ok ? "" : refused.why).toMatch(/may still have received it/);
  });

  it("says its message went out when another change overtook it while it was told", async () => {
    const harnessed = await started(LIVE);
    let nested = false;
    harnessed.announcer.answer = async () => {
      if (!nested) {
        nested = true;
        await harnessed.gateway.setPayoutWallet(harnessed.merchant.id, ANOTHER_WALLET, {
          kind: "signed_in",
          email: "partner@example.com",
        });
      }
      return "handed_over";
    };

    const refused = await asTheOwner(harnessed).setPayoutWallet(A_WALLET);

    expect(refused).toMatchObject({ ok: false, status: 409 });
    expect(refused.ok ? "" : refused.why).toMatch(/its message went out/);
  });

  it("claims no message when a first address was overtaken before anything was told", async () => {
    const harnessed = await started(LIVE);
    const fresh = await harnessed.gateway.registerMerchant();
    const writing = harnessed.store.setPayoutWallet.bind(harnessed.store);
    let overtaken = false;
    harnessed.store.setPayoutWallet = async (id, expected, next, when) => {
      if (!overtaken) {
        overtaken = true;
        await writing(
          id,
          expected,
          {
            address: ANOTHER_WALLET,
            split: payoutSplitFor(harnessed.runtime.config.payoutSplit, id, ANOTHER_WALLET),
            pending: null,
          },
          when,
        );
      }
      return await writing(id, expected, next, when);
    };

    const refused = await gatewayFor(harnessed.gateway, {
      merchantId: fresh,
      email: OWNER,
    }).setPayoutWallet(A_WALLET);

    expect(refused).toMatchObject({ ok: false, status: 409 });
    expect(refused.ok ? "" : refused.why).not.toMatch(/message/i);
  });
});

describe("late goods", () => {
  it("are delivered to the order they name, which then has them", async () => {
    const harnessed = await started();
    const orderId = await aPaidOrder(harnessed, harnessed.merchant.id);
    await workOnce(harnessed, { onOrder: () => ({ accepted: {} }) });

    const delivered = await asTheOwner(harnessed).deliverOrder(orderId, {
      activation_code: "LPA:1$X",
    });

    expect(delivered).toStrictEqual({ ok: true, document: { ok: true, result: "delivered" } });
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("delivered");
  });
});

describe("a call that does not finish", () => {
  it("is given up on at its deadline, saying what was asked may have been done", async () => {
    // The work behind it is not stopped (a late database still writes), so the
    // page must not say nothing happened.
    const harnessed = await started();
    const client = gatewayFor(
      silenced(harnessed.gateway),
      { merchantId: harnessed.merchant.id, email: OWNER },
      50,
    );

    const answered = await client.setSelling(false);

    expect(answered.ok).toBe(false);
    expect(answered.ok ? 0 : answered.status).toBe(0);
    expect(answered.ok ? "" : answered.why).toMatch(
      /did not answer.*may or may not have been done/,
    );
  });

  it("is not answered for when it fails in our own code, since it may have failed after the work", async () => {
    // Turned into a refusal here, it would have to say what was or was not
    // done, which nobody knows.
    const harnessed = await started();
    const client = gatewayFor(
      answering(harnessed.gateway, "setSelling", () => {
        throw new Error("the database went away after the write");
      }),
      { merchantId: harnessed.merchant.id, email: OWNER },
    );

    await expect(client.setSelling(false)).rejects.toThrow(/database went away/);
  });

  it("does not hand a page a document the contract would not recognise", async () => {
    const harnessed = await started();
    const client = gatewayFor(
      answering(harnessed.gateway, "merchantCards", () => ({ cards: [{ not: "a card" }] })),
      { merchantId: harnessed.merchant.id, email: OWNER },
    );

    await expect(client.cards()).rejects.toThrow();
  });
});

describe("who asks", () => {
  it("is named in the message about a wallet change by the account the session is signed in as", async () => {
    const harnessed = await started(LIVE);

    const asked = await asTheOwner(harnessed).setPayoutWallet(A_WALLET);

    expect(asked.ok).toBe(true);
    expect(harnessed.announcer.announced).toMatchObject([
      { kind: "wallet_change", asked_with: { kind: "signed_in", email: OWNER } },
    ]);
  });

  it("is named in the message about a new key the same way", async () => {
    const harnessed = await started(LIVE);

    const issued = await asTheOwner(harnessed).issueKey("the stock worker");

    expect(issued.ok).toBe(true);
    // The message about a key is sent after it is issued and never waited on.
    await new Promise((settled) => setImmediate(settled));
    expect(harnessed.announcer.announced).toMatchObject([
      { kind: "key_issued", asked_with: { kind: "signed_in", email: OWNER } },
    ]);
  });

  it("holds no key, so it can disable the one the merchant's own code is calling with", async () => {
    const harnessed = await started();

    const disabled = await asTheOwner(harnessed).disableKey(harnessed.merchant.keyId);

    expect(disabled.ok).toBe(true);
    expect(disabled.ok ? disabled.document.disabled_at : null).not.toBeNull();
  });
});

describe("where an order's payment went", () => {
  // The order documents never name the address a payment went to, so the
  // screens and the shop's order lines ask in-process for the split an order
  // was paid into, as the registry recorded it.

  /** An order quoted and not paid yet. */
  const aQuotedOrder = async (harnessed: Harness): Promise<string> => {
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, AN_ESIM);
    if (!published.ok) throw new Error(`the card was refused: ${JSON.stringify(published)}`);
    const offered = await harnessed.gateway.beginPurchase(published.id, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    return offered.order.order.id;
  };

  const splitInForce = async (harnessed: Harness) =>
    (await harnessed.store.merchantById(harnessed.merchant.id))?.payoutWallet.split ?? null;

  it("names the split an order's payment was checked against, and none for one paid to the wallet itself", async () => {
    const harnessed = await started();
    const intoTheSplit = await aPaidOrder(harnessed, harnessed.merchant.id);
    // As a gateway of the release before splits kept it: the wallet itself.
    const intoTheWallet = await aQuotedOrder(harnessed);
    await harnessed.gateway.runner.presentVerifiedPayment(
      intoTheWallet,
      "alice",
      "PAY-A",
      harnessed.merchant.wallet,
      harnessed.now(),
    );
    const split = await splitInForce(harnessed);
    expect(split).not.toBeNull();
    const client = asTheOwner(harnessed);

    expect(await client.paidInto(intoTheSplit)).toStrictEqual({ ok: true, document: split });
    expect(await client.paidInto(intoTheWallet)).toStrictEqual({ ok: true, document: null });
    expect(await client.paidIntoSplits()).toStrictEqual({
      ok: true,
      document: { [intoTheSplit]: split },
    });
  });

  it("names the split the payment went to after the merchant moved their wallet, not the one in force now", async () => {
    const harnessed = await started();
    const before = await splitInForce(harnessed);
    const orderId = await aPaidOrder(harnessed, harnessed.merchant.id);
    const client = asTheOwner(harnessed);
    expect((await client.setPayoutWallet(A_WALLET)).ok).toBe(true);
    const after = await splitInForce(harnessed);
    expect(after?.address).not.toBe(before?.address);

    expect(await client.paidInto(orderId)).toStrictEqual({ ok: true, document: before });
    expect(await client.paidIntoSplits()).toStrictEqual({
      ok: true,
      document: { [orderId]: before },
    });
  });

  it("counts no share for an order whose charge did not go through", async () => {
    // Its payment was checked against the split, so the shop's line names it,
    // but no money reached the split, and a share of it would be a share of
    // nothing.
    const harnessed = await started();
    harnessed.facilitator.willSettle({ settled: false, reason: "refused in the script" });
    const orderId = await aPaidOrder(harnessed, harnessed.merchant.id);
    const client = asTheOwner(harnessed);

    expect(await client.paidInto(orderId)).toStrictEqual({
      ok: true,
      document: await splitInForce(harnessed),
    });
    expect(await client.paidIntoSplits()).toStrictEqual({ ok: true, document: {} });
  });

  it("names no split for an order not paid yet", async () => {
    const harnessed = await started();
    const quoted = await aQuotedOrder(harnessed);

    expect(await asTheOwner(harnessed).paidInto(quoted)).toStrictEqual({
      ok: true,
      document: null,
    });
    expect(await asTheOwner(harnessed).paidIntoSplits()).toStrictEqual({ ok: true, document: {} });
  });

  it("answers for another merchant's order as one that is not there", async () => {
    const harnessed = await started();
    const other = await harnessed.addMerchant();
    const theirs = await aPaidOrder(harnessed, other.id);

    expect(await asTheOwner(harnessed).paidInto(theirs)).toStrictEqual({
      ok: false,
      status: 404,
      code: "no_such_order",
      why: "there is no such order",
    });
    expect(await asTheOwner(harnessed).paidIntoSplits()).toStrictEqual({ ok: true, document: {} });
  });
});

describe("the payout a merchant is shown", () => {
  /** Saves a new wallet, as the test channel applies it at once, and sells once into its split. */
  const paidInto = async (harnessed: Harness, wallet: string): Promise<void> => {
    expect((await asTheOwner(harnessed).setPayoutWallet(wallet)).ok).toBe(true);
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, AN_ESIM);
    if (!published.ok) throw new Error(`the card was refused: ${JSON.stringify(published)}`);
    const offered = await harnessed.gateway.beginPurchase(published.id, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    // A payment of its own each time: a payment presented twice is a replay.
    await harnessed.gateway.payPurchase(offered.order.order.id, `PAY-${wallet}`, `PAY-${wallet}`);
  };

  /** The nth wallet, all digits so it is its own checksum. */
  const walletNumber = (n: number): string => `0x${(1_000 + n).toString().padStart(40, "0")}`;

  it("pays out every split that can hold the merchant's money in one transaction, up to the most one carries", async () => {
    const harnessed = await started();
    // The wallet the merchant started with was never paid into, so its split
    // holds nothing; each of these holds one sale.
    for (let n = 1; n <= SPLITS_PER_PAYOUT; n += 1) {
      await paidInto(harnessed, walletNumber(n));
    }

    const read = await asTheOwner(harnessed).payoutSplits();

    const payout = read.ok ? read.document.payout : null;
    expect(
      typeof payout === "object" && payout !== null && "splits" in payout ? payout.splits : [],
    ).toHaveLength(SPLITS_PER_PAYOUT);
  });

  it("says how many there are, and builds no transaction, past the most one carries", async () => {
    const harnessed = await started();
    for (let n = 1; n <= SPLITS_PER_PAYOUT + 1; n += 1) {
      await paidInto(harnessed, walletNumber(n));
    }

    const read = await asTheOwner(harnessed).payoutSplits();

    expect(read.ok ? read.document.payout : null).toStrictEqual({
      tooMany: SPLITS_PER_PAYOUT + 1,
    });
  });

  it("has no payout, and no split, for a merchant with no wallet", async () => {
    const harnessed = await started();
    const none = await harnessed.gateway.registerMerchant();

    const read = await gatewayFor(harnessed.gateway, {
      merchantId: none,
      email: OWNER,
    }).payoutSplits();

    expect(read).toMatchObject({
      ok: true,
      document: { inForce: null, pending: null, payout: null },
    });
  });
});

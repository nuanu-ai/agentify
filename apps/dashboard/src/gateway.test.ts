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

import { UNKNOWN } from "@agentify/core";
import {
  type Gateway,
  type PayoutCheck,
  type PayoutTransaction,
  payoutSplitFor,
  SPLITS_PER_PAYOUT,
} from "@agentify/gateway";
import {
  type Harness,
  harness,
  loggedWhile,
  type Served,
  serve,
  workOnce,
  workUntilStopped,
} from "@agentify/gateway/testing";
import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const started = async (overrides: Record<string, string> = {}, payoutCheck?: PayoutCheck) => {
  const harnessed = await harness(overrides, payoutCheck === undefined ? {} : { payoutCheck });
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
    // A merchant on the cards screen and their engineer reading the API are
    // told the same thing about a missing product.
    const harnessed = await started();
    const served = await serve(harnessed);
    if (open !== null) open.served = served;

    const onThePage = await asTheOwner(harnessed).pauseCard("item_nobody_published", true);
    const atTheDoor = await served.call("POST", "/v0/cards/item_nobody_published/pause", {
      headers: { authorization: `Bearer ${harnessed.merchant.key}` },
    });

    const refused = (atTheDoor.body as { error: { code: string; message: string } }).error;
    expect(onThePage).toStrictEqual({
      ok: false,
      status: atTheDoor.status,
      code: refused.code,
      why: refused.message,
    });
    expect(refused.code).toBe("no_such_item");
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

describe("the orders a page reads", () => {
  it("carry the order's identifier and never the buyer's key, which opens its goods", async () => {
    // The dashboard shows the merchant and their staff everything about an
    // order, and the key is the one thing about it that is the buyer's alone.
    const harnessed = await started();
    const orderId = await aPaidOrder(harnessed, harnessed.merchant.id);
    await workOnce(harnessed, { onOrder: () => ({ accepted: {} }) });
    const owner = asTheOwner(harnessed);
    await owner.deliverOrder(orderId, { activation_code: "LPA:1$X" });
    const key = (await harnessed.store.orderById(orderId))?.buyerKey ?? "";
    expect(key).not.toBe("");
    // A purchase priced and never paid, ended when its price ran out: the
    // Lapsed list reads it apart from the orders.
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, AN_ESIM);
    if (!published.ok) throw new Error("the card was refused");
    const offered = await harnessed.gateway.beginPurchase(published.id, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const lapsedId = offered.order.order.id;
    harnessed.advance(31_000);
    await harnessed.gateway.runner.apply(lapsedId, {
      kind: "deadline_expired",
      at: harnessed.now(),
      deadline: "quote_expiry",
    });
    const lapsedKey = (await harnessed.store.orderById(lapsedId))?.buyerKey ?? "";
    expect(lapsedKey).not.toBe("");

    const read = JSON.stringify([
      await owner.lapsedAttempts(1),
      await owner.orders(false),
      await owner.orders(true),
      await owner.getOrder(orderId),
      await owner.receipts(),
      await owner.ordersWithRecords(),
      await owner.paidIntoSplits(),
    ]);

    expect(read).toContain(orderId);
    expect(read).toContain(lapsedId);
    expect(read).not.toContain(key);
    expect(read).not.toContain(lapsedKey);
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

  it("is logged, when it fails after the page stopped waiting, by what failed and nothing the failure carried", async () => {
    // A failure's words can quote an order's identifier, which opens the order
    // to whoever reads the log.
    const orderId = "ord_7c1e05a9c4d84f0b9e2d6c3b1a8f5e47";
    const harnessed = await started();
    const client = gatewayFor(
      answering(harnessed.gateway, "setSelling", async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw new Error(`the order ${orderId} will not be written down`);
      }),
      { merchantId: harnessed.merchant.id, email: OWNER },
      20,
    );

    const written = await loggedWhile(async () => {
      await client.setSelling(false);
      await vi.waitFor(() => {
        expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain("after the page");
      });
    });

    expect(written).toContain("stopping the selling failed after the page stopped waiting");
    expect(written).toContain("Error");
    expect(written).not.toContain(orderId);
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

describe("the orders a page reads", () => {
  /** A room bought in the answer, priced for a purchase nobody paid for. */
  const A_ROOM: Card = {
    merchant_item_id: "room-101",
    title: "A room for the night",
    description: "One night in room 101",
    price: { amount: "80.00", currency: "USD" },
    result: { access_code: { type: "string" } },
    fulfillment: "sync",
  };

  /** A purchase priced and never paid, ended when its price ran out. */
  const lapsedUnpaid = async (harnessed: Harness, itemId: string): Promise<string> => {
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error(`no price was named: ${offered.step}`);
    harnessed.advance(31_000);
    await harnessed.gateway.runner.apply(offered.order.order.id, {
      kind: "deadline_expired",
      at: harnessed.now(),
      deadline: "quote_expiry",
    });
    return offered.order.order.id;
  };

  it("leave out the purchases that lapsed unpaid, which are read apart a page at a time, newest first", async () => {
    const harnessed = await started();
    const client = asTheOwner(harnessed);
    const paid = await aPaidOrder(harnessed, harnessed.merchant.id);
    const room = await harnessed.gateway.publishCard(harnessed.merchant.id, A_ROOM);
    if (!room.ok) throw new Error("the room was refused");
    const older = await lapsedUnpaid(harnessed, room.id);
    const newer = await lapsedUnpaid(harnessed, room.id);
    // A purchase the merchant's price check refused, which never had a price.
    const priced = await harnessed.gateway.publishCard(harnessed.merchant.id, {
      ...A_ROOM,
      merchant_item_id: "room-102",
      price_check: "handler",
    });
    if (!priced.ok) throw new Error("the priced room was refused");
    harnessed.advance(1_000);
    const askedAt = new Date(harnessed.now()).toISOString();
    const worker = workUntilStopped(harnessed, {
      onQuote: () => ({ available: false, as_of: "2026-08-26T12:00:00.000Z" }),
    });
    const unpriced = await harnessed.gateway.beginPurchase(priced.id, {});
    await worker.stop();
    if (unpriced.step !== "settled")
      throw new Error(`the refusal did not end it: ${unpriced.step}`);

    const idsIn = (answer: Awaited<ReturnType<typeof client.orders>>) =>
      answer.ok ? answer.document.orders.map((order) => order.id) : answer.why;
    expect(idsIn(await client.orders(false))).toStrictEqual([paid]);
    expect(idsIn(await client.orders(true))).toStrictEqual([paid]);
    const page = await client.lapsedAttempts(1);
    expect(page.ok ? page.document.of : page.why).toBe(3);
    expect(page.ok ? page.document.attempts.map((attempt) => attempt.id) : []).toStrictEqual([
      unpriced.order.order.id,
      newer,
      older,
    ]);
    expect(page.ok ? page.document.attempts[0]?.price : undefined).toBeNull();
    // Asked for, and never priced: no moment stands in for the price's.
    expect(page.ok ? page.document.attempts[0]?.asked_at : undefined).toBe(askedAt);
    expect(page.ok ? page.document.attempts[0]?.priced_at : undefined).toBeNull();
    expect(page.ok ? page.document.attempts[1]?.priced_at : undefined).toEqual(expect.any(String));
    expect(await client.lapsedCount()).toStrictEqual({ ok: true, document: 3 });
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
      typeof payout === "object" && payout !== null && "transaction" in payout
        ? payout.transaction.splits
        : [],
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

describe("what the payout a merchant is shown would bring", () => {
  /**
   * A chain that answers every payout with `brings`, and keeps each payout it
   * was asked about and the time the page gave it.
   */
  const aChain = (brings: (withinMs: number) => Promise<bigint>) => {
    const asked: PayoutTransaction[] = [];
    const given: number[] = [];
    const check: PayoutCheck = {
      wouldBring: (payout, withinMs) => {
        asked.push(payout);
        given.push(withinMs);
        return brings(withinMs);
      },
    };
    return { check, asked, given };
  };

  /** A chain that never answers, given up on once the page's time for it has passed, as the port promises. */
  const hanging = (withinMs: number): Promise<bigint> =>
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("the chain did not answer in time")),
        Math.max(0, withinMs),
      );
    });

  /** The gateway with the merchant's splits read only after `ms`, as from a slow database. */
  const slowSplits = (application: Gateway, ms: number): Gateway =>
    new Proxy(application, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "payoutSplitsOf" && typeof value === "function") {
          return async (...args: unknown[]) => {
            await new Promise((resolve) => setTimeout(resolve, ms));
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  const shown = async (harnessed: Harness, answerWithinMs?: number) => {
    const read = await asTheOwner(harnessed, answerWithinMs).payoutSplits();
    const payout = read.ok ? read.document.payout : null;
    if (typeof payout !== "object" || payout === null || !("transaction" in payout)) {
      throw new Error(`no payout to send was shown: ${JSON.stringify(read)}`);
    }
    return payout;
  };

  it("is what the chain says sending the very transaction shown would bring", async () => {
    const chain = aChain(async () => 12_345_678n);
    const harnessed = await started({}, chain.check);

    const payout = await shown(harnessed);

    expect(payout.brings).toBe(12_345_678n);
    expect(chain.asked).toStrictEqual([payout.transaction]);
  });

  it("is nothing where the chain says the payout would bring nothing", async () => {
    const harnessed = await started({}, aChain(async () => 0n).check);

    expect((await shown(harnessed)).brings).toBe(0n);
  });

  it("is not known, rather than nothing, where the chain could not be asked", async () => {
    const harnessed = await started(
      {},
      aChain(async () => {
        throw new Error("the chain endpoint did not answer");
      }).check,
    );

    expect((await shown(harnessed)).brings).toBe(UNKNOWN);
  });

  it("is not known where no chain endpoint is configured", async () => {
    const harnessed = await started();

    expect((await shown(harnessed)).brings).toBe(UNKNOWN);
  });

  it("is not known once the chain has taken half the page's deadline, and the page is still drawn", async () => {
    // The rest of Settings, the control that signs every other device out
    // among it, must not wait on a chain endpoint that hangs.
    const chain = aChain(hanging);
    const harnessed = await started({}, chain.check);

    expect((await shown(harnessed, 400)).brings).toBe(UNKNOWN);
    expect(chain.given[0]).toBeGreaterThan(0);
    expect(chain.given[0]).toBeLessThanOrEqual(200);
  });

  it("is not known once half the page's deadline has passed, even from a chain that ignores the time it was given", async () => {
    // Sign-out-everywhere lives on the same page, which must never wait on a
    // check that does not keep to its time.
    const harnessed = await started({}, aChain(() => new Promise(() => undefined)).check);

    expect((await shown(harnessed, 400)).brings).toBe(UNKNOWN);
  });

  it("gets only what is left of half the page's deadline once the splits were read, so a slow database and a slow chain together still leave the page drawn", async () => {
    const chain = aChain(hanging);
    const harnessed = await started({}, chain.check);
    const client = gatewayFor(
      slowSplits(harnessed.gateway, 300),
      { merchantId: harnessed.merchant.id, email: OWNER },
      400,
    );

    const read = await client.payoutSplits();

    expect(read.ok).toBe(true);
    expect(chain.given.every((ms) => ms <= 0)).toBe(true);
    const payout = read.ok ? read.document.payout : null;
    expect(
      typeof payout === "object" && payout !== null && "brings" in payout && payout.brings,
    ).toBe(UNKNOWN);
  });

  it("is not asked of the chain where there is no transaction to send", async () => {
    const chain = aChain(async () => 1n);
    const harnessed = await started({}, chain.check);
    const none = await harnessed.gateway.registerMerchant();

    await gatewayFor(harnessed.gateway, { merchantId: none, email: OWNER }).payoutSplits();

    expect(chain.asked).toStrictEqual([]);
  });
});

describe("what an order's record says beside its document", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const HOUR = 3_600_000;

  /** The records read beside the orders, in one read with them. */
  const recordsOf = async (client: ReturnType<typeof asTheOwner>) => {
    const read = await client.ordersWithRecords();
    if (!read.ok) throw new Error(`the orders were not read: ${read.why}`);
    return read.document.records;
  };

  /** A charge at purchase that nobody answered, so the order waits on its payment. */
  const unanswered = async (harnessed: Harness): Promise<string> => {
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, AN_ESIM);
    if (!published.ok) throw new Error("the card was refused");
    const offered = await harnessed.gateway.beginPurchase(published.id, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
    return offered.order.order.id;
  };

  const attemptOf = async (harnessed: Harness, id: string): Promise<string> => {
    const attempt = (await harnessed.store.orderById(id))?.paymentAttempt;
    if (attempt === undefined) throw new Error("the payment attempt is missing");
    return attempt.id;
  };

  it("names when a paid order's money moved and when its delivery deadline falls, and whether its passing left the order unfulfilled", async () => {
    const harnessed = await started();
    const client = asTheOwner(harnessed);
    const paidAt = harnessed.now();
    const id = await aPaidOrder(harnessed, harnessed.merchant.id);

    const running = await recordsOf(client);
    harnessed.advance(HOUR);
    await harnessed.gateway.runner.apply(id, {
      kind: "deadline_expired",
      at: harnessed.now(),
      deadline: "async_fulfillment",
    });
    const passed = await recordsOf(client);

    expect(running).toStrictEqual({
      [id]: {
        unfulfilled: null,
        paidAt: iso(paidAt),
        deadline: { at: iso(paidAt + HOUR), passed: false },
        soldThrough: "api",
      },
    });
    expect(passed).toStrictEqual({
      [id]: {
        unfulfilled: "deadline_passed",
        paidAt: iso(paidAt),
        deadline: { at: iso(paidAt + HOUR), passed: true },
        soldThrough: "api",
      },
    });
  });

  it("are read in the same read as the orders they describe", async () => {
    const harnessed = await started();
    const client = asTheOwner(harnessed);
    const id = await aPaidOrder(harnessed, harnessed.merchant.id);

    const read = await client.ordersWithRecords();

    expect(read.ok ? read.document.orders.orders.map((order) => order.id) : read.why).toStrictEqual(
      [id],
    );
    expect(read.ok ? Object.keys(read.document.records) : []).toStrictEqual([id]);
  });

  it("names when the money moved for an order charged after its goods as its receipt does, not when its payment was checked", async () => {
    const harnessed = await started();
    const client = asTheOwner(harnessed);
    const room = await harnessed.gateway.publishCard(harnessed.merchant.id, {
      merchant_item_id: "room-101",
      title: "A room for the night",
      description: "One night in room 101",
      price: { amount: "80.00", currency: "USD" },
      result: { access_code: { type: "string" } },
      fulfillment: "sync",
    });
    if (!room.ok) throw new Error("the room was refused");
    const worker = workUntilStopped(harnessed, {
      onOrder: () => {
        // The goods take two seconds, so the charge settles after the payment was checked.
        harnessed.advance(2_000);
        return { delivered: { access_code: "SESAME" } };
      },
    });
    const offered = await harnessed.gateway.beginPurchase(room.id, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const checkedAt = harnessed.now();
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
    await worker.stop();
    const id = offered.order.order.id;
    const receipts = await client.receipts();
    const receipt = receipts.ok
      ? receipts.document.receipts.find((one) => one.order_id === id)
      : undefined;

    const record = (await recordsOf(client))[id];

    expect(receipt?.paid_at).toBe(iso(checkedAt + 2_000));
    expect(record).toStrictEqual({
      unfulfilled: null,
      paidAt: receipt?.paid_at,
      deadline: null,
      soldThrough: "api",
    });
  });

  it("names when the money moved for a charge confirmed after Agentify stopped waiting, as the chain recorded it", async () => {
    const harnessed = await started();
    const client = asTheOwner(harnessed);
    const id = await unanswered(harnessed);
    harnessed.advance(HOUR);
    await harnessed.gateway.runner.apply(id, {
      kind: "deadline_expired",
      at: harnessed.now(),
      deadline: "settle_response",
    });
    const executedAt = harnessed.now() - 30_000;
    harnessed.advance(HOUR);
    await harnessed.gateway.runner.completePaymentAttempt(
      id,
      await attemptOf(harnessed, id),
      { settled: true, transaction: `0x${"ab".repeat(32)}`, executedAt },
      "chain",
    );

    expect((await recordsOf(client))[id]).toStrictEqual({
      unfulfilled: "charge_confirmed_late",
      paidAt: iso(executedAt),
      deadline: null,
      soldThrough: "api",
    });
  });

  it("names when the money moved for an order paid after its merchant closed it", async () => {
    const harnessed = await started();
    const client = asTheOwner(harnessed);
    const id = await unanswered(harnessed);
    expect((await client.closeOrder(id, { message: "Payment did not arrive." })).ok).toBe(true);
    harnessed.advance(HOUR);
    const completedAt = harnessed.now();
    await harnessed.gateway.runner.completePaymentAttempt(
      id,
      await attemptOf(harnessed, id),
      { settled: true, transaction: "late-transaction" },
      "facilitator",
    );

    expect((await recordsOf(client))[id]).toStrictEqual({
      unfulfilled: null,
      paidAt: iso(completedAt),
      deadline: null,
      soldThrough: "api",
    });
  });

  it("names the integration a sale was made through, which is the shop's for a card the connector published", async () => {
    const harnessed = await started();
    const client = asTheOwner(harnessed);
    expect((await client.sellThrough("woocommerce")).ok).toBe(true);
    const published = await harnessed.gateway.publishCard(
      harnessed.merchant.id,
      AN_ESIM,
      "woocommerce",
    );
    if (!published.ok) throw new Error(`the card was refused: ${JSON.stringify(published)}`);
    const offered = await harnessed.gateway.beginPurchase(published.id, {});
    if (offered.step !== "pay") throw new Error(`no price was offered: ${offered.step}`);
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    expect((await recordsOf(client))[offered.order.order.id]?.soldThrough).toBe("woocommerce");
  });

  it("names no deadline for an order its merchant refused after payment, or one delivered", async () => {
    const harnessed = await started();
    const client = asTheOwner(harnessed);
    const refused = await aPaidOrder(harnessed, harnessed.merchant.id);
    await workOnce(harnessed, {
      onOrder: () => ({ refused: { code: "out_of_stock", message: "none left" } }),
    });
    const delivered = await aPaidOrder(harnessed, harnessed.merchant.id);
    await workOnce(harnessed, {
      onOrder: () => ({ delivered: { activation_code: "LPA:1$example$CODE" } }),
    });

    const read = await recordsOf(client);

    expect(read[refused]).toMatchObject({ unfulfilled: "refused", deadline: null });
    expect(read[delivered]).toMatchObject({ unfulfilled: null, deadline: null });
  });
});

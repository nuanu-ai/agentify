/**
 * The dashboard's way to the money path: the gateway's application, called
 * inside the process as the merchant on the signed-in account's row (ADR-0030).
 *
 * The screens are driven in `server.test.ts` over this client and the real
 * application. What is held here is what a page relies on and no screen test
 * can pin down by itself: that what goes in is held to the contract's request
 * schema before anything is done; that a refusal reaches a page in the words
 * and under the status the route at the door gives the same refusal; that a
 * call that does not finish is given up on at its deadline and said to be
 * possibly done, while a failure of ours is not dressed up as an answer; and
 * that the account a session is signed in as is the one a message names.
 *
 * The application is the real one on the gateway's in-memory harness, and the
 * route it is compared against is that harness's real HTTP surface.
 */

import type { Gateway } from "@agentify/gateway";
import { type Harness, harness, type Served, serve, workOnce } from "@agentify/gateway/testing";
import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayFor } from "./gateway.js";

/** What makes a harness live: Base mainnet and its one facilitator. */
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

/** The client of the harness's merchant, as its owner's session. */
const asTheOwner = (harnessed: Harness, answerWithinMs?: number) =>
  gatewayFor(
    harnessed.gateway,
    { merchantId: harnessed.merchant.id, email: OWNER },
    answerWithinMs,
  );

/** A card whose goods arrive after the purchase, which is the kind late goods are for. */
const AN_ESIM: Card = {
  merchant_item_id: "esim-7d",
  title: "A seven day eSIM",
  description: "Seven days of data",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
};

/** A paid order of this merchant's for that card, and its identifier. */
const aPaidOrder = async (harnessed: Harness, merchantId: string): Promise<string> => {
  const published = await harnessed.gateway.publishCard(merchantId, AN_ESIM);
  if (!published.ok) throw new Error(`the card was refused: ${JSON.stringify(published)}`);
  const offered = await harnessed.gateway.beginPurchase(published.id, {});
  if (offered.step !== "pay") throw new Error("no price was offered");
  await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
  return offered.order.order.id;
};

/** The application with every call it is asked to make waiting for good. */
const silenced = (application: Gateway): Gateway =>
  new Proxy(application, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? () => new Promise(() => undefined) : value;
    },
  });

/** The application with one call answered the way a test says. */
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
    // The page checks the address before sending it; this is the second line,
    // and it says what the contract says rather than something of its own.
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
    // One fact, two readers: a merchant on the wallet screen and their
    // engineer reading the API are told the same thing. On the live
    // deployment no account names this merchant, so there is nobody to tell.
    const harnessed = await started(LIVE);
    harnessed.announcer.answer = "nobody_to_tell";
    const served = await serve(harnessed);
    if (open !== null) open.served = served;
    const dashboardKey = await harnessed.addDashboardKey(harnessed.merchant.id);

    const onThePage = await asTheOwner(harnessed).setPayoutWallet(A_WALLET);
    const atTheDoor = await served.call("POST", "/v0/payout-wallet", {
      body: { payout_wallet: A_WALLET },
      headers: { authorization: `Bearer ${dashboardKey}` },
    });

    const refused = (atTheDoor.body as { error: { code: string; message: string } }).error;
    expect(onThePage).toStrictEqual({
      ok: false,
      status: atTheDoor.status,
      code: refused.code,
      why: refused.message,
    });
    expect(refused.code).toBe("wallet_change_nobody_to_tell");
  });

  it("answers an order of another merchant's as one that is not there", async () => {
    // The same answer an identifier naming nothing gets, so reading orders is
    // not a way of finding out what somebody else sold.
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

describe("late goods", () => {
  it("are delivered to the order they name, which then has them", async () => {
    // What `woo:recover` does for an order whose goods the shop owed.
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
    // The work behind it is not stopped: a database that answers late still
    // writes. So the page must not say nothing happened.
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
    // A thrown error goes on to the page's own handler, which says something in
    // the dashboard is broken; turned into a refusal here it would have to say
    // what was or was not done, which nobody knows.
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

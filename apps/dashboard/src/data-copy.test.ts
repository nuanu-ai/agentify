/**
 * A copy of the data held about one address, as the dashboard answers the
 * scanner's request for one: what it holds is the account, its sign-ins and
 * the merchant the account names, read from the in-memory identity rows and
 * the gateway's in-memory store; it goes to that address and no other, as a
 * file attached to the message.
 */

import { createHash } from "node:crypto";
import { type Harness, harness, workUntilStopped } from "@agentify/gateway/testing";
import type { SendDataCopyRequest } from "@agentify/scanner-contracts/report-identity";
import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copierFor, JOURNAL_ROWS_MAX, memoryPersonRecords } from "./data-copy.js";
import type { Handover, Message } from "./mail.js";
import { memoryWooShops } from "./woo-shops.js";

const OWNER = "owner@example.com";
const COLLEAGUE = "colleague@example.com";
const STRANGER = "stranger@example.com";
const BUYER = "buyer@example.com";
const REQUEST = "019b41a0-7c51-7d63-84bd-a5a20faef498";
const AT = new Date("2026-10-20T09:00:00.000Z");

/** Values that let whoever holds them act as somebody; none may appear in a copy. */
const SECRETS = {
  sessionToken: "session-token-that-signs-a-person-in",
  googleAccess: "ya29.google-access-token",
  googleRefresh: "1//google-refresh-token",
  googleId: "eyJ.google-id-token",
  password: "a-stored-password-hash",
  wooKey: "ck_the-shops-consumer-key",
  wooSecret: "cs_the-shops-consumer-secret",
  payment: "the-buyers-signed-authorisation",
  goods: "a-private-code-only-the-buyer-may-receive",
};

const A_CODE: Card = {
  merchant_item_id: "gift-code",
  title: "A gift code",
  description: "A code for the counter",
  price: { amount: "25.00", currency: "USD" },
  params: { email: { type: "string", required: true, title: "Where the code goes" } },
  result: { code: { type: "string" } },
  fulfillment: "sync",
};

let open: Harness | null = null;

afterEach(async () => {
  await open?.stop();
  open = null;
});

const account = (id: string, email: string, merchantId: string | null) => ({
  id,
  email,
  emailVerified: true,
  name: "",
  createdAt: AT,
  updatedAt: AT,
  merchantId,
  operator: false,
  analyticsOptOut: false,
});

const session = (id: string, userId: string, token: string, ipAddress: string) => ({
  id,
  token,
  userId,
  expiresAt: new Date("2026-11-19T09:00:00.000Z"),
  createdAt: AT,
  updatedAt: AT,
  ipAddress,
  userAgent: "Mozilla/5.0 Firefox/131.0",
  reportRequest: null,
});

/**
 * The owner and a colleague sign in to one merchant, which publishes a card a
 * buyer has bought; a stranger has a merchant of their own. An operator has
 * written about the owner's account and about the colleague's.
 */
async function aChannel() {
  const harnessed = await harness();
  open = harnessed;
  const merchantId = harnessed.merchant.id;
  const other = await harnessed.addMerchant("Somebody else");
  const rows: Record<string, Record<string, unknown>[]> = {
    dashboard_accounts: [
      { ...account("acc_owner", OWNER, merchantId), name: "Owner's shop" },
      account("acc_colleague", COLLEAGUE, merchantId),
      account("acc_stranger", STRANGER, other.id),
    ],
    dashboard_sessions: [
      session("ses_owner", "acc_owner", SECRETS.sessionToken, "203.0.113.7"),
      session("ses_colleague", "acc_colleague", "the-colleagues-token", "198.51.100.9"),
    ],
    dashboard_credentials: [
      {
        id: "cred_owner",
        userId: "acc_owner",
        providerId: "google",
        accountId: "google-subject-of-the-owner",
        issuer: "https://accounts.google.com",
        password: SECRETS.password,
        accessToken: SECRETS.googleAccess,
        refreshToken: SECRETS.googleRefresh,
        idToken: SECRETS.googleId,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scope: "openid email",
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    dashboard_verifications: [],
    dashboard_ad_reports: [
      {
        accountId: "acc_owner",
        event: "reg",
        clickId: null,
        state: "delivered",
        attempts: 1,
        nextAttemptAt: null,
        lastOutcome: "http_200",
        createdAt: AT,
        eventAt: AT,
        settledAt: AT,
      },
    ],
  };
  const wooShops = memoryWooShops();
  await wooShops.connect({
    accountId: "acc_owner",
    shopUrl: "https://shop.example",
    consumerKey: SECRETS.wooKey,
    consumerSecret: SECRETS.wooSecret,
    permissions: "read_write",
    revision: "revision-1",
    connectedAt: AT,
    currency: null,
  });
  const published = await harnessed.gateway.publishCard(merchantId, A_CODE);
  if (!published.ok) throw new Error(`the card was refused: ${JSON.stringify(published)}`);
  const offered = await harnessed.gateway.beginPurchase(published.id, { email: BUYER });
  if (offered.step !== "pay") throw new Error("no price was offered");
  // Keep real private payment and goods on the stored order: the export must omit them.
  harnessed.facilitator.willSettle({ settled: false, reason: "payment failed" });
  const worker = workUntilStopped(harnessed, {
    onOrder: () => ({ delivered: { code: SECRETS.goods } }),
  });
  try {
    await harnessed.gateway.payPurchase(
      offered.order.priceOffer.stamp,
      SECRETS.payment,
      "fp-data-copy-buyer",
      undefined,
      { itemId: published.id, params: { email: BUYER } },
    );
  } finally {
    await worker.stop();
  }
  const order = await harnessed.store.orderById(offered.order.order.id);
  if (order === null) throw new Error("the paid purchase wrote no order");
  await harnessed.store.recordJournal({
    at: AT.getTime(),
    actor: { kind: "account", id: "acc_the_operator" },
    action: "end_sessions",
    subject: { kind: "account", id: "acc_owner" },
    reason: "The owner reported a lost laptop",
    outcome: { kind: "done" },
  });
  await harnessed.store.recordJournal({
    at: AT.getTime(),
    actor: { kind: "account", id: "acc_the_operator" },
    action: "end_sessions",
    subject: { kind: "account", id: "acc_colleague" },
    reason: "The colleague asked to be signed out",
    outcome: { kind: "done" },
  });
  const mails: Message[] = [];
  let handover: Handover = "accepted";
  const copy = copierFor(
    { people: memoryPersonRecords(rows), store: harnessed.store, wooShops },
    async (message) => {
      mails.push(message);
      return handover;
    },
    "https://agentify.ad/privacy#rights",
  );
  return {
    harnessed,
    rows,
    mails,
    order,
    other,
    handOver: (outcome: Handover) => {
      handover = outcome;
    },
    copy: (email = OWNER, scanner: Record<string, unknown> = {}) =>
      copy({
        operation: "copy",
        request: REQUEST,
        requested_at: AT.toISOString(),
        email,
        scanner,
      } as SendDataCopyRequest),
  };
}

/** The one attachment of the one message sent, read back as the person would open it. */
function attachedCopy(mails: readonly Message[]) {
  expect(mails).toHaveLength(1);
  const [attachment] = mails[0]?.attachments ?? [];
  if (attachment === undefined) throw new Error("the message carries no attachment");
  return { attachment, text: attachment.content, copy: JSON.parse(attachment.content) };
}

describe("a copy of an address's data", () => {
  it("is mailed to that address as a JSON file attached to the message", async () => {
    const channel = await aChannel();

    await expect(channel.copy(OWNER, { lead: { email: OWNER } })).resolves.toEqual({
      status: "accepted",
    });

    expect(channel.mails[0]?.to).toBe(OWNER);
    const { attachment, copy } = attachedCopy(channel.mails);
    expect(attachment.filename).toMatch(/^agentify-data-.+\.json$/);
    expect(attachment.contentType).toBe("application/json");
    expect(copy).toMatchObject({
      about: OWNER,
      request: REQUEST,
      requested_at: AT.toISOString(),
      scanner: { lead: { email: OWNER } },
    });
    // The message says what is attached, so a person whose client hides
    // attachments knows to look for one.
    expect(channel.mails[0]?.body).toContain(attachment.filename);
  });

  it("holds the person's account, sign-ins, merchant and what it publishes and sells", async () => {
    const channel = await aChannel();

    await channel.copy();

    const { copy } = attachedCopy(channel.mails);
    const dashboard = copy.dashboard;
    expect(dashboard.account).toMatchObject({
      id: "acc_owner",
      email: OWNER,
      name: "Owner's shop",
    });
    expect(dashboard.google_sign_in).toEqual([
      {
        issuer: "https://accounts.google.com",
        subject: "google-subject-of-the-owner",
        linked_at: AT.toISOString(),
      },
    ]);
    expect(dashboard.sessions).toEqual({
      total: 1,
      rows: [expect.objectContaining({ ip_address: "203.0.113.7", started_at: AT.toISOString() })],
    });
    expect(dashboard.ad_reports).toEqual([
      expect.objectContaining({ event: "reg", state: "delivered" }),
    ]);
    const merchant = dashboard.merchant;
    expect(merchant).toMatchObject({
      id: channel.harnessed.merchant.id,
      payout_wallet: channel.harnessed.merchant.wallet,
      woocommerce: { shop_url: "https://shop.example", permissions: "read_write" },
    });
    expect(merchant.keys).toEqual([
      expect.objectContaining({ id: channel.harnessed.merchant.keyId }),
    ]);
    expect(merchant.cards).toMatchObject({ total: 1, rows: [{ card: { title: "A gift code" } }] });
    expect(merchant.orders).toMatchObject({
      total: 1,
      rows: [{ id: channel.order.order.id, price: { amount: "25.00", currency: "USD" } }],
    });
    expect(merchant.payout_splits).toEqual([
      expect.objectContaining({ merchant_wallet: channel.harnessed.merchant.wallet }),
    ]);
    expect(dashboard.operator_journal).toMatchObject({
      total: 1,
      rows: [{ action: "end_sessions", reason: "The owner reported a lost laptop" }],
    });
  });

  it("holds nothing of anybody else: a colleague on the same merchant, a buyer or another merchant", async () => {
    const channel = await aChannel();

    await channel.copy();

    const { text } = attachedCopy(channel.mails);
    for (const theirs of [
      COLLEAGUE,
      "acc_colleague",
      "198.51.100.9",
      "The colleague asked to be signed out",
      // The operator who acted is another person, named only as an operator.
      "acc_the_operator",
      BUYER,
      STRANGER,
      channel.other.id,
      channel.other.wallet,
    ]) {
      expect(text, theirs).not.toContain(theirs);
    }
  });

  it("excludes stored credentials, the buyer's authorization, key and received goods", async () => {
    const channel = await aChannel();
    const { harnessed, order } = channel;
    const stored = await harnessed.store.orderById(order.order.id);
    expect(stored).toMatchObject({
      payment: SECRETS.payment,
      delivery: { code: SECRETS.goods },
      order: { state: "delivered_unpaid" },
      buyerKey: expect.any(String),
    });
    if (stored === null) throw new Error("the buyer's order was not persisted");
    expect(stored.buyerKey).not.toBe("");

    await channel.copy();

    const { text } = attachedCopy(channel.mails);
    for (const secret of [
      ...Object.values(SECRETS),
      channel.harnessed.merchant.key,
      // What the key table keeps of it.
      createHash("sha256").update(channel.harnessed.merchant.key).digest("hex"),
      stored.buyerKey,
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("of an address with no account says the dashboard holds no account for it", async () => {
    const channel = await aChannel();

    await channel.copy("nobody@example.com");

    expect(channel.mails[0]?.to).toBe("nobody@example.com");
    const { copy, text } = attachedCopy(channel.mails);
    expect(copy.dashboard).toEqual({ account: null });
    expect(text).not.toContain(OWNER);
  });

  it("says how many rows there are where it carries fewer than all of them", async () => {
    const channel = await aChannel();
    for (let index = 0; index < JOURNAL_ROWS_MAX + 1; index += 1) {
      await channel.harnessed.store.recordJournal({
        at: AT.getTime() + index,
        actor: { kind: "terminal" },
        action: "end_sessions",
        subject: { kind: "account", id: "acc_owner" },
        reason: null,
        outcome: { kind: "unchanged" },
      });
    }

    await channel.copy();

    const journal = attachedCopy(channel.mails).copy.dashboard.operator_journal;
    expect(journal.rows).toHaveLength(JOURNAL_ROWS_MAX);
    expect(journal.total).toBe(JOURNAL_ROWS_MAX + 2);
  });

  it("submits the same complete provider message and key when an unchanged request is retried", async () => {
    // The provider's deduplication requires the same key and the whole message.
    const channel = await aChannel();
    // The second try a minute after the first, by the wall clock: nothing in
    // the message may move with it.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-26T09:00:00.000Z"));
      await channel.copy();
      vi.setSystemTime(new Date("2026-10-26T09:01:00.000Z"));
      await channel.copy();
    } finally {
      vi.useRealTimers();
    }

    expect(channel.mails).toHaveLength(2);
    const [first, second] = channel.mails;
    expect(first?.idempotencyKey).toBe(`data-copy/${REQUEST}`);
    expect(second).toEqual(first);
  });

  it.each([
    ["refused", "the mail provider refused it"],
    ["unknown", "whether the mail provider took it is not known"],
  ] as const)("is answered %s where %s", async (handover, _where) => {
    const channel = await aChannel();
    channel.handOver(handover);

    await expect(channel.copy()).resolves.toEqual({ status: handover });
  });
});

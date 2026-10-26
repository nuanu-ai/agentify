/**
 * A person's copy of the data held about their address. The scanner asks for
 * it once the person, signed in as that address, has pressed for it; it sends
 * what its own database holds, and this adds what the dashboard's and the
 * gateway's tables hold and mails the whole to that address, as a JSON file
 * attached to the message. The address asked about and the address mailed are
 * one value, so a copy can reach nobody but the person it describes.
 *
 * Every field is chosen by name, never copied from a row whole, so a column
 * added later stays out until somebody decides it belongs here. What is left
 * out, and why, is written into the copy itself.
 */

import type { Store, StoredOrder } from "@agentify/gateway";
import type {
  SendDataCopyRequest,
  SendDataCopyResponse,
} from "@agentify/scanner-contracts/report-identity";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { Message, Postman } from "./mail.js";
import { transactionalEmailHtml } from "./mail-template.js";
import { accounts, adReports, credentials, sessions } from "./schema.js";
import type { WooShops } from "./woo-shops.js";

/** The most cards and orders a copy lists of a merchant; it says how many there are in all. */
const COPY_ROWS_MAX = 2_000;
/** The most journal rows a copy lists of an account and of a merchant, the journal's own page. */
export const JOURNAL_ROWS_MAX = 200;

/**
 * What a copy deliberately does not carry, in the words the person reads in
 * it. A credential lets whoever holds the copy act as the person or as their
 * shop, and a copy travels by email.
 */
const LEFT_OUT = [
  "Sign-in secrets: the session token, any password, and Google's tokens. Each would let whoever holds this file sign in as you.",
  "Your API keys and your WooCommerce shop's consumer key and secret. Agentify keeps only a fingerprint of an API key, and a shop key would give write access to your shop.",
  "Other people: colleagues who sign in to the same merchant, the buyers of your orders (what they typed, their addresses and payments, the key that opens their order) and the operator who acted on your account, who is named only as an operator.",
  "What a buyer received for an order, which can be a code or a download link that works for whoever holds it.",
  "Keyed fingerprints of your address and your browser, which mean nothing outside Agentify.",
  "The seller dashboard's product analytics events, which describe your merchant's sales together with its buyers' orders and leave Agentify only as keyed hashes; they are deleted within 37 days.",
  `In the dashboard part, lists longer than ${COPY_ROWS_MAX.toLocaleString("en-US")} cards or orders, or ${JOURNAL_ROWS_MAX} journal rows, carry the newest ones; "total" says how many there are in all.`,
];

const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : new Date(value as string | Date).toISOString();

const instant = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/** What the dashboard's own tables hold for one address, with every credential left out. */
interface PersonRecord {
  readonly accountId: string;
  readonly merchantId: string | null;
  readonly account: Readonly<Record<string, unknown>>;
  readonly google: readonly Readonly<Record<string, unknown>>[];
  readonly sessions: readonly Readonly<Record<string, unknown>>[];
  readonly adReports: readonly Readonly<Record<string, unknown>>[];
}

interface PersonRecords {
  /** Null where no account has this address. */
  of(email: string): Promise<PersonRecord | null>;
}

type Row = Readonly<Record<string, unknown>>;

const accountOf = (row: Row) => ({
  id: row.id,
  email: row.email,
  email_verified: row.emailVerified === true,
  name: row.name ?? "",
  created_at: iso(row.createdAt),
  updated_at: iso(row.updatedAt),
  operator: row.operator === true,
  analytics_opt_out: row.analyticsOptOut === true,
});

const googleOf = (row: Row) => ({
  issuer: row.issuer,
  subject: row.accountId,
  linked_at: iso(row.createdAt),
});

const sessionOf = (row: Row) => ({
  started_at: iso(row.createdAt),
  last_renewed_at: iso(row.updatedAt),
  expires_at: iso(row.expiresAt),
  ip_address: row.ipAddress ?? null,
  user_agent: row.userAgent ?? null,
});

const adReportOf = (row: Row) => ({
  event: row.event,
  state: row.state,
  click_id: row.clickId ?? null,
  attempts: row.attempts,
  last_outcome: row.lastOutcome ?? null,
  registered_at: iso(row.createdAt),
  event_at: iso(row.eventAt),
  settled_at: iso(row.settledAt),
});

const recordOf = (
  row: Row,
  related: Readonly<{
    google: readonly Row[];
    sessions: readonly Row[];
    adReports: readonly Row[];
  }>,
): PersonRecord => ({
  accountId: String(row.id),
  merchantId: typeof row.merchantId === "string" ? row.merchantId : null,
  account: accountOf(row),
  google: related.google.map(googleOf),
  sessions: related.sessions.map(sessionOf),
  adReports: related.adReports.map(adReportOf),
});

/** Over the in-memory identity's rows, as the dashboard keeps them without a database. */
export const memoryPersonRecords = (
  rows: Readonly<Record<string, readonly Row[]>>,
): PersonRecords => ({
  async of(email) {
    const row = (rows.dashboard_accounts ?? []).find((account) => account.email === email);
    if (row === undefined) return null;
    const theirs = (table: string, column: string) =>
      (rows[table] ?? []).filter((one) => one[column] === row.id);
    return recordOf(row, {
      google: theirs("dashboard_credentials", "userId").filter(
        (one) => one.providerId === "google",
      ),
      sessions: theirs("dashboard_sessions", "userId"),
      adReports: theirs("dashboard_ad_reports", "accountId"),
    });
  },
});

/** Over the dashboard's tables; the columns that hold a credential are never selected. */
export const postgresPersonRecords = (pool: Pool): PersonRecords => ({
  async of(email) {
    const db = drizzle(pool);
    return await db.transaction(
      async (tx) => {
        const [row] = await tx
          .select({
            id: accounts.id,
            email: accounts.email,
            emailVerified: accounts.emailVerified,
            name: accounts.name,
            createdAt: accounts.createdAt,
            updatedAt: accounts.updatedAt,
            merchantId: accounts.merchantId,
            operator: accounts.operator,
            analyticsOptOut: accounts.analyticsOptOut,
          })
          .from(accounts)
          .where(eq(accounts.email, email));
        if (row === undefined) return null;
        const google = await tx
          .select({
            providerId: credentials.providerId,
            issuer: credentials.issuer,
            accountId: credentials.accountId,
            createdAt: credentials.createdAt,
          })
          .from(credentials)
          .where(eq(credentials.userId, row.id))
          .orderBy(asc(credentials.createdAt));
        const signedIn = await tx
          .select({
            createdAt: sessions.createdAt,
            updatedAt: sessions.updatedAt,
            expiresAt: sessions.expiresAt,
            ipAddress: sessions.ipAddress,
            userAgent: sessions.userAgent,
          })
          .from(sessions)
          .where(eq(sessions.userId, row.id))
          .orderBy(asc(sessions.createdAt));
        const reported = await tx
          .select({
            event: adReports.event,
            state: adReports.state,
            clickId: adReports.clickId,
            attempts: adReports.attempts,
            lastOutcome: adReports.lastOutcome,
            createdAt: adReports.createdAt,
            eventAt: adReports.eventAt,
            settledAt: adReports.settledAt,
          })
          .from(adReports)
          .where(eq(adReports.accountId, row.id));
        return recordOf(row, {
          google: google.filter((one) => one.providerId === "google"),
          sessions: signedIn,
          adReports: reported,
        });
      },
      // One snapshot, so the account and the rows named by it agree.
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  },
});

interface CopySources {
  readonly people: PersonRecords;
  readonly store: Store;
  readonly wooShops: Pick<WooShops, "connectionOf">;
}

/** The newest `max` of `rows`, and how many there are. */
const newest = <T>(rows: readonly T[], at: (row: T) => number, max: number) => ({
  total: rows.length,
  rows: [...rows].sort((a, b) => at(b) - at(a)).slice(0, max),
});

/**
 * An order as its merchant needs it in a copy of their own data: what was
 * sold, at what price and how it went. The buyer's inputs, address, key and
 * payment are the buyer's and are left out.
 */
const orderOf = (stored: StoredOrder) => {
  const { order } = stored;
  return {
    id: order.id,
    item_id: stored.itemId,
    merchant_item_id: stored.merchantItemId,
    state: order.state,
    payment: order.payment,
    price:
      order.price === null ? null : { amount: order.price.amount, currency: order.price.currency },
    test: order.test,
    created_at: instant(order.timestamps.createdAt),
    paid_at: instant(order.timestamps.paidAt),
    closed_by_you:
      order.merchantClosure === undefined
        ? null
        : { at: instant(order.merchantClosure.at), message: order.merchantClosure.message ?? null },
  };
};

const journalOf = async (store: Store, about: { merchant: string } | { account: string }) => {
  const page = await store.journal({ about, limit: JOURNAL_ROWS_MAX });
  return {
    total: page.total,
    rows: page.rows.map((row) => ({
      at: instant(row.at),
      by: row.actor.kind === "account" ? "an operator" : row.actor.kind,
      action: row.action,
      subject: row.subject.kind,
      reason: row.reason,
      outcome: row.outcome.kind,
      refusal: row.outcome.kind === "refused" ? row.outcome.code : null,
    })),
  };
};

async function merchantCopyOf(sources: CopySources, merchantId: string, accountId: string) {
  const { store } = sources;
  const merchant = await store.merchantById(merchantId);
  if (merchant === null) return null;
  const [keys, polledAt, cards, orders, networks, shop, journal] = await Promise.all([
    store.keysOf(merchantId),
    store.lastContact(merchantId),
    store.cards(merchantId),
    store.orders(merchantId),
    store.networksWithPayoutSplits(),
    sources.wooShops.connectionOf(accountId),
    journalOf(store, { merchant: merchantId }),
  ]);
  const splits = (await Promise.all(networks.map((network) => store.payoutSplitsOn(network))))
    .flat()
    .filter((split) => split.merchantId === merchantId);
  const listedCards = newest(cards, (card) => card.asOf, COPY_ROWS_MAX);
  const listedOrders = newest(orders, (one) => one.order.timestamps.createdAt, COPY_ROWS_MAX);
  return {
    id: merchant.id,
    name: merchant.name,
    service_name: merchant.serviceName,
    seller_site: merchant.sellerSite,
    payout_wallet: merchant.payoutWallet.address,
    payout_wallet_change:
      merchant.payoutWallet.pending === null
        ? null
        : {
            address: merchant.payoutWallet.pending.address,
            takes_effect_at: instant(merchant.payoutWallet.pending.takesEffectAt),
          },
    live_approved_at: instant(merchant.liveApprovedAt),
    selling: merchant.selling,
    integration: merchant.integration,
    created_at: instant(merchant.createdAt),
    last_polled_at: instant(polledAt),
    keys: keys.map((key) => ({
      id: key.id,
      label: key.label,
      created_at: instant(key.createdAt),
      disabled_at: instant(key.disabledAt),
      last_used_at: instant(key.lastUsedAt),
      last_user_agent: key.lastUserAgent,
    })),
    cards: {
      total: listedCards.total,
      rows: listedCards.rows.map((card) => ({
        id: card.id,
        published_at: instant(card.asOf),
        paused: card.paused,
        integration: card.integration,
        card: card.card,
      })),
    },
    orders: { total: listedOrders.total, rows: listedOrders.rows.map(orderOf) },
    payout_splits: splits.map((split) => ({
      address: split.address,
      network: split.network,
      merchant_wallet: split.merchantWallet,
      merchant_allocation: split.merchantAllocation,
      commission_allocation: split.commissionAllocation,
      total_allocation: split.totalAllocation,
      recorded_at: instant(split.recordedAt),
    })),
    woocommerce:
      shop === null
        ? null
        : {
            shop_url: shop.shopUrl,
            permissions: shop.permissions,
            connected_at: iso(shop.connectedAt),
            currency: shop.currency?.code ?? null,
          },
    operator_journal: journal,
  };
}

/** What the dashboard and the gateway hold for this address. */
async function dashboardCopyOf(email: string, sources: CopySources) {
  const person = await sources.people.of(email);
  if (person === null) return { account: null };
  return {
    account: person.account,
    google_sign_in: person.google,
    sessions: person.sessions,
    ad_reports: person.adReports,
    operator_journal: await journalOf(sources.store, { account: person.accountId }),
    merchant:
      person.merchantId === null
        ? null
        : await merchantCopyOf(sources, person.merchantId, person.accountId),
  };
}

function copyMessage(to: string, filename: string, document: string, privacyUrl: string): Message {
  const title = "Your copy of your Agentify data";
  const lead = `Attached is ${filename}, the data Agentify holds for ${to}, which you asked for on the data request page.`;
  const paragraphs = [
    'The file has two parts. "scanner" holds your site reports and the registrations made with this address, and "dashboard" holds your account and seller dashboard. Its "left_out" list says what is deliberately not in the file, and why.',
    "Only someone signed in as this address can ask for a copy, and a copy is never sent to any other address.",
  ];
  return {
    to,
    subject: "Your copy of your Agentify data",
    body: `Agentify\n\n${title}\n\n${lead}\n\n${paragraphs.join("\n\n")}\n\nWhat each request covers:\n\n${privacyUrl}`,
    html: transactionalEmailHtml({
      preview: lead,
      eyebrow: "Data request",
      title,
      lead,
      action: "What each request covers",
      link: privacyUrl,
      paragraphs,
      reason: "This message was sent because a copy of this address's data was asked for.",
    }),
    attachments: [{ filename, contentType: "application/json", content: document }],
  };
}

/**
 * Answers the scanner's request for a copy: builds it and hands it to the mail
 * provider, addressed to the address it is about. `unavailable` is a provider
 * that did not take it; anything thrown is a failure whose outcome the scanner
 * cannot know, and it tries again.
 */
export const copierFor =
  (sources: CopySources, postman: Postman, now: () => Date, privacyUrl: string) =>
  async (request: SendDataCopyRequest): Promise<SendDataCopyResponse> => {
    const preparedAt = now();
    const document = JSON.stringify(
      {
        about: request.email,
        request: request.request,
        prepared_at: preparedAt.toISOString(),
        left_out: LEFT_OUT,
        scanner: request.scanner,
        dashboard: await dashboardCopyOf(request.email, sources),
      },
      null,
      2,
    );
    const filename = `agentify-data-${preparedAt.toISOString().slice(0, 10)}.json`;
    const handed = await postman(copyMessage(request.email, filename, document, privacyUrl));
    return { status: handed === "accepted" ? "accepted" : "unavailable" };
  };

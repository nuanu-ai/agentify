/**
 * The dashboard's identity, registration and WooCommerce tables. They share a
 * database with the gateway's, so the names are prefixed with their owner. The
 * ad reports read the gateway's `cards` by name and write nothing there; only
 * the test channel's forget command writes a gateway table. Migration
 * bookkeeping is kept in its own table, for the reason `src/database.ts` gives.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const moment = (column: string) =>
  timestamp(column, { withTimezone: true, mode: "date" }).notNull();

/**
 * The address is unique in the database rather than by a check in the process,
 * because two commands run at once fit in the gap between a check and an
 * insert. Google account bindings live in `dashboard_credentials`.
 */
export const accounts = pgTable(
  "dashboard_accounts",
  {
    id: text("id").primaryKey(),
    /** Lower case and trimmed, both when written and when read. */
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    /**
     * Better Auth asks every person for a name, and an account is one merchant,
     * so this is the name products are sold under. Empty on an account made by
     * the command, which is never told what the merchant calls itself.
     */
    name: text("name").notNull().default(""),
    createdAt: moment("created_at"),
    updatedAt: moment("updated_at"),
    /**
     * Null while a signed-in person has not yet attached their first merchant.
     */
    merchantId: text("merchant_id"),
    /**
     * Only `pnpm account operator` at the server's terminal sets this: the
     * component is told the field is closed to input, and no page writes it.
     */
    operator: boolean("operator").notNull().default(false),
  },
  // An empty identifier is neither a merchant nor none, and the code reading a
  // row refuses it rather than guessing.
  (table) => [
    check(
      "dashboard_accounts_merchant_named",
      sql`${table.merchantId} is null or ${table.merchantId} <> ''`,
    ),
  ],
);

/**
 * `token` is stored as issued, not as a fingerprint. A copy of this table alone
 * yields no usable sessions, because the cookie carries a signature made with
 * the dashboard's secret and an unsigned value is refused before this table is
 * read; a copy of this table together with that secret does.
 *
 * Deleting an account cascades to its sessions in the database.
 */
export const sessions = pgTable(
  "dashboard_sessions",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    expiresAt: moment("expires_at"),
    createdAt: moment("created_at"),
    updatedAt: moment("updated_at"),
    /**
     * Better Auth may fill these; the dashboard neither interprets nor shows
     * them.
     */
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /**
     * The scanner's full-report request whose link opened this session, null
     * for every other session, so the scanner finishes that request at this
     * session's first visit and never one somebody else made.
     */
    reportRequest: text("report_request"),
  },
  (table) => [
    // For ending every session of one person, and for sweeping expired
    // sessions.
    index("dashboard_sessions_account_idx").on(table.userId),
    index("dashboard_sessions_expires_idx").on(table.expiresAt),
  ],
);

/**
 * Google issuer and subject bind an external identity to a person. OAuth
 * access, refresh and ID tokens are discarded before a binding is written.
 */
export const credentials = pgTable(
  "dashboard_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
    issuer: text("issuer").notNull(),
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    scope: text("scope"),
    createdAt: moment("created_at"),
    updatedAt: moment("updated_at"),
  },
  (table) => [index("dashboard_credentials_account_idx").on(table.userId)],
);

/**
 * Dashboard and report links store the SHA-256 base64url token hash and their
 * claim here; the raw token appears only in the delivered link. Better Auth
 * also keeps one-time OAuth state here with its PKCE verifier, destination and
 * the ad click the sign-in page was opened with.
 * Starting either flow creates no person.
 */
export const verifications = pgTable(
  "dashboard_verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: moment("expires_at"),
    createdAt: moment("created_at"),
    updatedAt: moment("updated_at"),
  },
  (table) => [index("dashboard_verifications_identifier_idx").on(table.identifier)],
);

/**
 * An HMAC counts one normalised address without storing the address again. Rows
 * expire after seven days; the rolling hour reads by the compound index below.
 */
export const linkSends = pgTable(
  "dashboard_link_sends",
  {
    id: text("id").primaryKey(),
    emailHash: text("email_hash").notNull(),
    purpose: text("purpose").notNull(),
    sentAt: moment("sent_at"),
    expiresAt: moment("expires_at"),
  },
  (table) => [
    index("dashboard_link_sends_address_idx").on(table.emailHash, table.purpose, table.sentAt),
    index("dashboard_link_sends_expires_idx").on(table.expiresAt),
    check("dashboard_link_sends_purpose", sql`${table.purpose} in ('dashboard', 'report')`),
  ],
);

/**
 * Generated atomically by the first operation that needs it and kept for the
 * life of this database, so session and route secrets can rotate without
 * breaking rate rows or deletion replay. It never leaves the identity
 * component.
 */
export const reportIdentitySecrets = pgTable(
  "dashboard_report_identity_secrets",
  {
    id: text("id").primaryKey(),
    digestKey: text("digest_key").notNull(),
    createdAt: moment("created_at"),
  },
  (table) => [
    check("dashboard_report_identity_secrets_singleton", sql`${table.id} = 'digest-v1'`),
    check("dashboard_report_identity_secrets_key_length", sql`length(${table.digestKey}) = 43`),
  ],
);

/**
 * The per-operation HMAC tells a faithful replay from reuse of the same
 * operation id for another address. No address or person id is stored, so a
 * response lost after commit can be replayed without resolving today's owner or
 * deleting data created later.
 */
export const reportDeletionTombstones = pgTable(
  "dashboard_report_deletion_tombstones",
  {
    operationId: text("operation_id").primaryKey(),
    operationDigest: text("operation_digest").notNull(),
    result: text("result").notNull(),
    createdAt: moment("created_at"),
    completedAt: moment("completed_at"),
  },
  (table) => [
    check(
      "dashboard_report_deletion_tombstones_result",
      sql`${table.result} in ('deleted', 'already_absent', 'retained')`,
    ),
  ],
);

/**
 * What the dashboard tells the ad tracker whose click brought a person: one
 * row per account and event. `reg` is the registration, written pending in
 * the transaction that makes the address's first verified account, where a
 * link asked for with the click is pressed or a Google sign-in started with it
 * comes back. `store_connected` is written beside it, waiting, where that
 * report is switched on: it becomes pending once the account's merchant
 * publishes its first card within 30 days of the registration, if no other
 * account of that merchant took it, and lapses otherwise.
 *
 * Each row keeps its own copy of the click while it waits or is pending and
 * erases it once final. `created_at` is the registration; `event_at` is when
 * the reported fact happened, the registration or the first card's
 * publication, and is null for a store report that never had one. The rows go
 * with the account.
 */
export const adReports = pgTable(
  "dashboard_ad_reports",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    clickId: text("click_id"),
    state: text("state").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
    /** How the last attempt ended, such as `http_403` or `timeout`; null before any. */
    lastOutcome: text("last_outcome"),
    createdAt: moment("created_at"),
    eventAt: timestamp("event_at", { withTimezone: true, mode: "date" }),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.event] }),
    check("dashboard_ad_reports_event", sql`${table.event} in ('reg', 'store_connected')`),
    check(
      "dashboard_ad_reports_state",
      sql`${table.state} in ('waiting', 'pending', 'delivered', 'refused', 'given_up', 'lapsed')`,
    ),
    check(
      "dashboard_ad_reports_only_a_store_report_waits",
      sql`${table.event} = 'store_connected' or ${table.state} not in ('waiting', 'lapsed')`,
    ),
    check(
      "dashboard_ad_reports_open_holds_click",
      sql`(${table.state} in ('waiting', 'pending')) = (${table.clickId} is not null)`,
    ),
    check(
      "dashboard_ad_reports_pending_scheduled",
      sql`${table.state} <> 'pending' or ${table.nextAttemptAt} is not null`,
    ),
    check(
      "dashboard_ad_reports_settled_dated",
      sql`(${table.state} in ('waiting', 'pending')) = (${table.settledAt} is null)`,
    ),
    check(
      "dashboard_ad_reports_fact_dated",
      sql`(${table.state} in ('waiting', 'lapsed')) = (${table.eventAt} is null)`,
    ),
    // What the delivery reads: the pending rows that are due.
    index("dashboard_ad_reports_due_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.state} = 'pending'`),
    // What each turn reads first: the store reports still waiting for a card.
    index("dashboard_ad_reports_waiting_idx")
      .on(table.createdAt)
      .where(sql`${table.state} = 'waiting'`),
  ],
);

/**
 * One row per press of Connect. WooCommerce posts the granted keys from the
 * shop's server with no session of ours, so the callback is unauthenticated by
 * nature and this token is the only thing that says whose Connect it was. The
 * row is deleted as it is spent: a token that worked twice would let anybody
 * who saw it plant a second pair of keys on that account.
 *
 * The shop address is the one the merchant typed and had checked; read from the
 * callback instead, it would be a shop of the caller's choosing.
 */
export const wooGrants = pgTable(
  "dashboard_woo_grants",
  {
    /** Unguessable, and spent once. */
    token: text("token").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    shopUrl: text("shop_url").notNull(),
    expiresAt: moment("expires_at"),
    createdAt: moment("created_at"),
  },
  // Lets expired attempts be found when old data is reconciled.
  (table) => [index("dashboard_woo_grants_expires_idx").on(table.expiresAt)],
);

/**
 * The key and secret are the shop's own credentials, stored as issued: a copy
 * of this table gives write access to a stranger's shop until they revoke the
 * key in their WooCommerce settings. These two columns never reach a page, a
 * log or the text of an error.
 *
 * Keyed by account, because the Connect was pressed from an account and the
 * callback's token is bound to it.
 */
export const wooShops = pgTable("dashboard_woo_shops", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  /** Without a trailing slash, exactly as it was checked. */
  shopUrl: text("shop_url").notNull(),
  consumerKey: text("consumer_key").notNull(),
  consumerSecret: text("consumer_secret").notNull(),
  /**
   * In the shop's own word. A shop may grant less than `read_write`; read-only
   * keys make the connection unavailable at quote time, and the screen says so
   * before a buyer pays.
   */
  permissions: text("permissions").notNull(),
  /** Changes on every reconnect. */
  revision: text("revision").notNull().default("legacy"),
  connectedAt: moment("connected_at"),
});

/**
 * Delivery-critical WooCommerce facts accepted under one gateway price
 * question.
 */
export const wooQuotes = pgTable(
  "dashboard_woo_quotes",
  {
    priceId: text("price_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    merchantItemId: text("merchant_item_id").notNull(),
    /**
     * Digest only: the protected source address itself is buyer-secret data.
     */
    productFingerprint: text("product_fingerprint").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: moment("created_at"),
  },
  (table) => [index("dashboard_woo_quotes_account_idx").on(table.accountId)],
);

/**
 * Delivery is at least once, so without this table a repeated delivery would
 * place a second order in the merchant's shop for one sale. A row is written
 * before the shop is called and completed after it answers.
 *
 * A row with no order number means an attempt called the shop and never learned
 * the outcome, so nobody here knows whether the shop holds an order for this
 * sale. The next attempt refuses rather than ordering again: a second order is
 * a second parcel the merchant packs and posts.
 */
export const wooOrders = pgTable(
  "dashboard_woo_orders",
  {
    /** What a repeated delivery arrives carrying. */
    orderId: text("order_id").primaryKey(),
    phase: text("phase").notNull().default("create_unknown"),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Set once the shop has answered. */
    wooOrderId: text("woo_order_id"),
    /** The number the merchant reads on their own screen. */
    wooOrderNumber: text("woo_order_number"),
    /** Immutable sold facts and the connection revision that accepted them. */
    facts: jsonb("facts").$type<Record<string, unknown>>(),
    /** Permission ingredients only; never the full bearer URL or an email. */
    result: jsonb("result").$type<Record<string, unknown>>(),
    attemptedAt: moment("attempted_at"),
    placedAt: timestamp("placed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [index("dashboard_woo_orders_account_idx").on(table.accountId)],
);

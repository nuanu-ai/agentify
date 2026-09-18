/**
 * The cabinet-owned identity and WooCommerce tables.
 *
 * They share a database with the gateway's (ADR-0003 §6, one Postgres), so the
 * names say whose they are. Nothing here is a merchant's data: a card, an order
 * and a receipt all come from the public API and none of them can be reached
 * from a query in this process.
 *
 * Better Auth keeps people, sessions, its empty account model and one-time
 * links in separate places. Cabinet code adds bounded link-send and report
 * completion evidence, permanent deletion-operation tombstones, and the
 * WooCommerce channel tables. The names are prefixed so a person reading this
 * shared database can see which process owns them.
 *
 * The migrations generated from this file live in `drizzle/` and are applied by
 * `pnpm --filter @agentify/commerce-cabinet db:migrate`. They keep their bookkeeping in a
 * table of their own, `drizzle.cabinet_migrations`, because the gateway's
 * migrations keep theirs in the default one and two independent histories
 * writing one journal would each conclude the other's migrations were its own
 * and already applied.
 */

import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** How the component writes and reads every moment in these tables. */
const moment = (column: string) =>
  timestamp(column, { withTimezone: true, mode: "date" }).notNull();

/**
 * A person who can sign into the cabinet.
 *
 * The address is unique because that is the promise the sign-in rests on, and
 * the database is where it is actually kept: a check in the process ahead of an
 * insert is two statements with a gap between them, and two commands run at once
 * fit inside that gap.
 *
 * There is no password here. `cabinet_credentials` remains only because it is
 * part of Better Auth's complete schema and is empty after cutover. The two
 * merchant columns are ours rather than the component's.
 */
export const accounts = pgTable(
  "cabinet_accounts",
  {
    id: text("id").primaryKey(),
    /** Lower case and trimmed, which is how it is written and how it is read. */
    email: text("email").notNull().unique(),
    /** True only after a one-time link for this address is consumed. */
    emailVerified: boolean("email_verified").notNull().default(false),
    /**
     * The name this merchant's products are sold under.
     *
     * The component asks every person for a name and this is the name there is:
     * an account is one merchant (ADR-0014), so the person and the shopfront are
     * not two things here yet. It is empty on an account made by the command,
     * which is handed a merchant that already exists and is never told what it
     * calls itself.
     */
    name: text("name").notNull().default(""),
    createdAt: moment("created_at"),
    updatedAt: moment("updated_at"),
    /** Null while an authenticated P1 waits to attach their first merchant. */
    merchantId: text("merchant_id"),
    /** The gateway key is a secret at rest and never reaches a page or log. */
    merchantKey: text("merchant_key"),
  },
  (table) => [
    check(
      "cabinet_accounts_complete_merchant",
      sql`(
        (${table.merchantId} is null and ${table.merchantKey} is null)
        or
        (${table.merchantId} is not null and ${table.merchantKey} is not null
          and ${table.merchantId} <> '' and ${table.merchantKey} <> '')
      )`,
    ),
  ],
);

/**
 * One person signed in on one device.
 *
 * The identifier the browser carries is in `token`, and it is here as it was
 * issued rather than as a fingerprint of one. What stands between a copy of
 * this table and a pile of sessions somebody can spend is that the cookie is
 * not the token alone: the component signs it, and a value with no signature
 * over it is refused before this table is read at all. That is a different
 * bargain from the one this table used to make and it is worth knowing which
 * one is in force — the secret that makes those signatures is in the cabinet's
 * configuration, so a copy of this table and a copy of that configuration
 * together are what the fingerprint used to rule out on its own.
 *
 * The reference to the account cascades on delete: an account that goes takes
 * its sessions with it, in the database rather than in whichever code path
 * happened to delete it.
 */
export const sessions = pgTable(
  "cabinet_sessions",
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
     * Where the request came from and what it said it was.
     *
     * Better Auth may fill these from its server API context. Cabinet product
     * behavior does not interpret or expose them.
     */
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (table) => [
    // Ending every session one person has reads by the first, and the sweep of
    // sessions whose time is up reads by the second.
    index("cabinet_sessions_account_idx").on(table.userId),
    index("cabinet_sessions_expires_idx").on(table.expiresAt),
  ],
);

/**
 * Component account storage retained empty for Better Auth's schema.
 *
 * The stopped one-way-in migration deletes every password credential. Better
 * Auth still knows this model as part of its complete schema, but no cabinet
 * operation creates a row here and no accepted sign-in path reads one.
 */
export const credentials = pgTable(
  "cabinet_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Legacy provider field retained in the component schema. */
    providerId: text("provider_id").notNull(),
    /** Legacy provider account identifier. */
    accountId: text("account_id").notNull(),
    /** Legacy issuer field. */
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
  (table) => [index("cabinet_credentials_account_idx").on(table.userId)],
);

/**
 * A one-time link that has been handed out and not yet spent.
 *
 * Cabinet and report links share this table with an explicit door purpose in
 * the claim. `identifier` is the SHA-256 base64url token hash; the raw token
 * appears only in the delivered action URL. The component spends the row once.
 *
 * It has no reference to an account on purpose. A row here can name an address
 * that no account has, which is how asking for a link creates no person.
 */
export const verifications = pgTable(
  "cabinet_verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: moment("expires_at"),
    createdAt: moment("created_at"),
    updatedAt: moment("updated_at"),
  },
  (table) => [index("cabinet_verifications_identifier_idx").on(table.identifier)],
);

/**
 * Privacy-bounded evidence that an address was sent an identity link.
 *
 * The HMAC is enough to count one normalized address without retaining that
 * address a second time. Rows expire after seven days; the rolling one-hour
 * decision reads by the compound index below.
 */
export const linkSends = pgTable(
  "cabinet_link_sends",
  {
    id: text("id").primaryKey(),
    emailHash: text("email_hash").notNull(),
    purpose: text("purpose").notNull(),
    sentAt: moment("sent_at"),
    expiresAt: moment("expires_at"),
  },
  (table) => [
    index("cabinet_link_sends_address_idx").on(table.emailHash, table.purpose, table.sentAt),
    index("cabinet_link_sends_expires_idx").on(table.expiresAt),
    check("cabinet_link_sends_purpose", sql`${table.purpose} in ('cabinet', 'report')`),
  ],
);

/**
 * Short-lived proof that a report link was consumed for scanner state.
 *
 * Raw tokens, addresses, callback state and person identifiers never enter
 * this table. Their digests bind retries and let deletion invalidate every
 * report proof for one address without giving this row authority over cabinet
 * sessions or commerce data.
 */
export const reportReceipts = pgTable(
  "cabinet_report_receipts",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    emailHash: text("email_hash").notNull(),
    stateHash: text("state_hash").notNull(),
    intentKind: text("intent_kind").notNull(),
    status: text("status").notNull(),
    consumedAt: moment("consumed_at"),
    completionDeadline: moment("completion_deadline"),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true, mode: "date" }),
    issueAttemptedAt: timestamp("issue_attempted_at", { withTimezone: true, mode: "date" }),
    issuedLinkExpiresAt: timestamp("issued_link_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    retentionUntil: moment("retention_until"),
  },
  (table) => [
    index("cabinet_report_receipts_email_idx").on(table.emailHash),
    index("cabinet_report_receipts_retention_idx").on(table.retentionUntil),
    check(
      "cabinet_report_receipts_intent_kind",
      sql`${table.intentKind} in ('registration', 'recovery')`,
    ),
    check(
      "cabinet_report_receipts_status",
      sql`${table.status} in ('pending', 'completed', 'invalidated')`,
    ),
  ],
);

/**
 * Stable private key material for report evidence digests.
 *
 * The singleton is generated atomically by the first report operation and
 * lives for the lifetime of this database. Session-signing and internal HTTP
 * credentials may rotate without changing receipt bindings or permanent
 * deletion replay. The key has no operator setting and never leaves the
 * cabinet identity component.
 */
export const reportIdentitySecrets = pgTable(
  "cabinet_report_identity_secrets",
  {
    id: text("id").primaryKey(),
    digestKey: text("digest_key").notNull(),
    createdAt: moment("created_at"),
  },
  (table) => [
    check("cabinet_report_identity_secrets_singleton", sql`${table.id} = 'digest-v1'`),
    check("cabinet_report_identity_secrets_key_length", sql`length(${table.digestKey}) = 43`),
  ],
);

/**
 * Permanent terminal evidence for privacy deletion retries.
 *
 * The operation-specific HMAC distinguishes a faithful replay from reuse of
 * the same operation id for another address. The outcome is stored without an
 * address or person id, so a response lost after commit can be replayed without
 * resolving today's owner or deleting data created later.
 */
export const reportDeletionTombstones = pgTable(
  "cabinet_report_deletion_tombstones",
  {
    operationId: text("operation_id").primaryKey(),
    operationDigest: text("operation_digest").notNull(),
    result: text("result").notNull(),
    createdAt: moment("created_at"),
    completedAt: moment("completed_at"),
  },
  (table) => [
    check(
      "cabinet_report_deletion_tombstones_result",
      sql`${table.result} in ('deleted', 'already_absent', 'retained')`,
    ),
  ],
);

/**
 * A Connect somebody started and nobody has finished.
 *
 * One row per press of the Connect button, holding the token that went to the
 * shop as `user_id` and the merchant it belongs to. It is the whole of what
 * stands between a stranger and somebody else's account: WooCommerce posts the
 * granted keys from the shop's own server, carrying no session of ours, so the
 * callback is unauthenticated by nature and the token coming back in it is the
 * only thing that says whose Connect this was.
 *
 * A row is deleted as it is spent, which is what makes the token single-use: a
 * value that worked twice would let anybody who saw one — in a shop's logs, in
 * a browser's history — plant a second pair of keys on that account later.
 *
 * The shop address is kept beside it because it is the address the merchant
 * typed and had checked, and the keys that come back are for that shop and no
 * other. Read out of the callback instead, it would be a shop of the caller's
 * choosing.
 */
export const wooGrants = pgTable(
  "cabinet_woo_grants",
  {
    /** The token itself, as it travelled. Unguessable, and spent once. */
    token: text("token").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    shopUrl: text("shop_url").notNull(),
    expiresAt: moment("expires_at"),
    createdAt: moment("created_at"),
  },
  // The sweep of the ones nobody came back for reads by this.
  (table) => [index("cabinet_woo_grants_expires_idx").on(table.expiresAt)],
);

/**
 * One merchant's connected WooCommerce shop.
 *
 * The key and the secret are the shop's own credentials, stored as the shop
 * issued them, which makes this a secret at rest of somebody else's. It is the
 * same bargain ADR-0014 §2 makes for the merchant key on the account row and it
 * is written down again in the decision record for this channel, because the
 * secret here belongs to a third party rather than to us: what a copy of this
 * table buys is write access to a stranger's shop until they revoke the key,
 * which they can do from their own WooCommerce settings, where it appears under
 * the name we asked for it under.
 *
 * The rule that follows for everything above this table is the same one: these
 * two columns never reach a page, a log or the text of an error.
 *
 * One row per account rather than per merchant, keyed by the account, because
 * the account is what the Connect was pressed from and what the callback's
 * token is bound to.
 */
export const wooShops = pgTable("cabinet_woo_shops", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  /** The shop's address, without a trailing slash, exactly as it was checked. */
  shopUrl: text("shop_url").notNull(),
  consumerKey: text("consumer_key").notNull(),
  consumerSecret: text("consumer_secret").notNull(),
  /**
   * What the shop says the keys are good for, in the shop's own word.
   *
   * Kept rather than assumed. We ask for `read_write` and a shop is free to
   * grant less; a connection whose keys can only read is one where every sale
   * fails at the moment of delivery, and the screen says so beforehand instead
   * of letting the merchant find out from a refunded buyer.
   */
  permissions: text("permissions").notNull(),
  connectedAt: moment("connected_at"),
});

/**
 * What we have already placed in a shop, and what we tried to.
 *
 * A delivery is at least once: an order whose answer never reached the gateway
 * is handed to us again, and without this table the second attempt would place
 * a second order in the merchant's shop for one sale. So a row is written
 * before the shop is called and completed after it answers.
 *
 * The row with no order number on it is the honest half. It means an attempt
 * reached the point of calling the shop and we never learned the outcome — the
 * process died, the connection dropped after the request went out — so whether
 * that shop holds an order for this sale is something nobody here knows. The
 * next attempt reads that and refuses rather than ordering again, because a
 * second order in a merchant's shop is a second thing they pick, pack and post.
 */
export const wooOrders = pgTable(
  "cabinet_woo_orders",
  {
    /** Our own order identifier, which is what a repeat arrives carrying. */
    orderId: text("order_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** The shop's row identifier for the order, once the shop has answered. */
    wooOrderId: text("woo_order_id"),
    /** The number the merchant reads on their own screen. */
    wooOrderNumber: text("woo_order_number"),
    /** Exact safe goods returned on every redelivery; contains no raw source URL or email. */
    result: jsonb("result").$type<Record<string, unknown>>(),
    attemptedAt: moment("attempted_at"),
    placedAt: timestamp("placed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [index("cabinet_woo_orders_account_idx").on(table.accountId)],
);

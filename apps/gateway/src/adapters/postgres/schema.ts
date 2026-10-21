/**
 * The tables. An order is kept as one document so a change to the order
 * machine's shape needs no migration of live orders; only what the gateway
 * queries by is pulled into columns, written from the document on every save so
 * they cannot drift from it. Every table except the payment claims and the
 * payout splits carries its merchant by a foreign key, so a row cannot exist
 * without an owner. Money is never a column: prices stay inside the documents
 * as the contract's decimal strings, so no database driver can turn one into a
 * float.
 */

import type { MerchantSelling } from "@agentify/core";
import type { Card, Receipt } from "@nuanu-ai/agentify-contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { StoredOrder } from "../../ports/store.js";

/**
 * One row per merchant, with whether they are taking new orders: the merchant
 * sets that and it must survive a restart, so it is not configuration. No email
 * address, password or sign-up record is kept here, and `name` is for a person
 * at a terminal and never goes on the wire.
 */
export const merchants = pgTable(
  "merchants",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /**
     * The name this seller is listed under in a discovery catalog, or null where
     * nobody has named one. It is never filled in from `name`: the catalog
     * carries only printable ASCII and silently cuts the rest.
     */
    serviceName: text("service_name"),
    /**
     * The https origin of this seller's own shop, or null. An agent reads it
     * beside the name on every card and order of theirs, as where to take what
     * an order cannot answer.
     */
    sellerSite: text("seller_site"),
    /**
     * The wallet this merchant's share of sales is paid out to, or null where
     * nobody has set one. Buyers' agents pay into its payout split, which pays
     * this wallet and nobody else the merchant's share, so it is never filled
     * in from the operator's own configured address. The gateway writes the mixed-case
     * spelling a wallet displays; a row in lower case is the same wallet, and
     * the registry is read for it in either spelling.
     */
    payoutWallet: text("payout_wallet"),
    /**
     * A replacement for that address which has been announced and is waiting,
     * and the instant it takes effect; both null where nothing is waiting. Two
     * columns rather than a document because the write recording a change
     * compares them with what was read before it was announced. The check below
     * keeps them both set or both null: half a change is a sale paid somewhere
     * at no stated time, or at a stated time to nowhere.
     */
    pendingPayoutWallet: text("pending_payout_wallet"),
    pendingPayoutWalletFrom: timestamp("pending_payout_wallet_from", {
      withTimezone: true,
      mode: "date",
    }),
    /**
     * The first and only operator grant for live publication; null denies it.
     * Repeated grants keep the first instant, so the column is the audit record
     * as well as the switch.
     */
    liveApprovedAt: timestamp("live_approved_at", { withTimezone: true, mode: "date" }),
    /** The order machine's own word, which the check below keeps to its list. */
    selling: text("selling").$type<MerchantSelling>().notNull(),
    /**
     * The integration this merchant sells through. A new merchant starts on
     * `api`, their own code; only a switch moves it.
     */
    integration: text("integration").notNull().default("api"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    check(
      "merchants_pending_payout_wallet_whole",
      sql`(${table.pendingPayoutWallet} is null) = (${table.pendingPayoutWalletFrom} is null)`,
    ),
    check("merchants_integration_known", sql`${table.integration} in ('api', 'woocommerce')`),
    check("merchants_selling_known", sql`${table.selling} in ('open', 'paused')`),
  ],
);

/**
 * One key a merchant opens the door with. Only its SHA-256 digest is kept,
 * unique because a request is resolved by hashing what was presented and
 * looking it up, with no comparison of secrets; a copy of this table is not a
 * set of keys anyone can spend.
 */
export const merchantKeys = pgTable(
  "merchant_keys",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** The SHA-256 of the key, in lower-case hex. Never the key. */
    digest: text("digest").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    /** When it was revoked, or null while it still opens the door. */
    disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "date" }),
    /**
     * The last call this key was seen on, written at most once per key per
     * window, or null where none was written. Not indexed and never read on the
     * way to a purchase.
     */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  },
  // Listing one merchant's keys reads by this; the door reads by the unique
  // index on the digest above.
  (table) => [index("merchant_keys_merchant_idx").on(table.merchantId)],
);

export const cards = pgTable(
  "cards",
  {
    /** Our catalog identifier, the one an agent and a receipt both use. */
    id: text("id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    /**
     * The merchant's own key for this product. Republishing under it updates
     * the card in place, which the unique constraint below enforces.
     */
    merchantItemId: text("merchant_item_id").notNull(),
    card: jsonb("card").$type<Card>().notNull(),
    /** When this version of the card was published. */
    asOf: timestamp("as_of", { withTimezone: true, mode: "date" }).notNull(),
    /**
     * When the card was first published; a republish leaves it. The dashboard
     * reads a merchant's earliest one as the moment their store was connected.
     * Every publish writes it; the default serves a build without this column
     * that publishes into the same database, which would otherwise be refused.
     */
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /**
     * Whether this card alone is off sale. A column rather than a field in the
     * document, because republishing writes the document whole and would erase
     * the pause.
     */
    paused: boolean("paused").notNull().default(false),
    /**
     * The integration that first published this card; a later publish through
     * the other one does not move it. No default: every publish writes one.
     */
    integration: text("integration").notNull(),
  },
  (table) => [
    check("cards_integration_known", sql`${table.integration} in ('api', 'woocommerce')`),
    // Unique within a merchant, not across the gateway: held globally, the
    // second merchant to publish a "sku-1" would edit the first one's card.
    unique("cards_merchant_item_unique").on(table.merchantId, table.merchantItemId),
    index("cards_merchant_idx").on(table.merchantId),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    /** Written from the document, so a list can be drawn without reading them all. */
    state: text("state").notNull(),
    /** Whether this order is still owed work or money. */
    open: boolean("open").notNull(),
    /** Written from the document, like `state` and `open`. */
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    itemId: text("item_id").notNull(),
    merchantItemId: text("merchant_item_id").notNull(),
    record: jsonb("record").$type<StoredOrder>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    // The merchant leads the index because a merchant lists their own orders,
    // open ones first; an index on `open` alone would walk every merchant's.
    index("orders_open_idx").on(table.merchantId, table.open, table.createdAt),
    // Whether any order of a merchant's was paid to a split, which a payout
    // asks of every split it might cover; without it each question reads
    // every document of that merchant's.
    index("orders_pay_to_idx").on(table.merchantId, sql`lower(${table.record} ->> 'payTo')`),
    index("orders_unresolved_payment_idx")
      .on(table.id)
      .where(sql`${table.record} -> 'order' ->> 'payment' in ('settling', 'outcome_unknown')`),
    // The order a payment is for, found by the reference its challenge
    // carried, and never two orders under one reference.
    uniqueIndex("orders_payment_ref_unique").on(sql`(${table.record} ->> 'paymentRef')`),
  ],
);

export const receipts = pgTable(
  "receipts",
  {
    /** One receipt per order, which is what makes writing it again an update. */
    orderId: text("order_id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    receipt: jsonb("receipt").$type<Receipt>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [index("receipts_merchant_idx").on(table.merchantId, table.updatedAt)],
);

/**
 * Which order owns which payment. The primary key is the mechanism: a signed
 * payment names no purchase, so this row already existing is what refuses a
 * second order paid with the same signature. It deliberately has no merchant:
 * a fingerprint unique per merchant would let one authorisation be spent once
 * at each merchant.
 */
export const paymentClaims = pgTable(
  "payment_claims",
  {
    /** A canonical fingerprint of the authorisation the agent actually signed. */
    fingerprint: text("fingerprint").primaryKey(),
    orderId: text("order_id").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }).notNull(),
    retained: boolean("retained").notNull().default(false),
  },
  // Claims are swept by age, and read back by order when somebody is working
  // out what an order was paid with.
  (table) => [
    index("payment_claims_swept_idx").on(table.claimedAt),
    index("payment_claims_order_idx").on(table.orderId),
  ],
);

/**
 * Every payout split ever named as a payment address, with every parameter the
 * factory creates it from. Until a split's first payout these columns are the
 * only place its parameters exist, and without them nobody can create it or
 * pay out what it holds, so a row is never changed or deleted: a trigger the
 * migration adds refuses both, whoever asks, and leaves `truncate` to the
 * tests that empty a database. It names its merchant with no foreign key,
 * because money may still arrive at a split after a test merchant is
 * forgotten. One row per network, merchant and wallet, and one per network and
 * address, each in either spelling, since one address in two spellings is one
 * contract.
 */
export const payoutSplits = pgTable(
  "payout_splits",
  {
    /** Where buyers pay, in the checksummed spelling. */
    address: text("address").notNull(),
    /** The CAIP-2 chain the split is on. */
    network: text("network").notNull(),
    merchantId: text("merchant_id").notNull(),
    merchantWallet: text("merchant_wallet").notNull(),
    commissionWallet: text("commission_wallet").notNull(),
    merchantAllocation: integer("merchant_allocation").notNull(),
    commissionAllocation: integer("commission_allocation").notNull(),
    totalAllocation: integer("total_allocation").notNull(),
    distributionIncentive: integer("distribution_incentive").notNull(),
    owner: text("owner").notNull(),
    /** The salt handed to the factory, as thirty-two bytes of hexadecimal. */
    salt: text("salt").notNull(),
    factory: text("factory").notNull(),
    /** When the split was first recorded; a later write of the same split keeps it. */
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("payout_splits_wallet_unique").on(
      table.network,
      table.merchantId,
      sql`lower(${table.merchantWallet})`,
    ),
    uniqueIndex("payout_splits_address_unique").on(table.network, sql`lower(${table.address})`),
  ],
);

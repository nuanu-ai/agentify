/**
 * Where a merchant's WooCommerce connection is kept: the Connect under way, the
 * connected shop, and the orders already placed in it. Two implementations,
 * memory and Postgres, held to one contract test, because what matters is not
 * visible in a schema: a state token works once only, and an order placed in
 * somebody's shop is never placed twice. The shop's key and secret are a third
 * party's credentials, stored as issued.
 */

import type { SurfaceMode } from "@agentify/core";
import { type AnalyticsEvent, recordAlong, recordObserved } from "@agentify/gateway/analytics";
import type { Money } from "@nuanu-ai/agentify-contracts";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { accounts, wooGrants, wooOrders, wooQuotes, wooRates, wooShops } from "./schema.js";
import type { ShopDecimals } from "./woo-money.js";

/**
 * Everywhere but live: the connector says it works in test mode only, and a
 * live parcel cannot be sold. Asked by the pages and the worker alike.
 */
export const wooOfferedOn = (surface: SurfaceMode): boolean => surface !== "live";

/** The currency a shop sells in, and the Number of decimals it writes its amounts at. */
export interface ShopCurrency {
  readonly code: string;
  readonly decimals: ShopDecimals;
}

interface WooGrant {
  /** Unguessable and one-time; it travels as `user_id`. */
  readonly token: string;
  readonly accountId: string;
  readonly shopUrl: string;
  /** As the shop's public catalogue answered at Connect; null where it did not clearly say. */
  readonly currency: ShopCurrency | null;
  /**
   * Written by the caller rather than the store, so the two implementations
   * cannot disagree and a test can place a Connect in the past.
   */
  readonly startedAt: Date;
  readonly expiresAt: Date;
}

export interface WooConnection {
  readonly accountId: string;
  readonly shopUrl: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
  /** `read_write`, or less. */
  readonly permissions: string;
  readonly revision: string;
  readonly connectedAt: Date;
  /**
   * As last read, at Connect or by an import, for the screens; null where never
   * read. The purchase path reads the shop's own settings instead.
   */
  readonly currency: ShopCurrency | null;
}

/** A rate as a price is converted at: how many units of `currency` one US dollar buys. */
export interface AppliedRate {
  /** Rises with every rate saved, across every shop. */
  readonly version: number;
  readonly currency: string;
  readonly rate: string;
  readonly setAt: Date;
}

/** Coinbase's rate as read while a rate was saved, which the guard compared it with. */
export interface ReferenceShown {
  readonly rate: string;
  readonly source: string;
  readonly readAt: Date;
}

export interface RateEntry {
  readonly currency: string;
  readonly rate: string;
  readonly setAt: Date;
  /** The email of the session that saved it. */
  readonly setBy: string;
  /** Null where no reference could be read, so nothing was compared. */
  readonly reference: ReferenceShown | null;
  /** Typed a second time past the guard. */
  readonly confirmed: boolean;
}

export type SavedRate = RateEntry & { readonly version: number };

/** What an accepted price answer binds its `price_id` to. */
export interface QuoteBinding {
  readonly fingerprint: string;
  /** What the shop's order is held to, in the shop's currency at its decimals. */
  readonly inTheShop: Money;
  /** The US dollars answered, which the buyer pays. */
  readonly paid: Money;
  /** Null where the shop sells in US dollars. */
  readonly rate: AppliedRate | null;
}

type QuoteToBind = Omit<QuoteBinding, "rate"> & { readonly rateVersion: number | null };

/**
 * A sale from a shop in another currency, as its ledger keeps it beside the
 * dollars paid: the amount the shop's order was held to and the rate the
 * dollars were converted at.
 */
export interface ConvertedSale {
  readonly inTheShop: Money;
  readonly rate: { readonly version: number; readonly rate: string; readonly setAt: string };
}

/** What the shop's order for a placed sale totals, as the Orders screen reads it. */
export interface ShopTotal {
  readonly total: string;
  readonly converted: ConvertedSale | null;
}

export interface WooOrderFacts extends Readonly<Record<string, unknown>> {
  /** Absent for a download's sale. Nothing of where a parcel goes is kept. */
  readonly kind?: "parcel";
  readonly shopOrigin: string;
  readonly connectionRevision: string;
  readonly merchantItemId: string;
  readonly priceId: string;
  readonly productId: string;
  readonly productFingerprint: string;
  /** What the buyer paid. */
  readonly amount: string;
  readonly currency: string;
  /** Absent where the shop sells in US dollars, whose order records what was paid. */
  readonly converted?: ConvertedSale;
}

export interface WooPermission extends Readonly<Record<string, unknown>> {
  readonly shopOrigin: string;
  readonly productId: string;
  readonly orderKey: string;
  readonly downloadId: string;
  readonly fileName: string;
  readonly emailUid: string;
  readonly orderNumber: string;
}

interface ParcelToFollow {
  readonly orderId: string;
  readonly wooOrderId: string;
  /** The shop the order id belongs to. */
  readonly shopOrigin: string;
  readonly placedAt: Date;
}

interface WooRecoveryOrder {
  readonly orderId: string;
  readonly accountId: string;
  readonly phase: "precreate_refused" | "create_unknown" | "placed";
  readonly facts: WooOrderFacts;
  readonly placed: {
    readonly id: string;
    readonly number: string;
    /** Null for a parcel, whose shop order is the whole result. */
    readonly permission: WooPermission | null;
  } | null;
}

/**
 * Three different things to do, and folding any two costs somebody something:
 * `ours` is a sale nobody has placed yet, owned by this attempt; `placed` is a
 * repeat, answered with the shop's number and no second order; `unknown` means
 * an earlier attempt called the shop and never came back, so nobody here can
 * know whether the shop holds an order for this sale.
 */
type OrderClaim =
  | { readonly kind: "ours" }
  | { readonly kind: "precreate_refused" }
  | {
      readonly kind: "placed";
      readonly id: string;
      readonly number: string;
      readonly permission: WooPermission;
    }
  /** Answered by taking the shop's order on again. */
  | { readonly kind: "placed_parcel"; readonly id: string; readonly number: string }
  | { readonly kind: "unknown"; readonly attemptedAt: Date };

// The ledger only moves forward: absent may become precreate_refused or
// create_unknown; only explicit recovery moves precreate_refused to
// create_unknown; only validated binding moves create_unknown to placed; a
// placed download never changes, and a placed parcel moves once more, to
// shipped or closed. The store methods below are the only transitions.

export interface WooShops {
  /**
   * Records a product analytics event of the connector's that has no write of
   * its own, such as an import's result, outside any transaction. It never
   * rejects.
   */
  recordAnalytics(event: AnalyticsEvent, at: Date): Promise<void>;
  beginGrant(grant: WooGrant): Promise<void>;
  /**
   * One account-serialised operation, because a callback is unauthenticated and
   * may arrive after the merchant began another Connect; split in two, the
   * older callback could overwrite the newer intent between the writes.
   *
   * A different connected shop must be disconnected first; only the same
   * shop's keys may be renewed. Null covers that refusal, a token nobody
   * issued, one already spent and one expired, without telling them apart:
   * on a route anybody can post to, that would answer questions about somebody
   * else's account. An expired row stays so its owner can see the attempt that ended.
   *
   * The connection is recorded for product analytics in the same transaction,
   * and so is a refusal of a callback whose account is known: one that came
   * after its Connect's time was up, or that names a shop other than the one
   * connected. A token nobody holds records nothing.
   */
  connectFromGrant(
    token: string,
    keys: Pick<WooConnection, "consumerKey" | "consumerSecret" | "permissions">,
    now: Date,
  ): Promise<WooConnection | null>;
  /**
   * Read by the screens and never on the callback path, and by account rather
   * than by token, so it is not a second way to spend a token. Expired ones are
   * not filtered: an expired Connect with no keys is the case a merchant needs
   * a sentence about, and the screen reads the clock. The newest, if Connect
   * was pressed twice.
   */
  grantFor(accountId: string): Promise<WooGrant | null>;
  /** Replaces whatever that account had before. */
  connect(connection: WooConnection): Promise<void>;
  connectionOf(accountId: string): Promise<WooConnection | null>;
  /**
   * The shop URL is returned only so the form can be left filled in. Cards and
   * accepted orders live in other stores and are untouched.
   */
  forget(accountId: string): Promise<string | null>;
  /** What the worker draws its work from. */
  connections(): Promise<readonly WooConnection[]>;
  /** The shop's currency as an import read it from the shop's own settings. */
  noteCurrency(accountId: string, currency: ShopCurrency): Promise<void>;
  /** Added, never written over: the earlier versions stay for the prices bound to them. */
  saveRate(accountId: string, shopOrigin: string, entry: RateEntry): Promise<SavedRate>;
  currentRate(accountId: string, shopOrigin: string, currency: string): Promise<SavedRate | null>;
  /**
   * A price id already bound to anything else is not moved: the order is held
   * to what it was first bound to.
   */
  recordQuote(
    accountId: string,
    priceId: string,
    merchantItemId: string,
    binding: QuoteToBind,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean>;
  quotedSale(
    accountId: string,
    priceId: string,
    merchantItemId: string,
  ): Promise<QuoteBinding | null>;

  /**
   * Writing the claim is the act, not a check before one: a redelivery arriving
   * while the first attempt is in flight must not also come back `ours`, and
   * the database's uniqueness settles that rather than a read followed by a
   * write.
   *
   * The order identifier alone is the key; the account column beside it is not
   * part of it. That holds because the gateway issues order identifiers from a
   * random source, unique across all merchants. Were they ever unique per
   * merchant only, this row would be where two merchants' sales meet, and a
   * buyer would be handed the other merchant's order number.
   */
  claimOrder(
    accountId: string,
    orderId: string,
    facts: WooOrderFacts,
    now: Date,
  ): Promise<OrderClaim>;
  knownOrder(orderId: string): Promise<Exclude<OrderClaim, { kind: "ours" }> | null>;
  recordPrecreateRefusal(
    accountId: string,
    orderId: string,
    facts: WooOrderFacts,
    now: Date,
  ): Promise<void>;
  /**
   * A download's permission, or null for a parcel, and what the shop's order
   * totals.
   */
  recordOrder(
    orderId: string,
    placed: {
      id: string;
      number: string;
      permission: WooPermission | null;
      total: string;
    },
    now: Date,
  ): Promise<boolean>;
  /**
   * What the shop's orders for these sales of this account total, for the
   * placed ones; a bounded lookup for the rows of the merchant's Orders screen.
   */
  shopTotals(
    accountId: string,
    orderIds: readonly string[],
  ): Promise<Readonly<Record<string, ShopTotal>>>;
  /** Rows without an exact recovery state are not recoverable. */
  recoveryOrder(orderId: string): Promise<WooRecoveryOrder | null>;
  /** A bounded local lookup for links on this account's visible Orders rows. */
  recoverableOrders(accountId: string, orderIds: readonly string[]): Promise<readonly string[]>;
  /** Placed and neither shipped nor ended. */
  parcelsToFollow(accountId: string): Promise<readonly ParcelToFollow[]>;
  /**
   * `shipped` once its shipment is recorded with the gateway, `closed` once it
   * can no longer be. Once only: the answer says whether this call ended it.
   */
  endParcel(orderId: string, phase: "shipped" | "closed", now: Date): Promise<boolean>;
  /**
   * Reopens a definite pre-create refusal as `create_unknown`, and only under a
   * different grant: a connection revision other than the one that refused.
   * The compare-and-set keeps two operator commands to one POST.
   */
  beginPrecreateRecovery(orderId: string, revision: string, now: Date): Promise<boolean>;
}

const PARCEL_PLACED = new Set(["placed", "shipped", "closed"]);

/**
 * A shop's connection as product analytics counts it. The keys arrive because
 * the person who pressed Connect approved them in their own shop, so it is
 * theirs, though the shop's server sends them.
 */
const connectionResult = (
  accountId: string,
  merchantId: string | null,
  settled:
    | { readonly outcome: "completed" }
    | {
        readonly outcome: "blocked";
        readonly reason_code: "session_expired" | "identity_mismatch";
      },
): AnalyticsEvent =>
  ({
    name: "agc_setup_result",
    actor: "human",
    source: "woocommerce",
    refs: merchantId === null ? { person: accountId } : { merchant: merchantId, person: accountId },
    fields: { step: "woo_connection", integration: "woocommerce", ...settled },
  }) as AnalyticsEvent;

/**
 * A row with the shop's order and a permission is a placed download, whatever
 * phase it was written in: older rows read `create_unknown` and were placed all
 * the same. A placed row with no permission is a parcel's, answered on
 * redelivery by taking the order on again.
 */
const claimOf = (row: {
  readonly phase: string;
  readonly wooOrderId: string | null;
  readonly wooOrderNumber: string | null;
  readonly result: unknown;
  readonly attemptedAt: Date;
}): Exclude<OrderClaim, { kind: "ours" }> => {
  if (row.phase === "precreate_refused") return { kind: "precreate_refused" };
  if (row.wooOrderId !== null && row.wooOrderNumber !== null) {
    if (row.result !== null) {
      return {
        kind: "placed",
        id: row.wooOrderId,
        number: row.wooOrderNumber,
        permission: row.result as WooPermission,
      };
    }
    if (PARCEL_PLACED.has(row.phase)) {
      return { kind: "placed_parcel", id: row.wooOrderId, number: row.wooOrderNumber };
    }
  }
  return { kind: "unknown", attemptedAt: row.attemptedAt };
};

const currencyOfRow = (row: {
  readonly currency: string | null;
  readonly currencyDecimals: number | null;
}): ShopCurrency | null =>
  row.currency !== null && (row.currencyDecimals === 0 || row.currencyDecimals === 2)
    ? { code: row.currency, decimals: row.currencyDecimals }
    : null;

const connectionOfRow = (row: typeof wooShops.$inferSelect): WooConnection => ({
  accountId: row.accountId,
  shopUrl: row.shopUrl,
  consumerKey: row.consumerKey,
  consumerSecret: row.consumerSecret,
  permissions: row.permissions,
  revision: row.revision,
  connectedAt: row.connectedAt,
  currency: currencyOfRow(row),
});

const savedRateOfRow = (row: typeof wooRates.$inferSelect): SavedRate => ({
  version: row.version,
  currency: row.currency,
  rate: row.rate,
  setAt: row.setAt,
  setBy: row.setBy,
  reference:
    row.referenceRate === null || row.referenceSource === null || row.referenceReadAt === null
      ? null
      : { rate: row.referenceRate, source: row.referenceSource, readAt: row.referenceReadAt },
  confirmed: row.confirmed,
});

/**
 * Null for a row that bound no amount, or whose rate version names no rate of
 * this account: neither is anything an order can be held to.
 */
const bindingOf = (
  quote: {
    readonly productFingerprint: string;
    readonly shopAmount: string | null;
    readonly shopCurrency: string | null;
    readonly dollars: string | null;
    readonly rateVersion: number | null;
  },
  rate: AppliedRate | null,
): QuoteBinding | null => {
  if (quote.shopAmount === null || quote.shopCurrency === null || quote.dollars === null) {
    return null;
  }
  if (
    quote.rateVersion !== null &&
    (rate?.version !== quote.rateVersion || rate.currency !== quote.shopCurrency)
  ) {
    return null;
  }
  return {
    fingerprint: quote.productFingerprint,
    inTheShop: { amount: quote.shopAmount, currency: quote.shopCurrency },
    paid: { amount: quote.dollars, currency: "USD" },
    rate:
      quote.rateVersion === null || rate === null
        ? null
        : { version: rate.version, currency: rate.currency, rate: rate.rate, setAt: rate.setAt },
  };
};

const sameMoney = (one: Money, other: Money): boolean =>
  one.amount === other.amount && one.currency === other.currency;

export const postgresWooShops = (pool: Pool): WooShops => {
  const db = drizzle(pool);

  return {
    recordAnalytics: (event, at) => recordObserved(db, event, at),

    async beginGrant(grant) {
      await db.transaction(async (tx) => {
        // Serialises two Connect presses by this account, so replacing its row
        // neither leaves an older token usable nor sweeps away another owner's
        // attempt.
        await tx.execute(
          sql`select ${accounts.id} from ${accounts} where ${accounts.id} = ${grant.accountId} for update`,
        );
        await tx.delete(wooGrants).where(eq(wooGrants.accountId, grant.accountId));
        await tx.insert(wooGrants).values({
          token: grant.token,
          accountId: grant.accountId,
          shopUrl: grant.shopUrl,
          currency: grant.currency?.code ?? null,
          currencyDecimals: grant.currency?.decimals ?? null,
          expiresAt: grant.expiresAt,
          createdAt: grant.startedAt,
        });
      });
    },

    async connectFromGrant(token, keys, now) {
      return await db.transaction(async (tx) => {
        const [seen] = await tx
          .select({ accountId: wooGrants.accountId })
          .from(wooGrants)
          .where(eq(wooGrants.token, token))
          .limit(1);
        if (seen === undefined) return null;

        // The same lock `beginGrant` takes, so whichever operation holds it
        // completes before the other reads the account's current grant.
        await tx.execute(
          sql`select ${accounts.id} from ${accounts} where ${accounts.id} = ${seen.accountId} for update`,
        );
        const [account] = await tx
          .select({ merchantId: accounts.merchantId })
          .from(accounts)
          .where(eq(accounts.id, seen.accountId));
        // Never failing the connection: a callback that failed would have the
        // shop take its key back.
        const resulted = (settled: Parameters<typeof connectionResult>[2]) =>
          recordAlong(
            tx,
            connectionResult(seen.accountId, account?.merchantId ?? null, settled),
            now,
          );
        const [grant] = await tx
          .delete(wooGrants)
          .where(
            and(
              eq(wooGrants.token, token),
              eq(wooGrants.accountId, seen.accountId),
              gt(wooGrants.expiresAt, now),
            ),
          )
          .returning();
        if (grant === undefined) {
          // Still there, it was late; gone, another callback spent it first,
          // and that one's result is the one recorded.
          const [late] = await tx
            .select({ token: wooGrants.token })
            .from(wooGrants)
            .where(and(eq(wooGrants.token, token), eq(wooGrants.accountId, seen.accountId)));
          if (late !== undefined)
            await resulted({ outcome: "blocked", reason_code: "session_expired" });
          return null;
        }

        const [connected] = await tx
          .select({ shopUrl: wooShops.shopUrl })
          .from(wooShops)
          .where(eq(wooShops.accountId, grant.accountId));
        if (
          connected !== undefined &&
          new URL(connected.shopUrl).origin !== new URL(grant.shopUrl).origin
        ) {
          await resulted({ outcome: "blocked", reason_code: "identity_mismatch" });
          return null;
        }

        const connection: WooConnection = {
          accountId: grant.accountId,
          shopUrl: grant.shopUrl,
          ...keys,
          revision: token,
          connectedAt: now,
          currency: currencyOfRow(grant),
        };
        const written = {
          shopUrl: connection.shopUrl,
          consumerKey: connection.consumerKey,
          consumerSecret: connection.consumerSecret,
          permissions: connection.permissions,
          revision: connection.revision,
          connectedAt: connection.connectedAt,
          currency: connection.currency?.code ?? null,
          currencyDecimals: connection.currency?.decimals ?? null,
        };
        await tx
          .insert(wooShops)
          .values({ accountId: connection.accountId, ...written })
          .onConflictDoUpdate({ target: wooShops.accountId, set: written });
        await resulted({ outcome: "completed" });
        return connection;
      });
    },

    async grantFor(accountId) {
      const [row] = await db
        .select()
        .from(wooGrants)
        .where(eq(wooGrants.accountId, accountId))
        .orderBy(desc(wooGrants.createdAt))
        .limit(1);
      return row === undefined
        ? null
        : {
            token: row.token,
            accountId: row.accountId,
            shopUrl: row.shopUrl,
            currency: currencyOfRow(row),
            startedAt: row.createdAt,
            expiresAt: row.expiresAt,
          };
    },

    async connect(connection) {
      const written = {
        shopUrl: connection.shopUrl,
        consumerKey: connection.consumerKey,
        consumerSecret: connection.consumerSecret,
        permissions: connection.permissions,
        revision: connection.revision,
        connectedAt: connection.connectedAt,
        currency: connection.currency?.code ?? null,
        currencyDecimals: connection.currency?.decimals ?? null,
      };
      await db
        .insert(wooShops)
        .values({ accountId: connection.accountId, ...written })
        .onConflictDoUpdate({ target: wooShops.accountId, set: written });
    },

    async connectionOf(accountId) {
      const [row] = await db.select().from(wooShops).where(eq(wooShops.accountId, accountId));
      return row === undefined ? null : connectionOfRow(row);
    },

    async forget(accountId) {
      return await db.transaction(async (tx) => {
        // The same account lock as `beginGrant` and `connectFromGrant`:
        // whichever of a callback and Forget wins, no callback can bring the
        // connection back afterwards.
        await tx.execute(
          sql`select ${accounts.id} from ${accounts} where ${accounts.id} = ${accountId} for update`,
        );
        const [connection] = await tx
          .delete(wooShops)
          .where(eq(wooShops.accountId, accountId))
          .returning({ shopUrl: wooShops.shopUrl });
        await tx.delete(wooGrants).where(eq(wooGrants.accountId, accountId));
        return connection?.shopUrl ?? null;
      });
    },

    async connections() {
      return (await db.select().from(wooShops)).map(connectionOfRow);
    },

    async noteCurrency(accountId, currency) {
      await db
        .update(wooShops)
        .set({ currency: currency.code, currencyDecimals: currency.decimals })
        .where(eq(wooShops.accountId, accountId));
    },

    async saveRate(accountId, shopOrigin, entry) {
      const [row] = await db
        .insert(wooRates)
        .values({
          accountId,
          shopOrigin,
          currency: entry.currency,
          rate: entry.rate,
          setAt: entry.setAt,
          setBy: entry.setBy,
          referenceRate: entry.reference?.rate ?? null,
          referenceSource: entry.reference?.source ?? null,
          referenceReadAt: entry.reference?.readAt ?? null,
          confirmed: entry.confirmed,
        })
        .returning();
      if (row === undefined) throw new Error("a saved rate came back with no row");
      return savedRateOfRow(row);
    },

    async currentRate(accountId, shopOrigin, currency) {
      const [row] = await db
        .select()
        .from(wooRates)
        .where(
          and(
            eq(wooRates.accountId, accountId),
            eq(wooRates.shopOrigin, shopOrigin),
            eq(wooRates.currency, currency),
          ),
        )
        .orderBy(desc(wooRates.version))
        .limit(1);
      return row === undefined ? null : savedRateOfRow(row);
    },

    async recordQuote(accountId, priceId, merchantItemId, binding, expiresAt, now) {
      await db
        .insert(wooQuotes)
        .values({
          accountId,
          priceId,
          merchantItemId,
          productFingerprint: binding.fingerprint,
          shopAmount: binding.inTheShop.amount,
          shopCurrency: binding.inTheShop.currency,
          dollars: binding.paid.amount,
          rateVersion: binding.rateVersion,
          expiresAt,
          createdAt: now,
        })
        .onConflictDoNothing({ target: wooQuotes.priceId });
      const [row] = await db.select().from(wooQuotes).where(eq(wooQuotes.priceId, priceId));
      return (
        row?.accountId === accountId &&
        row.merchantItemId === merchantItemId &&
        row.productFingerprint === binding.fingerprint &&
        row.shopAmount === binding.inTheShop.amount &&
        row.shopCurrency === binding.inTheShop.currency &&
        row.dollars === binding.paid.amount &&
        row.rateVersion === binding.rateVersion
      );
    },

    async quotedSale(accountId, priceId, merchantItemId) {
      const [row] = await db
        .select({ quote: wooQuotes, rate: wooRates })
        .from(wooQuotes)
        .leftJoin(
          wooRates,
          and(eq(wooRates.version, wooQuotes.rateVersion), eq(wooRates.accountId, accountId)),
        )
        .where(
          and(
            eq(wooQuotes.priceId, priceId),
            eq(wooQuotes.accountId, accountId),
            eq(wooQuotes.merchantItemId, merchantItemId),
          ),
        );
      return row === undefined ? null : bindingOf(row.quote, row.rate);
    },

    async claimOrder(accountId, orderId, facts, now) {
      const [claimed] = await db
        .insert(wooOrders)
        .values({ orderId, accountId, facts, attemptedAt: now })
        .onConflictDoNothing({ target: wooOrders.orderId })
        .returning();
      if (claimed !== undefined) {
        return { kind: "ours" };
      }

      const [row] = await db.select().from(wooOrders).where(eq(wooOrders.orderId, orderId));
      if (row === undefined) {
        // No product path deletes a claim. Reporting ownership without its row
        // would let the caller place an order that cannot be bound, and a later
        // hand-over place it again.
        throw new Error(`the durable Woo order claim for ${orderId} disappeared`);
      }
      return claimOf(row);
    },

    async knownOrder(orderId) {
      const [row] = await db.select().from(wooOrders).where(eq(wooOrders.orderId, orderId));
      return row === undefined ? null : claimOf(row);
    },

    async recordPrecreateRefusal(accountId, orderId, facts, now) {
      await db
        .insert(wooOrders)
        .values({ orderId, accountId, phase: "precreate_refused", facts, attemptedAt: now })
        .onConflictDoNothing({ target: wooOrders.orderId });
    },

    async recordOrder(orderId, placed, now) {
      const bound = await db
        .update(wooOrders)
        .set({
          phase: "placed",
          wooOrderId: placed.id,
          wooOrderNumber: placed.number,
          wooOrderTotal: placed.total,
          result: placed.permission,
          placedAt: now,
        })
        .where(
          and(
            eq(wooOrders.orderId, orderId),
            eq(wooOrders.phase, "create_unknown"),
            isNull(wooOrders.wooOrderId),
          ),
        )
        .returning({ orderId: wooOrders.orderId });
      return bound.length === 1;
    },

    async recoveryOrder(orderId) {
      const [row] = await db.select().from(wooOrders).where(eq(wooOrders.orderId, orderId));
      if (row === undefined || row.facts === null) return null;
      if (
        row.phase !== "precreate_refused" &&
        row.phase !== "create_unknown" &&
        row.phase !== "placed"
      ) {
        return null;
      }
      return {
        orderId: row.orderId,
        accountId: row.accountId,
        phase: row.phase,
        facts: row.facts as WooOrderFacts,
        placed:
          row.wooOrderId === null ||
          row.wooOrderNumber === null ||
          (row.result === null && row.phase !== "placed")
            ? null
            : {
                id: row.wooOrderId,
                number: row.wooOrderNumber,
                permission: row.result === null ? null : (row.result as WooPermission),
              },
      };
    },

    async shopTotals(accountId, orderIds) {
      if (orderIds.length === 0) return {};
      const rows = await db
        .select({
          orderId: wooOrders.orderId,
          total: wooOrders.wooOrderTotal,
          converted: sql<ConvertedSale | null>`${wooOrders.facts} -> 'converted'`,
        })
        .from(wooOrders)
        .where(
          and(
            eq(wooOrders.accountId, accountId),
            inArray(wooOrders.orderId, [...orderIds]),
            isNotNull(wooOrders.wooOrderTotal),
          ),
        );
      return Object.fromEntries(
        rows.map((row) => [row.orderId, { total: row.total ?? "", converted: row.converted }]),
      );
    },

    async recoverableOrders(accountId, orderIds) {
      if (orderIds.length === 0) return [];
      const rows = await db
        .select({ orderId: wooOrders.orderId })
        .from(wooOrders)
        .where(
          and(
            eq(wooOrders.accountId, accountId),
            inArray(wooOrders.orderId, [...orderIds]),
            isNotNull(wooOrders.facts),
            sql`${wooOrders.facts} ->> 'kind' is distinct from 'parcel'`,
            or(
              eq(wooOrders.phase, "create_unknown"),
              and(eq(wooOrders.phase, "placed"), isNotNull(wooOrders.result)),
            ),
          ),
        )
        .orderBy(asc(wooOrders.orderId));
      return rows.map((row) => row.orderId);
    },

    async parcelsToFollow(accountId) {
      return await db
        .select({
          orderId: wooOrders.orderId,
          wooOrderId: wooOrders.wooOrderId,
          shopOrigin: sql<string | null>`${wooOrders.facts}->>'shopOrigin'`,
          placedAt: wooOrders.placedAt,
        })
        .from(wooOrders)
        .where(
          and(
            eq(wooOrders.accountId, accountId),
            eq(wooOrders.phase, "placed"),
            isNull(wooOrders.result),
            isNotNull(wooOrders.wooOrderId),
          ),
        )
        .orderBy(asc(wooOrders.placedAt), asc(wooOrders.orderId))
        .then((rows) =>
          rows.flatMap((row) =>
            row.wooOrderId === null || row.shopOrigin === null || row.placedAt === null
              ? []
              : [
                  {
                    orderId: row.orderId,
                    wooOrderId: row.wooOrderId,
                    shopOrigin: row.shopOrigin,
                    placedAt: row.placedAt,
                  },
                ],
          ),
        );
    },

    async endParcel(orderId, phase, _now) {
      const ended = await db
        .update(wooOrders)
        .set({ phase })
        .where(
          and(
            eq(wooOrders.orderId, orderId),
            eq(wooOrders.phase, "placed"),
            isNull(wooOrders.result),
          ),
        )
        .returning({ orderId: wooOrders.orderId });
      return ended.length === 1;
    },

    async beginPrecreateRecovery(orderId, revision, now) {
      const reopened = await db
        .update(wooOrders)
        .set({
          phase: "create_unknown",
          attemptedAt: now,
          facts: sql`${wooOrders.facts} || jsonb_build_object('connectionRevision', cast(${revision} as text))`,
        })
        .where(
          and(
            eq(wooOrders.orderId, orderId),
            eq(wooOrders.phase, "precreate_refused"),
            ne(sql`${wooOrders.facts}->>'connectionRevision'`, revision),
          ),
        )
        .returning({ orderId: wooOrders.orderId });
      return reopened.length === 1;
    },
  };
};

/**
 * In the product tree rather than under `testing/`, so the two implementations
 * can be read side by side.
 */
/**
 * Kept in memory for tests, with what it recorded for product analytics in the
 * order recorded. It knows no accounts, so its events name no merchant.
 */
export const memoryWooShops = (): WooShops & {
  readonly recordedAnalytics: readonly { readonly event: AnalyticsEvent; readonly at: Date }[];
} => {
  const analytics: { event: AnalyticsEvent; at: Date }[] = [];
  const grants = new Map<string, WooGrant>();
  const shops = new Map<string, WooConnection>();
  const quotes = new Map<
    string,
    { accountId: string; merchantItemId: string; binding: QuoteToBind }
  >();
  const rates: (SavedRate & { accountId: string; shopOrigin: string })[] = [];
  const orders = new Map<
    string,
    {
      accountId: string;
      attemptedAt: Date;
      phase: "precreate_refused" | "create_unknown" | "placed" | "shipped" | "closed";
      facts: WooOrderFacts;
      placedAt?: Date;
      /** What the shop's order totals, once placed. */
      total?: string;
      placed: {
        id: string;
        number: string;
        permission: WooPermission | null;
      } | null;
    }
  >();

  const rowOf = (found: {
    phase: string;
    attemptedAt: Date;
    placed: { id: string; number: string; permission: WooPermission | null } | null;
  }) => ({
    phase: found.phase,
    wooOrderId: found.placed?.id ?? null,
    wooOrderNumber: found.placed?.number ?? null,
    result: found.placed?.permission ?? null,
    attemptedAt: found.attemptedAt,
  });

  return {
    get recordedAnalytics() {
      return [...analytics];
    },

    async recordAnalytics(event, at) {
      analytics.push({ event, at });
    },

    async beginGrant(grant) {
      for (const [token, found] of grants) {
        if (found.accountId === grant.accountId) {
          grants.delete(token);
        }
      }
      grants.set(grant.token, grant);
    },

    async connectFromGrant(token, keys, now) {
      const grant = grants.get(token);
      if (grant === undefined) return null;
      const resulted = (settled: Parameters<typeof connectionResult>[2]) => {
        analytics.push({ event: connectionResult(grant.accountId, null, settled), at: now });
      };
      if (grant.expiresAt.getTime() <= now.getTime()) {
        resulted({ outcome: "blocked", reason_code: "session_expired" });
        return null;
      }
      // `beginGrant` keeps exactly one row per account, so a present token is
      // still the current intent; consume and write happen with no await
      // between them.
      grants.delete(token);
      const connected = shops.get(grant.accountId);
      if (
        connected !== undefined &&
        new URL(connected.shopUrl).origin !== new URL(grant.shopUrl).origin
      ) {
        resulted({ outcome: "blocked", reason_code: "identity_mismatch" });
        return null;
      }
      const connection: WooConnection = {
        accountId: grant.accountId,
        shopUrl: grant.shopUrl,
        ...keys,
        revision: token,
        connectedAt: now,
        currency: grant.currency,
      };
      shops.set(grant.accountId, connection);
      resulted({ outcome: "completed" });
      return connection;
    },

    async grantFor(accountId) {
      // A Map keeps insertion order, so the last match is the newest.
      let newest: WooGrant | null = null;
      for (const grant of grants.values()) {
        if (grant.accountId !== accountId) {
          continue;
        }
        if (newest === null || grant.startedAt.getTime() >= newest.startedAt.getTime()) {
          newest = grant;
        }
      }
      return newest;
    },

    async connect(connection) {
      shops.set(connection.accountId, connection);
    },

    async connectionOf(accountId) {
      return shops.get(accountId) ?? null;
    },

    async forget(accountId) {
      const connection = shops.get(accountId);
      shops.delete(accountId);
      for (const [token, grant] of grants) {
        if (grant.accountId === accountId) grants.delete(token);
      }
      return connection?.shopUrl ?? null;
    },

    async connections() {
      return [...shops.values()];
    },

    async noteCurrency(accountId, currency) {
      const connection = shops.get(accountId);
      if (connection !== undefined) shops.set(accountId, { ...connection, currency });
    },

    async saveRate(accountId, shopOrigin, entry) {
      const saved = { ...entry, version: (rates.at(-1)?.version ?? 0) + 1 };
      rates.push({ ...saved, accountId, shopOrigin });
      return saved;
    },

    async currentRate(accountId, shopOrigin, currency) {
      const found = rates.findLast(
        (one) =>
          one.accountId === accountId && one.shopOrigin === shopOrigin && one.currency === currency,
      );
      if (found === undefined) return null;
      const { accountId: _account, shopOrigin: _origin, ...saved } = found;
      return saved;
    },

    async recordQuote(accountId, priceId, merchantItemId, binding) {
      const found = quotes.get(priceId);
      if (found === undefined) {
        quotes.set(priceId, { accountId, merchantItemId, binding });
        return true;
      }
      return (
        found.accountId === accountId &&
        found.merchantItemId === merchantItemId &&
        found.binding.fingerprint === binding.fingerprint &&
        sameMoney(found.binding.inTheShop, binding.inTheShop) &&
        sameMoney(found.binding.paid, binding.paid) &&
        found.binding.rateVersion === binding.rateVersion
      );
    },

    async quotedSale(accountId, priceId, merchantItemId) {
      const found = quotes.get(priceId);
      if (found?.accountId !== accountId || found.merchantItemId !== merchantItemId) return null;
      const rate = rates.find(
        (one) => one.version === found.binding.rateVersion && one.accountId === accountId,
      );
      return bindingOf(
        {
          productFingerprint: found.binding.fingerprint,
          shopAmount: found.binding.inTheShop.amount,
          shopCurrency: found.binding.inTheShop.currency,
          dollars: found.binding.paid.amount,
          rateVersion: found.binding.rateVersion,
        },
        rate ?? null,
      );
    },

    async claimOrder(accountId, orderId, facts, now) {
      const found = orders.get(orderId);
      if (found === undefined) {
        orders.set(orderId, {
          accountId,
          attemptedAt: now,
          phase: "create_unknown",
          facts,
          placed: null,
        });
        return { kind: "ours" };
      }
      return claimOf(rowOf(found));
    },

    async knownOrder(orderId) {
      const found = orders.get(orderId);
      return found === undefined ? null : claimOf(rowOf(found));
    },

    async recordPrecreateRefusal(accountId, orderId, facts, now) {
      const found = orders.get(orderId);
      if (found === undefined) {
        orders.set(orderId, {
          accountId,
          attemptedAt: now,
          phase: "precreate_refused",
          facts,
          placed: null,
        });
      }
    },

    async recordOrder(orderId, placed, now) {
      const found = orders.get(orderId);
      if (found !== undefined && found.phase === "create_unknown" && found.placed === null) {
        const { total, ...kept } = placed;
        orders.set(orderId, { ...found, phase: "placed", placed: kept, total, placedAt: now });
        return true;
      }
      return false;
    },

    async recoveryOrder(orderId) {
      const found = orders.get(orderId);
      // As the Postgres store reads it: a parcel followed no further has no
      // phase recovery knows.
      if (found === undefined || found.phase === "shipped" || found.phase === "closed") return null;
      const { placedAt: _placedAt, total: _total, ...kept } = found;
      return { orderId, ...kept, phase: found.phase };
    },

    async shopTotals(accountId, orderIds) {
      const asked = new Set(orderIds);
      return Object.fromEntries(
        [...orders.entries()].flatMap(([orderId, found]) =>
          asked.has(orderId) && found.accountId === accountId && found.total !== undefined
            ? [[orderId, { total: found.total, converted: found.facts.converted ?? null }]]
            : [],
        ),
      );
    },

    async recoverableOrders(accountId, orderIds) {
      const asked = new Set(orderIds);
      return [...orders.entries()]
        .flatMap(([orderId, found]) =>
          asked.has(orderId) &&
          found.accountId === accountId &&
          found.facts.kind !== "parcel" &&
          (found.phase === "create_unknown" ||
            (found.phase === "placed" && found.placed?.permission != null))
            ? [orderId]
            : [],
        )
        .sort();
    },

    async parcelsToFollow(accountId) {
      return [...orders.entries()].flatMap(([orderId, found]) =>
        found.accountId === accountId &&
        found.phase === "placed" &&
        found.placed !== null &&
        found.placed.permission === null &&
        found.placedAt !== undefined
          ? [
              {
                orderId,
                wooOrderId: found.placed.id,
                shopOrigin: found.facts.shopOrigin,
                placedAt: found.placedAt,
              },
            ]
          : [],
      );
    },

    async endParcel(orderId, phase) {
      const found = orders.get(orderId);
      if (found?.phase !== "placed" || found.placed?.permission !== null) return false;
      orders.set(orderId, { ...found, phase });
      return true;
    },

    async beginPrecreateRecovery(orderId, revision, now) {
      const found = orders.get(orderId);
      if (
        found === undefined ||
        found.phase !== "precreate_refused" ||
        found.facts.connectionRevision === revision
      ) {
        return false;
      }
      orders.set(orderId, {
        ...found,
        phase: "create_unknown",
        attemptedAt: now,
        facts: { ...found.facts, connectionRevision: revision },
      });
      return true;
    },
  };
};

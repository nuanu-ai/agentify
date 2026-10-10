/**
 * Where a merchant's WooCommerce connection is kept: the Connect that is under
 * way, the shop that is connected, and the orders already placed in it.
 *
 * It is a port with two implementations for the reason the identity store has
 * two — `pnpm test` is free, deterministic and offline, and a deployment has a
 * Postgres. Both are held to one contract test, because the half of this that
 * matters is not "a row can be written": it is that a state token works once
 * and only once, and that an order already placed in somebody's shop is never
 * placed a second time. Neither of those is visible in a schema.
 *
 * ADR-0014 §2 is the shape of the argument for keeping the shop's key and
 * secret as the shop issued them, and the decision record for this channel
 * carries the part that is different here: the secret belongs to a third party.
 */

import { and, asc, desc, eq, gt, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { accounts, wooGrants, wooOrders, wooQuotes, wooShops } from "./schema.js";

/** A Connect a merchant started, waiting for their shop to answer. */
export interface WooGrant {
  /** The unguessable one-time value that travelled as `user_id`. */
  readonly token: string;
  readonly accountId: string;
  readonly shopUrl: string;
  /**
   * When the merchant pressed Connect.
   *
   * Written by the caller rather than by the store, so that the two
   * implementations cannot disagree about it and so that a test can put a
   * Connect in the past without waiting a quarter of an hour. It is what the
   * screens count "started four minutes ago" from.
   */
  readonly startedAt: Date;
  readonly expiresAt: Date;
}

/** A merchant's connected shop, with the credentials it granted. */
export interface WooConnection {
  readonly accountId: string;
  readonly shopUrl: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
  /** What the shop says the keys are good for — `read_write`, or less. */
  readonly permissions: string;
  readonly revision: string;
  readonly connectedAt: Date;
}

export interface WooOrderFacts extends Readonly<Record<string, unknown>> {
  /**
   * `parcel` for a parcel's sale; absent for a download's, which is every sale
   * written before parcels were sold. Nothing of where a parcel goes is here.
   */
  readonly kind?: "parcel";
  readonly shopOrigin: string;
  readonly connectionRevision: string;
  readonly merchantItemId: string;
  readonly priceId: string;
  readonly productId: string;
  readonly productFingerprint: string;
  readonly amount: string;
  readonly currency: string;
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

/** A parcel's sale, and the shop's order to read for whether it shipped. */
export interface ParcelToFollow {
  readonly orderId: string;
  readonly wooOrderId: string;
  /** The shop it was sold from, whose order the id is. */
  readonly shopOrigin: string;
  /** When the shop's order was bound to the sale. */
  readonly placedAt: Date;
}

export interface WooRecoveryOrder {
  readonly orderId: string;
  readonly accountId: string;
  readonly phase: "precreate_refused" | "create_unknown" | "placed";
  readonly facts: WooOrderFacts;
  readonly placed: {
    readonly id: string;
    readonly number: string;
    /** The download's permission; null for a parcel, whose shop order is the whole result. */
    readonly permission: WooPermission | null;
  } | null;
}

/**
 * What is known about an order we may already have placed in a shop.
 *
 * The three words are three different things to do, and folding any two of them
 * together costs somebody something real. `ours` is a sale nobody has placed
 * yet and this attempt owns it. `placed` is a repeat of a sale that already
 * went through, which is answered with the number the shop gave it and no
 * second order. `unknown` is the one that cannot be repaired here: an earlier
 * attempt reached the point of calling the shop and never came back, so whether
 * that shop holds an order for this sale is not something anybody on this side
 * can find out.
 */
export type OrderClaim =
  | { readonly kind: "ours" }
  | { readonly kind: "precreate_refused" }
  | {
      readonly kind: "placed";
      readonly id: string;
      readonly number: string;
      readonly permission: WooPermission;
    }
  /** A parcel's order the shop holds, which is answered by taking it on again. */
  | { readonly kind: "placed_parcel"; readonly id: string; readonly number: string }
  | { readonly kind: "unknown"; readonly attemptedAt: Date };

// The ledger is monotone: absent may become precreate_refused or
// create_unknown; explicit recovery alone moves precreate_refused to
// create_unknown; validated binding alone moves create_unknown to placed; a
// placed download never changes, and a placed parcel moves once more, to
// shipped or closed, when it is followed no further. The store methods below
// are the transition boundary.

export interface WooShops {
  /** Writes down a Connect that is under way. */
  beginGrant(grant: WooGrant): Promise<void>;
  /**
   * Consumes the still-current grant and writes its connection as one
   * account-serialised operation, or answers null.
   *
   * A callback is unauthenticated and may arrive after the merchant has begun
   * another Connect. Splitting consume from connect would let that older
   * callback overwrite the newer intent in between the two writes.
   *
   * Null covers every way of not being a live Connect and does not distinguish
   * them: a token nobody issued, a token already spent, a token whose fifteen
   * minutes are up. The caller has the same answer for all three, and telling
   * them apart on a route anybody can post to would be answering questions
   * about somebody else's account. An expired row stays so the owner can still
   * see the attempt that ended; beginning their next Connect replaces it.
   */
  connectFromGrant(
    token: string,
    keys: Pick<WooConnection, "consumerKey" | "consumerSecret" | "permissions">,
    now: Date,
  ): Promise<WooConnection | null>;
  /**
   * The Connect this account started and nothing has come back for, or null.
   *
   * Read by the screens and by nothing on the callback path, which is what
   * keeps it from being a second way to spend a token: it answers by account
   * and never by token, so holding one tells nobody anything they can use.
   * Expired is not filtered out here — a Connect whose fifteen minutes ran out
   * with no keys is precisely the case a merchant needs a sentence about, and
   * the screen is where the clock is read.
   *
   * The newest, where a merchant pressed Connect twice: it is the one they are
   * waiting on, and the older rows go on the next press anyway.
   */
  grantFor(accountId: string): Promise<WooGrant | null>;
  /** Writes the connection, replacing whatever that account had before. */
  connect(connection: WooConnection): Promise<void>;
  connectionOf(accountId: string): Promise<WooConnection | null>;
  /**
   * Forgets the connected shop and every Connect intent for this account.
   *
   * The public shop URL is returned only so the dashboard can leave the fresh
   * form filled in. Cards and accepted orders belong to different stores and
   * are deliberately untouched.
   */
  forget(accountId: string): Promise<string | null>;
  /** Every connected shop, which is what the worker draws its work from. */
  connections(): Promise<readonly WooConnection[]>;
  /** Persists the delivery identity accepted for one gateway price question. */
  recordQuote(
    accountId: string,
    priceId: string,
    merchantItemId: string,
    productFingerprint: string,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean>;
  quotedProduct(accountId: string, priceId: string, merchantItemId: string): Promise<string | null>;

  /**
   * Takes this sale on, or says what is already known about it.
   *
   * Writing the claim is the act, not a check before one: two of these for the
   * same order — a redelivery arriving while the first attempt is still in
   * flight — must not both come back `ours`, and that is settled by the
   * database's own uniqueness rather than by a read followed by a write.
   *
   * The order's own identifier is the key and the account is written beside it
   * rather than being part of it. That is right because an order identifier is
   * issued by the gateway from a random source and is unique across every
   * merchant on it, so two merchants cannot name one sale — and it is worth
   * saying out loud, because the account column reads like half of a key and is
   * not one. Anything that ever made order identifiers unique per merchant
   * instead would make this row the place two merchants' sales meet, and one
   * buyer would be handed the other merchant's shop order number.
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
   * Completes a claim with what the shop answered: a download's permission,
   * or null for a parcel, whose order in the shop is all there is to keep.
   */
  recordOrder(
    orderId: string,
    placed: {
      id: string;
      number: string;
      permission: WooPermission | null;
    },
    now: Date,
  ): Promise<boolean>;
  /** Exact private recovery state; absent or legacy rows are not recoverable. */
  recoveryOrder(orderId: string): Promise<WooRecoveryOrder | null>;
  /** This account's parcels the shop holds that have neither shipped nor ended. */
  parcelsToFollow(accountId: string): Promise<readonly ParcelToFollow[]>;
  /**
   * Stops following a placed parcel: `shipped` once its shipment is recorded
   * with the gateway, `closed` once it can no longer be — the shop ended the
   * order, or the gateway refused the shipment. Once only: a parcel already
   * ended is left as it is, and the answer says whether this call ended it.
   */
  endParcel(orderId: string, phase: "shipped" | "closed", now: Date): Promise<boolean>;
  /**
   * Reopens only a definite pre-create refusal under a different grant.
   * The compare-and-set is what keeps two operator commands to one POST.
   */
  beginPrecreateRecovery(orderId: string, revision: string, now: Date): Promise<boolean>;
}

/** The phases of a parcel the shop holds: still followed, shipped, or let go. */
const PARCEL_PLACED = new Set(["placed", "shipped", "closed"]);

/**
 * What a ledger row says about its sale, read the same way by both stores.
 *
 * A row holding the shop's order and a permission is a download placed, in
 * whatever phase it was written: rows from before the ledger had phases read
 * `create_unknown` and were placed all the same. A row placed with no
 * permission is a parcel's: its order in the shop is the whole of what was
 * made, and redelivery answers it by taking the order on again.
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

/** The store a deployment runs on. */
export const postgresWooShops = (pool: Pool): WooShops => {
  const db = drizzle(pool);

  return {
    async beginGrant(grant) {
      await db.transaction(async (tx) => {
        // Serialise two Connect presses by this account. Replacing its own row
        // must neither leave an older token usable nor sweep another owner's
        // explanation away.
        await tx.execute(
          sql`select ${accounts.id} from ${accounts} where ${accounts.id} = ${grant.accountId} for update`,
        );
        await tx.delete(wooGrants).where(eq(wooGrants.accountId, grant.accountId));
        await tx.insert(wooGrants).values({
          token: grant.token,
          accountId: grant.accountId,
          shopUrl: grant.shopUrl,
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

        // The same lock beginGrant takes. Whichever operation owns it first is
        // complete before the other observes the account's current grant.
        await tx.execute(
          sql`select ${accounts.id} from ${accounts} where ${accounts.id} = ${seen.accountId} for update`,
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
        if (grant === undefined) return null;

        const connection: WooConnection = {
          accountId: grant.accountId,
          shopUrl: grant.shopUrl,
          ...keys,
          revision: token,
          connectedAt: now,
        };
        await tx
          .insert(wooShops)
          .values(connection)
          .onConflictDoUpdate({
            target: wooShops.accountId,
            set: {
              shopUrl: connection.shopUrl,
              consumerKey: connection.consumerKey,
              consumerSecret: connection.consumerSecret,
              permissions: connection.permissions,
              revision: connection.revision,
              connectedAt: connection.connectedAt,
            },
          });
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
            startedAt: row.createdAt,
            expiresAt: row.expiresAt,
          };
    },

    async connect(connection) {
      await db
        .insert(wooShops)
        .values({
          accountId: connection.accountId,
          shopUrl: connection.shopUrl,
          consumerKey: connection.consumerKey,
          consumerSecret: connection.consumerSecret,
          permissions: connection.permissions,
          revision: connection.revision,
          connectedAt: connection.connectedAt,
        })
        .onConflictDoUpdate({
          target: wooShops.accountId,
          set: {
            shopUrl: connection.shopUrl,
            consumerKey: connection.consumerKey,
            consumerSecret: connection.consumerSecret,
            permissions: connection.permissions,
            revision: connection.revision,
            connectedAt: connection.connectedAt,
          },
        });
    },

    async connectionOf(accountId) {
      const [row] = await db.select().from(wooShops).where(eq(wooShops.accountId, accountId));
      return row === undefined ? null : row;
    },

    async forget(accountId) {
      return await db.transaction(async (tx) => {
        // The same account lock as beginGrant/connectFromGrant: whichever of a
        // callback and Forget wins, Forget leaves no callback capable of
        // resurrecting the connection afterwards.
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
      return await db.select().from(wooShops);
    },

    async recordQuote(accountId, priceId, merchantItemId, productFingerprint, expiresAt, now) {
      await db
        .insert(wooQuotes)
        .values({
          accountId,
          priceId,
          merchantItemId,
          productFingerprint,
          expiresAt,
          createdAt: now,
        })
        .onConflictDoNothing({ target: wooQuotes.priceId });
      const [row] = await db.select().from(wooQuotes).where(eq(wooQuotes.priceId, priceId));
      return (
        row?.accountId === accountId &&
        row.merchantItemId === merchantItemId &&
        row.productFingerprint === productFingerprint
      );
    },

    async quotedProduct(accountId, priceId, merchantItemId) {
      const [row] = await db
        .select({ fingerprint: wooQuotes.productFingerprint })
        .from(wooQuotes)
        .where(
          and(
            eq(wooQuotes.priceId, priceId),
            eq(wooQuotes.accountId, accountId),
            eq(wooQuotes.merchantItemId, merchantItemId),
          ),
        );
      return row?.fingerprint ?? null;
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
        // No product path deletes a claim. Reporting ownership without its
        // row would let the caller place an order that cannot be bound and a
        // later hand-over place it again.
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
 * The store the dashboard's own tests run on.
 *
 * It is in the product tree rather than under `testing/` because the contract
 * it satisfies is the product's, and because the two implementations have to be
 * read side by side: the single-use token and the single-placed order are one
 * paragraph each here and one statement each there, and a reader checking that
 * they agree should not have to go looking.
 */
export const memoryWooShops = (): WooShops => {
  const grants = new Map<string, WooGrant>();
  const shops = new Map<string, WooConnection>();
  const quotes = new Map<
    string,
    { accountId: string; merchantItemId: string; productFingerprint: string }
  >();
  const orders = new Map<
    string,
    {
      accountId: string;
      attemptedAt: Date;
      phase: "precreate_refused" | "create_unknown" | "placed" | "shipped" | "closed";
      facts: WooOrderFacts;
      placedAt?: Date;
      placed: {
        id: string;
        number: string;
        permission: WooPermission | null;
      } | null;
    }
  >();

  /** A memory entry as the row the Postgres store would read. */
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
      if (grant === undefined || grant.expiresAt.getTime() <= now.getTime()) return null;
      // beginGrant keeps exactly one row for an account. If this token is
      // present, it is still that account's current intent; consume and write
      // happen without an await in between.
      grants.delete(token);
      const connection: WooConnection = {
        accountId: grant.accountId,
        shopUrl: grant.shopUrl,
        ...keys,
        revision: token,
        connectedAt: now,
      };
      shops.set(grant.accountId, connection);
      return connection;
    },

    async grantFor(accountId) {
      // The newest, which is the one the merchant is waiting on. A Map keeps
      // insertion order, so the last match is the last one written.
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

    async recordQuote(accountId, priceId, merchantItemId, productFingerprint) {
      const found = quotes.get(priceId);
      if (found === undefined) {
        quotes.set(priceId, { accountId, merchantItemId, productFingerprint });
        return true;
      }
      return (
        found.accountId === accountId &&
        found.merchantItemId === merchantItemId &&
        found.productFingerprint === productFingerprint
      );
    },

    async quotedProduct(accountId, priceId, merchantItemId) {
      const found = quotes.get(priceId);
      return found?.accountId === accountId && found.merchantItemId === merchantItemId
        ? found.productFingerprint
        : null;
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
        orders.set(orderId, { ...found, phase: "placed", placed, placedAt: now });
        return true;
      }
      return false;
    },

    async recoveryOrder(orderId) {
      const found = orders.get(orderId);
      // As the Postgres store reads it: a parcel followed no further is no
      // phase recovery knows.
      if (found === undefined || found.phase === "shipped" || found.phase === "closed") return null;
      const { placedAt: _placedAt, ...kept } = found;
      return { orderId, ...kept, phase: found.phase };
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

/**
 * Where a merchant's WooCommerce connection is kept: the Connect under way, the
 * connected shop, and the orders already placed in it. Two implementations,
 * memory and Postgres, held to one contract test, because what matters is not
 * visible in a schema: a state token works once only, and an order placed in
 * somebody's shop is never placed twice. The shop's key and secret are a third
 * party's credentials, stored as issued.
 */

import type { SurfaceMode } from "@agentify/core";
import { and, asc, desc, eq, gt, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { accounts, wooGrants, wooOrders, wooQuotes, wooShops } from "./schema.js";

/**
 * Everywhere but live: the connector says it works in test mode only, and a
 * live parcel cannot be sold. Asked by the pages and the worker alike.
 */
export const wooOfferedOn = (surface: SurfaceMode): boolean => surface !== "live";

export interface WooGrant {
  /** Unguessable and one-time; it travels as `user_id`. */
  readonly token: string;
  readonly accountId: string;
  readonly shopUrl: string;
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

export interface ParcelToFollow {
  readonly orderId: string;
  readonly wooOrderId: string;
  /** The shop the order id belongs to. */
  readonly shopOrigin: string;
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
export type OrderClaim =
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
  beginGrant(grant: WooGrant): Promise<void>;
  /**
   * One account-serialised operation, because a callback is unauthenticated and
   * may arrive after the merchant began another Connect; split in two, the
   * older callback could overwrite the newer intent between the writes.
   *
   * Null covers a token nobody issued, one already spent and one expired,
   * without telling them apart: on a route anybody can post to, that would
   * answer questions about somebody else's account. An expired row stays so its
   * owner can still see the attempt that ended.
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
  /** A download's permission, or null for a parcel. */
  recordOrder(
    orderId: string,
    placed: {
      id: string;
      number: string;
      permission: WooPermission | null;
    },
    now: Date,
  ): Promise<boolean>;
  /** Rows without an exact recovery state are not recoverable. */
  recoveryOrder(orderId: string): Promise<WooRecoveryOrder | null>;
  /** Placed and neither shipped nor ended. */
  parcelsToFollow(accountId: string): Promise<readonly ParcelToFollow[]>;
  /**
   * `shipped` once its shipment is recorded with the gateway, `closed` once it
   * can no longer be. Once only: the answer says whether this call ended it.
   */
  endParcel(orderId: string, phase: "shipped" | "closed", now: Date): Promise<boolean>;
  /** The compare-and-set keeps two operator commands to one POST. */
  beginPrecreateRecovery(orderId: string, revision: string, now: Date): Promise<boolean>;
}

const PARCEL_PLACED = new Set(["placed", "shipped", "closed"]);

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

export const postgresWooShops = (pool: Pool): WooShops => {
  const db = drizzle(pool);

  return {
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
 * In the product tree rather than under `testing/`, so the two implementations
 * can be read side by side.
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
      // `beginGrant` keeps exactly one row per account, so a present token is
      // still the current intent; consume and write happen with no await
      // between them.
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
      // As the Postgres store reads it: a parcel followed no further has no
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

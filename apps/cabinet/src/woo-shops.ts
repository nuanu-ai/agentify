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

import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { wooGrants, wooOrders, wooShops } from "./schema.js";

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
  readonly connectedAt: Date;
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
  | { readonly kind: "placed"; readonly id: string; readonly number: string }
  | { readonly kind: "unknown"; readonly attemptedAt: Date };

export interface WooShops {
  /** Writes down a Connect that is under way. */
  beginGrant(grant: WooGrant): Promise<void>;
  /**
   * Spends a token and hands back the Connect it named, or null.
   *
   * Null covers every way of not being a live Connect and does not distinguish
   * them: a token nobody issued, a token already spent, a token whose fifteen
   * minutes are up. The caller has the same answer for all three, and telling
   * them apart on a route anybody can post to would be answering questions
   * about somebody else's account.
   *
   * The row goes whether or not it had expired, because a token that was once
   * live and is now stale is exactly the value somebody replaying an old
   * callback would be holding.
   */
  spendGrant(token: string, now: Date): Promise<WooGrant | null>;
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
  /** Clears out the Connects nobody came back for. Answers how many. */
  sweepGrants(now: Date): Promise<number>;

  /** Writes the connection, replacing whatever that account had before. */
  connect(connection: WooConnection): Promise<void>;
  connectionOf(accountId: string): Promise<WooConnection | null>;
  forget(accountId: string): Promise<void>;
  /** Every connected shop, which is what the worker draws its work from. */
  connections(): Promise<readonly WooConnection[]>;

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
  claimOrder(accountId: string, orderId: string, now: Date): Promise<OrderClaim>;
  /** Completes a claim with what the shop answered. */
  recordOrder(orderId: string, placed: { id: string; number: string }, now: Date): Promise<void>;
  /** Gives up a claim nothing came of, so the next attempt may have it. */
  releaseOrder(orderId: string): Promise<void>;
}

/** The store a deployment runs on. */
export const postgresWooShops = (pool: Pool): WooShops => {
  const db = drizzle(pool);

  return {
    async beginGrant(grant) {
      await db.insert(wooGrants).values({
        token: grant.token,
        accountId: grant.accountId,
        shopUrl: grant.shopUrl,
        expiresAt: grant.expiresAt,
        createdAt: grant.startedAt,
      });
    },

    async spendGrant(token, now) {
      // One statement, so that two callbacks carrying one token cannot both
      // find a row: the delete is the claim, and only one of them deletes it.
      const [row] = await db.delete(wooGrants).where(eq(wooGrants.token, token)).returning();
      if (row === undefined || row.expiresAt.getTime() <= now.getTime()) {
        return null;
      }
      return {
        token: row.token,
        accountId: row.accountId,
        shopUrl: row.shopUrl,
        startedAt: row.createdAt,
        expiresAt: row.expiresAt,
      };
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

    async sweepGrants(now) {
      const gone = await db.delete(wooGrants).where(lt(wooGrants.expiresAt, now)).returning();
      return gone.length;
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
          connectedAt: connection.connectedAt,
        })
        .onConflictDoUpdate({
          target: wooShops.accountId,
          set: {
            shopUrl: connection.shopUrl,
            consumerKey: connection.consumerKey,
            consumerSecret: connection.consumerSecret,
            permissions: connection.permissions,
            connectedAt: connection.connectedAt,
          },
        });
    },

    async connectionOf(accountId) {
      const [row] = await db.select().from(wooShops).where(eq(wooShops.accountId, accountId));
      return row === undefined ? null : row;
    },

    async forget(accountId) {
      await db.delete(wooShops).where(eq(wooShops.accountId, accountId));
    },

    async connections() {
      return await db.select().from(wooShops);
    },

    async claimOrder(accountId, orderId, now) {
      const [claimed] = await db
        .insert(wooOrders)
        .values({ orderId, accountId, attemptedAt: now })
        .onConflictDoNothing({ target: wooOrders.orderId })
        .returning();
      if (claimed !== undefined) {
        return { kind: "ours" };
      }

      const [row] = await db.select().from(wooOrders).where(eq(wooOrders.orderId, orderId));
      if (row === undefined) {
        // The row was there a moment ago and is not now, which is a release
        // racing this claim. Nothing was placed under it, so this attempt may
        // have the sale.
        return { kind: "ours" };
      }
      if (row.wooOrderId !== null && row.wooOrderNumber !== null) {
        return { kind: "placed", id: row.wooOrderId, number: row.wooOrderNumber };
      }
      return { kind: "unknown", attemptedAt: row.attemptedAt };
    },

    async recordOrder(orderId, placed, now) {
      await db
        .update(wooOrders)
        .set({ wooOrderId: placed.id, wooOrderNumber: placed.number, placedAt: now })
        .where(eq(wooOrders.orderId, orderId));
    },

    async releaseOrder(orderId) {
      // Only a claim nothing came of. A row carrying an order number is the
      // record of an order in somebody's shop, and removing it would let the
      // next repeat place a second one.
      await db
        .delete(wooOrders)
        .where(and(eq(wooOrders.orderId, orderId), isNull(wooOrders.wooOrderId)));
    },
  };
};

/**
 * The store the cabinet's own tests run on.
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
  const orders = new Map<
    string,
    { accountId: string; attemptedAt: Date; placed: { id: string; number: string } | null }
  >();

  return {
    async beginGrant(grant) {
      grants.set(grant.token, grant);
    },

    async spendGrant(token, now) {
      const found = grants.get(token);
      // Deleted whether or not it was still live, for the reason the port
      // gives: a stale token is what a replayed callback carries.
      grants.delete(token);
      if (found === undefined || found.expiresAt.getTime() <= now.getTime()) {
        return null;
      }
      return found;
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

    async sweepGrants(now) {
      let gone = 0;
      for (const [token, grant] of grants) {
        if (grant.expiresAt.getTime() < now.getTime()) {
          grants.delete(token);
          gone += 1;
        }
      }
      return gone;
    },

    async connect(connection) {
      shops.set(connection.accountId, connection);
    },

    async connectionOf(accountId) {
      return shops.get(accountId) ?? null;
    },

    async forget(accountId) {
      shops.delete(accountId);
    },

    async connections() {
      return [...shops.values()];
    },

    async claimOrder(accountId, orderId, now) {
      const found = orders.get(orderId);
      if (found === undefined) {
        orders.set(orderId, { accountId, attemptedAt: now, placed: null });
        return { kind: "ours" };
      }
      if (found.placed !== null) {
        return { kind: "placed", id: found.placed.id, number: found.placed.number };
      }
      return { kind: "unknown", attemptedAt: found.attemptedAt };
    },

    async recordOrder(orderId, placed) {
      const found = orders.get(orderId);
      if (found !== undefined) {
        orders.set(orderId, { ...found, placed });
      }
    },

    async releaseOrder(orderId) {
      const found = orders.get(orderId);
      if (found !== undefined && found.placed === null) {
        orders.delete(orderId);
      }
    },
  };
};

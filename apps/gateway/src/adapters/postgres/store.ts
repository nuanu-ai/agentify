/**
 * The store, on one Postgres, through drizzle. `withOrder` holds an order with
 * a row lock (`select ... for update`) inside a transaction, so two events
 * about one order queue up instead of racing; different orders never wait for
 * each other.
 *
 * Every read a merchant makes carries `merchant_id` in its predicate, so
 * another merchant's row is never selected, and "not yours" and "not there"
 * are the same answer.
 */

import { isOpen, MERCHANT_SELLING, type MerchantSelling } from "@agentify/core";
import type { Card, Receipt, WorkerEnvelope } from "@nuanu-ai/agentify-contracts";
import { and, eq, exists, inArray, isNull, lt, not, or, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import type { DrizzleTransactionLike } from "pg-boss";
import type { Ids } from "../../ports/clock.js";
import {
  type CatalogEntry,
  INTEGRATIONS,
  type Integration,
  type IntegrationSwitch,
  type MerchantScope,
  type OrderChange,
  type OrderLookup,
  OWING_ONLY_MONEY,
  type PaymentClaim,
  type Ran,
  type Store,
  type StoredCard,
  type StoredKey,
  type StoredMerchant,
  type StoredOrder,
  type StoredPayoutWallet,
} from "../../ports/store.js";
import { failingWithoutValues } from "../database-failure.js";
import { cards, merchantKeys, merchants, orders, paymentClaims, receipts } from "./schema.js";

/**
 * How an envelope that has to be written with an order gets onto a merchant's
 * stream. `within` writes the job in the order's transaction, so the two
 * commit or roll back together; `committed` wakes parked polls only after the
 * commit, since before it they would find nothing.
 */
export interface Envelopes {
  within(
    tx: DrizzleTransactionLike,
    merchantId: string,
    envelope: WorkerEnvelope,
    afterMs?: number,
  ): Promise<void>;
  /**
   * Deletes the envelopes that carry a parcel's address in the same
   * transaction as the order recording the erasure, so the two commit together.
   */
  forgetWithin(
    tx: DrizzleTransactionLike,
    merchantId: string,
    orderId: string,
    priceQuestion: string | null,
  ): Promise<void>;
  committed(merchantIds: readonly string[]): void;
}

/**
 * For a store that writes no orders, such as the command-line verbs'. It
 * refuses out loud rather than dropping a merchant's work.
 */
export const noEnvelopes: Envelopes = {
  async within(_tx, _merchantId, envelope) {
    throw new Error(
      `this store was built with nowhere to put the envelope ${envelope.id}: a store that writes orders is given a stream`,
    );
  },
  async forgetWithin(_tx, _merchantId, orderId) {
    throw new Error(
      `this store was built with no stream to take ${orderId}'s envelopes off: a store that writes orders is given a stream`,
    );
  },
  committed() {},
};

/** Somewhere a statement can be run: the pool, or a transaction on it. */
type Queries = NodePgDatabase | Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

/**
 * The drizzle handle together with its pool. The pool is needed because a
 * session-level advisory lock must be released on the connection that took it.
 */
export type Database = NodePgDatabase & { readonly $client: Pool };

export class PostgresStore implements Store {
  readonly #db: Database;
  readonly #ids: Ids;
  readonly #envelopes: Envelopes;

  /**
   * The only way to make a store: database failures leave it stripped of the
   * values bound to the statement (`database-failure.ts`).
   */
  static over(db: Database, ids: Ids, envelopes: Envelopes = noEnvelopes): PostgresStore {
    return failingWithoutValues(new PostgresStore(db, ids, envelopes), "the store");
  }

  private constructor(db: Database, ids: Ids, envelopes: Envelopes) {
    this.#db = db;
    this.#ids = ids;
    this.#envelopes = envelopes;
  }

  // --- merchants and their keys ---------------------------------------------

  async addMerchant(
    merchant: { readonly id: string; readonly name: string },
    at: number,
  ): Promise<StoredMerchant | null> {
    const [row] = await this.#db
      .insert(merchants)
      .values({
        id: merchant.id,
        name: merchant.name,
        selling: "open",
        createdAt: new Date(at),
        updatedAt: new Date(at),
      })
      .onConflictDoNothing({ target: merchants.id })
      .returning();
    // Nothing came back: the identifier is taken and nothing was overwritten.
    return row === undefined ? null : storedMerchantOf(row);
  }

  async merchantById(id: string): Promise<StoredMerchant | null> {
    const [row] = await this.#db.select().from(merchants).where(eq(merchants.id, id)).limit(1);
    return row === undefined ? null : storedMerchantOf(row);
  }

  async grantLiveApproval(
    id: string,
    at: number,
  ): Promise<{ merchant: StoredMerchant; changed: boolean } | null> {
    // One statement, so two operators granting at once cannot both replace
    // the instant.
    const [granted] = await this.#db
      .update(merchants)
      .set({ liveApprovedAt: new Date(at) })
      .where(and(eq(merchants.id, id), isNull(merchants.liveApprovedAt)))
      .returning();
    if (granted !== undefined) {
      return { merchant: storedMerchantOf(granted), changed: true };
    }

    // Tells a repeat from a missing merchant. `updated_at` is deliberately not
    // written: the grant has its own instant and changes no merchant setting.
    const existing = await this.merchantById(id);
    return existing === null ? null : { merchant: existing, changed: false };
  }

  async merchants(): Promise<readonly StoredMerchant[]> {
    const rows = await this.#db.select().from(merchants).orderBy(merchants.createdAt);
    return rows.map(storedMerchantOf);
  }

  async setServiceName(
    id: string,
    serviceName: string | null,
    at: number,
  ): Promise<StoredMerchant | null> {
    const [row] = await this.#db
      .update(merchants)
      .set({ serviceName, updatedAt: new Date(at) })
      .where(eq(merchants.id, id))
      .returning();
    return row === undefined ? null : storedMerchantOf(row);
  }

  async setSellerSite(id: string, sellerSite: string, at: number): Promise<StoredMerchant | null> {
    const [row] = await this.#db
      .update(merchants)
      .set({ sellerSite, updatedAt: new Date(at) })
      .where(eq(merchants.id, id))
      .returning();
    return row === undefined ? null : storedMerchantOf(row);
  }

  async setPayoutWallet(
    id: string,
    expected: StoredPayoutWallet,
    next: StoredPayoutWallet & { readonly address: string },
    at: number,
  ): Promise<StoredMerchant | "moved" | null> {
    // Compare and write in one statement, so two changes read from one row
    // cannot both be recorded. `is not distinct from`, because `=` against a
    // null answers nothing.
    const [row] = await this.#db
      .update(merchants)
      .set({
        payoutWallet: next.address,
        pendingPayoutWallet: next.pending?.address ?? null,
        pendingPayoutWalletFrom:
          next.pending === null ? null : new Date(next.pending.takesEffectAt),
        updatedAt: new Date(at),
      })
      .where(
        and(
          eq(merchants.id, id),
          sql`${merchants.payoutWallet} is not distinct from ${expected.address}`,
          sql`${merchants.pendingPayoutWallet} is not distinct from ${expected.pending?.address ?? null}`,
          sql`${merchants.pendingPayoutWalletFrom} is not distinct from ${
            expected.pending === null ? null : new Date(expected.pending.takesEffectAt)
          }`,
        ),
      )
      .returning();
    if (row !== undefined) {
      return storedMerchantOf(row);
    }
    // Nothing matched: the row has moved, or there is no such merchant.
    return (await this.merchantById(id)) === null ? null : "moved";
  }

  async addKey(
    key: {
      readonly id: string;
      readonly merchantId: string;
      readonly label: string;
      readonly digest: string;
    },
    at: number,
  ): Promise<StoredKey> {
    // The two uniqueness rules are told apart by name: a taken identifier is
    // our generator colliding, a taken digest is the same secret written
    // twice by racing writers.
    //
    // Never rethrow or wrap the driver's error here: it carries the digest in
    // its parameters and its detail line.
    let row: typeof merchantKeys.$inferSelect | undefined;
    try {
      [row] = await this.#db
        .insert(merchantKeys)
        .values({
          id: key.id,
          merchantId: key.merchantId,
          label: key.label,
          digest: key.digest,
          createdAt: new Date(at),
        })
        .returning();
    } catch (thrown) {
      const refused = uniquenessRefused(thrown);
      if (refused === null) {
        throw thrown;
      }
      if (refused.constraint === KEY_IDENTIFIER_TAKEN) {
        throw new Error(`the key ${key.id} is already written down`);
      }
      if (refused.constraint === KEY_DIGEST_TAKEN) {
        throw new Error("a key with that digest is already written down");
      }
      throw new Error(unknownRuleRefused(`writing the key ${key.id}`, refused));
    }

    if (row === undefined) {
      throw new Error(`writing a key for ${key.merchantId} wrote no row`);
    }
    return storedKeyOf(row);
  }

  async noteKeyUse(id: string, at: number): Promise<void> {
    // Never-backwards is in the predicate, not a read then a write: two
    // gateways with two clocks write this without waiting for each other. A
    // key that is gone matches nothing, which is fine.
    await this.#db
      .update(merchantKeys)
      .set({ lastUsedAt: new Date(at) })
      .where(
        and(
          eq(merchantKeys.id, id),
          or(isNull(merchantKeys.lastUsedAt), lt(merchantKeys.lastUsedAt, new Date(at))),
        ),
      );
  }

  async workingKey(digest: string): Promise<StoredKey | null> {
    // Disabled keys are excluded in the predicate, so a revoked key and one
    // never issued get the same answer.
    const [row] = await this.#db
      .select()
      .from(merchantKeys)
      .where(and(eq(merchantKeys.digest, digest), isNull(merchantKeys.disabledAt)))
      .limit(1);
    return row === undefined ? null : storedKeyOf(row);
  }

  async keyByDigest(digest: string): Promise<StoredKey | null> {
    const [row] = await this.#db
      .select()
      .from(merchantKeys)
      .where(eq(merchantKeys.digest, digest))
      .limit(1);
    return row === undefined ? null : storedKeyOf(row);
  }

  async keysOf(merchantId: string): Promise<readonly StoredKey[]> {
    // The identifier breaks ties, so keys made in the same millisecond keep a
    // stable order.
    const rows = await this.#db
      .select()
      .from(merchantKeys)
      .where(eq(merchantKeys.merchantId, merchantId))
      .orderBy(merchantKeys.createdAt, merchantKeys.id);
    return rows.map(storedKeyOf);
  }

  async disableKey(id: string, at: number): Promise<StoredKey | null> {
    const [row] = await this.#db
      .update(merchantKeys)
      // The first revocation instant is kept; a second run must not move it.
      .set({ disabledAt: revokedAt(at) })
      .where(eq(merchantKeys.id, id))
      .returning();
    return row === undefined ? null : storedKeyOf(row);
  }

  async disableKeyOf(merchantId: string, id: string, at: number): Promise<StoredKey | null> {
    // The merchant is in the predicate: another merchant's key is answered as
    // missing, with no window between checking ownership and writing.
    const [row] = await this.#db
      .update(merchantKeys)
      .set({ disabledAt: revokedAt(at) })
      .where(and(eq(merchantKeys.id, id), eq(merchantKeys.merchantId, merchantId)))
      .returning();
    return row === undefined ? null : storedKeyOf(row);
  }

  // --- the catalog ----------------------------------------------------------

  async publishCard(
    merchantId: string,
    card: Card,
    at: number,
    integration: Integration = "api",
  ): Promise<StoredCard> {
    // Republishing keeps the existing card's identifier, so the address agents
    // hold does not change.
    const [row] = await this.#db
      .insert(cards)
      .values({
        id: this.#ids("item"),
        merchantId,
        merchantItemId: card.merchant_item_id,
        card,
        asOf: new Date(at),
        integration,
      })
      .onConflictDoUpdate({
        // The merchant is half of the target, or a second merchant's "sku-1"
        // would overwrite the first merchant's card.
        target: [cards.merchantId, cards.merchantItemId],
        // `paused` is deliberately not reset: republishing must not put a
        // product the merchant took off sale back on it.
        set: { card, asOf: new Date(at) },
        // A card keeps the integration that first published it: through the
        // other one the conflict updates nothing and returns no row, in the
        // same statement, so racing publishes cannot move it either.
        setWhere: eq(cards.integration, integration),
      })
      .returning();
    if (row !== undefined) {
      return storedCardOf(row);
    }

    const [standing] = await this.#db
      .select()
      .from(cards)
      .where(and(eq(cards.merchantId, merchantId), eq(cards.merchantItemId, card.merchant_item_id)))
      .limit(1);
    if (standing === undefined) {
      throw new Error(`publishing ${card.merchant_item_id} wrote no row and found none`);
    }
    return storedCardOf(standing);
  }

  async cardById(id: string): Promise<StoredCard | null> {
    const [row] = await this.#db.select().from(cards).where(eq(cards.id, id)).limit(1);
    return row === undefined ? null : storedCardOf(row);
  }

  async cards(merchantId: string): Promise<readonly StoredCard[]> {
    const rows = await this.#db
      .select()
      .from(cards)
      .where(eq(cards.merchantId, merchantId))
      .orderBy(cards.asOf);
    return rows.map(storedCardOf);
  }

  async catalogEntries(): Promise<readonly CatalogEntry[]> {
    // One join rather than a query per merchant: the catalog is read on every
    // agent's first call.
    const rows = await this.#db
      .select({
        card: cards,
        selling: merchants.selling,
        payoutWallet: merchants.payoutWallet,
        pendingPayoutWallet: merchants.pendingPayoutWallet,
        pendingPayoutWalletFrom: merchants.pendingPayoutWalletFrom,
        serviceName: merchants.serviceName,
        sellerSite: merchants.sellerSite,
        liveApprovedAt: merchants.liveApprovedAt,
        integration: merchants.integration,
      })
      .from(cards)
      .innerJoin(merchants, eq(cards.merchantId, merchants.id))
      .orderBy(cards.asOf);
    return rows.map((row) => ({
      card: storedCardOf(row.card),
      merchant: sellingWordOf(row.selling),
      payoutWallet: payoutWalletOf(row),
      serviceName: row.serviceName,
      sellerSite: row.sellerSite,
      liveApprovedAt: row.liveApprovedAt?.getTime() ?? null,
      integration: integrationOf(row.integration),
    }));
  }

  async setCardPaused(merchantId: string, id: string, paused: boolean): Promise<StoredCard | null> {
    const [row] = await this.#db
      .update(cards)
      .set({ paused })
      // Another merchant's card is answered as missing.
      .where(and(eq(cards.id, id), eq(cards.merchantId, merchantId)))
      .returning();
    return row === undefined ? null : storedCardOf(row);
  }

  async selling(merchantId: string): Promise<MerchantSelling> {
    const [row] = await this.#db
      .select()
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);

    if (row === undefined) {
      // Never answer "open" for a merchant nobody can find.
      throw new Error(
        `there is no merchant ${merchantId}, so there is no word for whether they are selling`,
      );
    }
    return sellingWordOf(row.selling);
  }

  async setSelling(merchantId: string, selling: MerchantSelling): Promise<void> {
    const changed = await this.#db
      .update(merchants)
      .set({ selling, updatedAt: sql`now()` })
      .where(eq(merchants.id, merchantId))
      .returning({ id: merchants.id });

    if (changed.length === 0) {
      throw new Error(`there is no merchant ${merchantId} to stop or start selling`);
    }
  }

  async switchIntegration(merchantId: string, to: Integration): Promise<IntegrationSwitch> {
    return await this.#db.transaction(async (tx): Promise<IntegrationSwitch> => {
      // Held for update, so the birth of an order, which holds the same row
      // for share while it writes (`addOrder`), waits for this or finishes
      // first — and then the read of the orders below, a statement of its
      // own, sees it.
      const [merchant] = await tx
        .select({ integration: merchants.integration, selling: merchants.selling })
        .from(merchants)
        .where(eq(merchants.id, merchantId))
        .limit(1)
        .for("update");
      if (merchant === undefined) {
        throw new Error(`there is no merchant ${merchantId} to switch to ${to}`);
      }
      if (integrationOf(merchant.integration) === to) {
        return { switched: true, sellingPaused: false };
      }

      const waiting = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.merchantId, merchantId),
            eq(orders.open, true),
            not(inArray(orders.state, [...OWING_ONLY_MONEY])),
          ),
        )
        .orderBy(orders.createdAt);
      if (waiting.length > 0) {
        return { switched: false, waiting: waiting.map((row) => row.id) };
      }

      const comingBack =
        to === "api" && sellingWordOf(merchant.selling) === "open"
          ? await tx
              .select({ id: cards.id })
              .from(cards)
              .where(
                and(
                  eq(cards.merchantId, merchantId),
                  eq(cards.integration, to),
                  eq(cards.paused, false),
                ),
              )
              .limit(1)
          : [];
      const sellingPaused = comingBack.length > 0;
      await tx
        .update(merchants)
        .set({
          integration: to,
          ...(sellingPaused ? { selling: "paused" } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(merchants.id, merchantId));
      return { switched: true, sellingPaused };
    });
  }

  // --- orders ---------------------------------------------------------------

  async addOrder(record: StoredOrder, through?: Integration): Promise<boolean> {
    try {
      if (through === undefined) {
        await this.#db.insert(orders).values(rowFor(record));
        return true;
      }
      return await this.#db.transaction(async (tx) => {
        // Held for share, which any number of births can hold at once and a
        // switch cannot (`switchIntegration`).
        const [merchant] = await tx
          .select({ integration: merchants.integration })
          .from(merchants)
          .where(eq(merchants.id, record.merchantId))
          .limit(1)
          .for("share");
        if (merchant === undefined || integrationOf(merchant.integration) !== through) {
          return false;
        }
        await tx.insert(orders).values(rowFor(record));
        return true;
      });
    } catch (thrown) {
      const refused = uniquenessRefused(thrown);
      if (refused === null) {
        throw thrown;
      }
      // Which rule refused is checked, not assumed, so a uniqueness rule added
      // later is not misreported as a duplicate order.
      if (refused.constraint !== ORDER_IDENTIFIER_TAKEN) {
        throw new Error(unknownRuleRefused(`writing the order ${record.order.id}`, refused));
      }
      // The same words as the in-memory store. The driver's error is not
      // carried as a cause: its parameters hold the whole order, payment
      // included.
      throw new Error(`the order ${record.order.id} is already written down`);
    }
  }

  async orderById(id: string): Promise<StoredOrder | null> {
    const [row] = await this.#db.select().from(orders).where(eq(orders.id, id)).limit(1);
    return row?.record ?? null;
  }

  async merchantOrder(merchantId: string, id: string): Promise<StoredOrder | null> {
    const [row] = await this.#db
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.merchantId, merchantId)))
      .limit(1);
    return row?.record ?? null;
  }

  async orders(
    merchantId: string,
    query?: { readonly open?: boolean },
  ): Promise<readonly StoredOrder[]> {
    const mine = eq(orders.merchantId, merchantId);
    const rows = await this.#db
      .select()
      .from(orders)
      .where(query?.open === true ? and(mine, eq(orders.open, true)) : mine)
      .orderBy(orders.createdAt);
    return rows.map((row) => row.record);
  }

  async openOrders(): Promise<readonly StoredOrder[]> {
    const rows = await this.#db
      .select()
      .from(orders)
      .where(eq(orders.open, true))
      .orderBy(orders.createdAt);
    return rows.map((row) => row.record);
  }

  async runAlone<T>(name: string, work: () => Promise<T>): Promise<Ran<T>> {
    // A session advisory lock on one connection held for the whole run: the
    // unlock must go out on the session that took the lock, and a transaction
    // lock would keep a transaction idle for the length of the work. The
    // connection comes from the same pool the work queries through, with no
    // timeout on waiting for it, so a deployment that shrinks the pool must
    // count it in.
    //
    // pg-boss takes advisory locks in the same key space. If it ever reached a
    // key we hold, its operation would wait for our run and then fail on its
    // thirty-second lock timeout. A collision is about one chance in four
    // billion per pg-boss key, because `hashtext` keys widened to 64 bits land
    // in a narrow band; the `agentify.` prefix only separates our own names.
    const client = await this.#db.$client.connect();
    let broken: unknown = null;

    // No error listener is attached here: `connect()` attaches one to every
    // checked-out client, without which a fatal on a pinned client would kill
    // the process.

    try {
      const taken = await client.query<{ got: boolean }>(
        "select pg_try_advisory_lock(hashtext($1)) as got",
        [`agentify.${name}`],
      );
      if (taken.rows[0]?.got !== true) {
        return { ran: false };
      }

      try {
        return { ran: true, result: await work() };
      } finally {
        // Release however the work ended, or every later run is kept out. A
        // failed unlock is logged, never thrown: in a `finally` it would
        // replace the work's own result or failure.
        try {
          await client.query("select pg_advisory_unlock(hashtext($1))", [`agentify.${name}`]);
        } catch (thrown) {
          console.error(`[gateway] could not let go of ${name}`, thrown);
          // An unlock can fail on a live session (a statement timeout) and leave
          // the lock held by a client about to return to the pool, so every
          // later run would skip silently. Marking the connection broken makes
          // the release below end the session, which frees the lock.
          broken = thrown;
        }
      }
    } finally {
      // Released with the failure, the pool ends the session instead of handing
      // on a client that still holds the lock.
      client.release(broken === null ? undefined : (broken as Error));
    }
  }

  async deliveredWithoutReceipt(): Promise<readonly StoredOrder[]> {
    // The missing receipt is asked in the predicate, so the answer is the size
    // of what is wrong, normally nothing. The read is not bounded: with no
    // index on `state`, this and `openOrders` scan the orders table. Add an
    // index when the table grows large.
    const rows = await this.#db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.state, "delivered"),
          not(
            exists(
              this.#db
                .select({ one: sql`1` })
                .from(receipts)
                .where(eq(receipts.orderId, orders.id)),
            ),
          ),
        ),
      )
      .orderBy(orders.createdAt);
    return rows.map((row) => row.record);
  }

  async withOrder<T>(
    id: string,
    change: (found: StoredOrder) => Promise<OrderChange<T>> | OrderChange<T>,
    scope?: MerchantScope,
  ): Promise<OrderLookup<T>> {
    // Streams written to inside the transaction, woken only after the commit.
    const streams: string[] = [];
    const lookup = await this.#db.transaction(async (tx): Promise<OrderLookup<T>> => {
      // The row lock makes a second decision about this order wait here.
      // Where a merchant is named it is in the same predicate, so a stranger's
      // order is never selected or locked.
      const [row] = await tx
        .select()
        .from(orders)
        .where(
          scope === undefined
            ? eq(orders.id, id)
            : and(eq(orders.id, id), eq(orders.merchantId, scope.merchantId)),
        )
        .limit(1)
        .for("update");

      if (row === undefined) {
        return { found: false };
      }

      const decided = await change(row.record);

      // The writes that must not be lost go in this transaction, so a process
      // that dies mid-flight did all of them or none, the queue's job inserts
      // included.
      for (const write of decided.alongside ?? []) {
        switch (write.kind) {
          case "receipt":
            await this.#putReceiptWithin(tx, write.merchantId, write.receipt);
            break;
          case "envelope":
            await this.#envelopes.within(tx, write.merchantId, write.envelope, write.afterMs);
            streams.push(write.merchantId);
            break;
          case "forget":
            await this.#envelopes.forgetWithin(
              tx,
              write.merchantId,
              write.orderId,
              write.priceQuestion,
            );
            break;
        }
      }

      if (decided.save !== undefined) {
        // The merchant always comes from the row, never from the save: an
        // order's merchant never changes, and a document disagreeing with the
        // column would list an order under one merchant while its envelopes
        // went to another.
        const next = rowFor({ ...decided.save, merchantId: row.merchantId });
        await tx
          .update(orders)
          .set({
            state: next.state,
            open: next.open,
            record: next.record,
            updatedAt: next.updatedAt,
          })
          .where(eq(orders.id, id));
      }
      return { found: true, result: decided.result };
    });

    // Committed, so the jobs are visible: wake this process's parked polls.
    // Other processes find the work by polling.
    this.#envelopes.committed(streams);
    return lookup;
  }

  async claimPayment(fingerprint: string, orderId: string): Promise<PaymentClaim> {
    // One statement; the primary key decides between two requests presenting
    // the same payment at once. The conflict clause rewrites the holder's own
    // identifier, so the row that stands always comes back.
    const [row] = await this.#db
      .insert(paymentClaims)
      .values({ fingerprint, orderId, claimedAt: new Date() })
      .onConflictDoUpdate({
        target: paymentClaims.fingerprint,
        set: { orderId: sql`${paymentClaims.orderId}` },
      })
      .returning();

    if (row === undefined) {
      throw new Error(`claiming a payment for ${orderId} wrote and read no row`);
    }
    // The same order presenting the same payment again is a safe retry.
    return row.orderId === orderId ? { claimed: true } : { claimed: false, heldBy: row.orderId };
  }

  async releaseClaim(fingerprint: string, orderId: string): Promise<void> {
    // A claim another order holds is never released by this one.
    await this.#db
      .delete(paymentClaims)
      .where(and(eq(paymentClaims.fingerprint, fingerprint), eq(paymentClaims.orderId, orderId)));
  }

  async forgetClaimsBefore(instant: number): Promise<number> {
    const gone = await this.#db
      .delete(paymentClaims)
      .where(lt(paymentClaims.claimedAt, new Date(instant)))
      .returning({ fingerprint: paymentClaims.fingerprint });
    return gone.length;
  }

  // --- receipts -------------------------------------------------------------

  async putReceipt(merchantId: string, receipt: Receipt): Promise<void> {
    await this.#putReceiptWithin(this.#db, merchantId, receipt);
  }

  /**
   * The one statement that writes a receipt, on the pool or inside an order's
   * transaction, so receipts written by either path agree about whose sale it
   * was.
   */
  async #putReceiptWithin(on: Queries, merchantId: string, receipt: Receipt): Promise<void> {
    await on
      .insert(receipts)
      .values({ orderId: receipt.order_id, merchantId, receipt, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: receipts.orderId,
        // The merchant is never rewritten: a receipt belongs to whoever made
        // the sale.
        set: { receipt, updatedAt: sql`now()` },
      });
  }

  async receiptForOrder(orderId: string): Promise<Receipt | null> {
    const [row] = await this.#db
      .select()
      .from(receipts)
      .where(eq(receipts.orderId, orderId))
      .limit(1);
    return row?.receipt ?? null;
  }

  async receipts(merchantId: string): Promise<readonly Receipt[]> {
    const rows = await this.#db
      .select()
      .from(receipts)
      .where(eq(receipts.merchantId, merchantId))
      .orderBy(receipts.updatedAt);
    return rows.map((row) => row.receipt);
  }
}

/**
 * The uniqueness rules this store has a sentence for, by their names in the
 * database. Renaming one in a migration must be matched here.
 */
const ORDER_IDENTIFIER_TAKEN = "orders_pkey";
const KEY_IDENTIFIER_TAKEN = "merchant_keys_pkey";
const KEY_DIGEST_TAKEN = "merchant_keys_digest_unique";

/**
 * The uniqueness rule (SQLSTATE 23505) that turned a write away, found down
 * the chain of causes because drizzle wraps the driver's error, or null. The
 * name comes from the driver's field, never the message, which may be
 * localised and carries the values that clashed.
 */
function uniquenessRefused(thrown: unknown): { readonly constraint: string | null } | null {
  let at = thrown;
  // Bounded, so a cause that points back at itself cannot hang.
  for (let deep = 0; deep < 8; deep += 1) {
    if (typeof at !== "object" || at === null) {
      return null;
    }
    const said = at as { readonly code?: unknown; readonly constraint?: unknown };
    if (said.code === "23505") {
      return { constraint: typeof said.constraint === "string" ? said.constraint : null };
    }
    at = (at as { readonly cause?: unknown }).cause;
  }
  return null;
}

/**
 * The sentence for a uniqueness rule this code does not know: it names the
 * rule and says it cannot say what was already there, rather than guessing.
 */
function unknownRuleRefused(what: string, refused: { readonly constraint: string | null }): string {
  const rule = refused.constraint === null ? "a rule the driver did not name" : refused.constraint;
  return `${what} was refused by ${rule}, and this code cannot say what was already there`;
}

function storedCardOf(row: {
  id: string;
  merchantId: string;
  card: Card;
  asOf: Date;
  paused: boolean;
  integration: string;
}): StoredCard {
  return {
    id: row.id,
    merchantId: row.merchantId,
    card: row.card,
    asOf: row.asOf.getTime(),
    paused: row.paused,
    integration: integrationOf(row.integration),
  };
}

interface WalletColumns {
  payoutWallet: string | null;
  pendingPayoutWallet: string | null;
  pendingPayoutWalletFrom: Date | null;
}

/**
 * The wallet columns as one value. The table refuses half a pending change; if
 * one appears anyway it is read as nothing pending, never as a change taking
 * effect at an instant nobody wrote.
 */
function payoutWalletOf(row: WalletColumns): StoredPayoutWallet {
  return {
    address: row.payoutWallet,
    pending:
      row.pendingPayoutWallet === null || row.pendingPayoutWalletFrom === null
        ? null
        : {
            address: row.pendingPayoutWallet,
            takesEffectAt: row.pendingPayoutWalletFrom.getTime(),
          },
  };
}

function storedMerchantOf(
  row: WalletColumns & {
    id: string;
    name: string;
    serviceName: string | null;
    sellerSite: string | null;
    liveApprovedAt: Date | null;
    selling: string;
    integration: string;
    createdAt: Date;
  },
): StoredMerchant {
  return {
    id: row.id,
    name: row.name,
    serviceName: row.serviceName,
    sellerSite: row.sellerSite,
    payoutWallet: payoutWalletOf(row),
    liveApprovedAt: row.liveApprovedAt?.getTime() ?? null,
    selling: sellingWordOf(row.selling),
    integration: integrationOf(row.integration),
    createdAt: row.createdAt.getTime(),
  };
}

/**
 * What a revocation writes into `disabled_at`: this instant, unless one is
 * already there, so a second revocation never moves the first instant.
 */
const revokedAt = (at: number) => sql`coalesce(${merchantKeys.disabledAt}, ${new Date(at)})`;

function storedKeyOf(row: {
  id: string;
  merchantId: string;
  label: string;
  createdAt: Date;
  disabledAt: Date | null;
  lastUsedAt: Date | null;
}): StoredKey {
  return {
    id: row.id,
    merchantId: row.merchantId,
    label: row.label,
    createdAt: row.createdAt.getTime(),
    disabledAt: row.disabledAt === null ? null : row.disabledAt.getTime(),
    lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.getTime(),
  };
}

/**
 * The selling word out of a text column. An unknown word throws rather than
 * guessing whether somebody is selling.
 */
function sellingWordOf(word: string): MerchantSelling {
  if (!(MERCHANT_SELLING as readonly string[]).includes(word)) {
    throw new Error(
      `the merchant's selling state is "${word}", which is not one of ${MERCHANT_SELLING.join(", ")}`,
    );
  }
  return word as MerchantSelling;
}

function integrationOf(word: string): Integration {
  if (!(INTEGRATIONS as readonly string[]).includes(word)) {
    throw new Error(`the integration is "${word}", which is not one of ${INTEGRATIONS.join(", ")}`);
  }
  return word as Integration;
}

/** The columns, written from the document so they cannot disagree with it. */
function rowFor(record: StoredOrder) {
  return {
    id: record.order.id,
    state: record.order.state,
    open: isOpen(record.order.state),
    merchantId: record.merchantId,
    itemId: record.itemId,
    merchantItemId: record.merchantItemId,
    record,
    createdAt: new Date(record.order.timestamps.createdAt),
    updatedAt: new Date(),
  };
}

/**
 * One pool for the process, and the drizzle handle over it. Every pool must be
 * built here, tests included.
 *
 * An unhandled `error` event kills the process, and with it every parked
 * purchase and worker. The pool's own listener covers idle connections only;
 * pg-pool removes it from a client while it is checked out (in every drizzle
 * transaction and the sweep's lock), so a listener of ours is attached on
 * `acquire` and removed on `release`. pg-pool's event order leaves no gap at
 * either edge. Failures are only logged: a query in flight rejects on its own.
 */
export function connect(
  databaseUrl: string,
  options: PoolConfig = {},
): { db: Database; pool: Pool } {
  const pool = new Pool({ ...options, connectionString: databaseUrl });
  pool.on("error", (error) => {
    console.error("[gateway] an idle database connection failed", error);
  });

  // One shared function, since listeners are removed by identity.
  const noticeTheFailure = (failed: unknown) => {
    console.error("[gateway] a database connection somebody was holding failed", failed);
  };
  pool.on("acquire", (client) => client.on("error", noticeTheFailure));
  pool.on("release", (_failed, client) => client.removeListener("error", noticeTheFailure));

  return { db: drizzle(pool), pool };
}

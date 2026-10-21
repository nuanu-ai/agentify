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

import { listedAsOpen, type MerchantSelling } from "@agentify/core";
import type { Card, Receipt, WorkerEnvelope } from "@nuanu-ai/agentify-contracts";
import {
  and,
  desc,
  eq,
  exists,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import type { DrizzleTransactionLike } from "pg-boss";
import { type AnalyticsEvent, recordAlong, recordObserved } from "../../analytics/index.js";
import { failureNamed } from "../../failure-named.js";
import type { Ids } from "../../ports/clock.js";
import type { Reminder } from "../../ports/queue.js";
import {
  type AnalyticsOf,
  analyticsEventOf,
  type Birth,
  type Born,
  type CatalogEntry,
  type ClaimHolder,
  INTEGRATIONS,
  type Integration,
  type IntegrationSwitch,
  lapsedAttempt,
  type MerchantScope,
  NO_PENDING_HANDLER,
  type OrderAnalytics,
  type OrderChange,
  type OrderLookup,
  type PaymentClaim,
  type PayoutWalletRead,
  type PayoutWalletWrite,
  type Ran,
  type RecordedPayoutSplit,
  type Store,
  type StoredCard,
  type StoredKey,
  type StoredMerchant,
  type StoredOrder,
  type StoredPayoutWallet,
  type WalletWritten,
} from "../../ports/store.js";
import type { PayoutSplit } from "../../split/parameters.js";
import { failingWithoutValues } from "../database-failure.js";
import { recordedOtherwise, splitsOfTheWrite } from "../registry.js";
import {
  cards,
  merchantContact,
  merchantKeys,
  merchants,
  orders,
  paymentClaims,
  payoutSplits,
  receipts,
  WAITING_STATES,
} from "./schema.js";

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
  /** Sets a reminder an order's birth asked for, in the transaction that writes the order. */
  remindWithin(tx: DrizzleTransactionLike, reminder: Reminder, afterMs: number): Promise<void>;
}

/**
 * For a store that writes no orders, such as the command-line verbs'. It
 * refuses out loud rather than dropping a merchant's work.
 */
const noEnvelopes: Envelopes = {
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
  async remindWithin(_tx, reminder) {
    throw new Error(
      `this store was built with no queue to set the clock of ${reminder.orderId} on: a store that writes orders is given one`,
    );
  },
};

/** A transaction on the pool. */
type Transaction = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

/** Somewhere a statement can be run: the pool, or a transaction on it. */
type Queries = NodePgDatabase | Transaction;

/** Records what `analytics` makes of a committed write in the write's own transaction. */
async function recordWith<R>(
  tx: Transaction,
  analytics: AnalyticsOf<R> | undefined,
  committed: R,
  at: Date,
): Promise<void> {
  const event = analyticsEventOf(analytics, committed);
  if (event !== null) await recordAlong(tx, event, at);
}

/**
 * The drizzle handle together with its pool. The pool is needed because a
 * session-level advisory lock must be released on the connection that took it.
 */
export type Database = NodePgDatabase & { readonly $client: Pool };

export class PostgresStore implements Store {
  readonly #db: Database;
  readonly #network: string;
  readonly #ids: Ids;
  readonly #envelopes: Envelopes;

  /**
   * The only way to make a store: database failures leave it stripped of the
   * values bound to the statement (`database-failure.ts`). `network` is the
   * deployment's: a wallet's split is the one recorded on it, and a row of
   * another network is never read as one.
   */
  static over(
    db: Database,
    network: string,
    ids: Ids,
    envelopes: Envelopes = noEnvelopes,
  ): PostgresStore {
    return failingWithoutValues(new PostgresStore(db, network, ids, envelopes), "the store");
  }

  private constructor(db: Database, network: string, ids: Ids, envelopes: Envelopes) {
    this.#db = db;
    this.#network = network;
    this.#ids = ids;
    this.#envelopes = envelopes;
  }

  get network(): string {
    return this.#network;
  }

  // --- product analytics ----------------------------------------------------

  async recordAnalytics(event: AnalyticsEvent, at: number | Date): Promise<void> {
    await recordObserved(this.#db, event, new Date(at));
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
    // A merchant just made has no wallet, so no split either.
    return row === undefined ? null : storedMerchantOf({ ...row, split: null, pendingSplit: null });
  }

  async merchantById(id: string): Promise<StoredMerchant | null> {
    const [merchant] = await this.#merchantsWhere(this.#db, eq(merchants.id, id));
    return merchant ?? null;
  }

  /**
   * Merchants with the splits recorded for their wallet and their waiting
   * wallet, read in the one statement that reads the merchant, so a wallet
   * and its split are never read at two instants.
   */
  async #merchantsWhere(on: Queries, where?: SQL): Promise<StoredMerchant[]> {
    const rows = await on
      .select({
        ...MERCHANT_COLUMNS,
        split: splitRecordedFor(this.#network, merchants.payoutWallet),
        pendingSplit: splitRecordedFor(this.#network, merchants.pendingPayoutWallet),
      })
      .from(merchants)
      .where(where)
      .orderBy(merchants.createdAt, merchants.id);
    return rows.map(storedMerchantOf);
  }

  async grantLiveApproval(
    id: string,
    at: number,
    analytics?: AnalyticsOf<{ merchant: StoredMerchant; changed: boolean }>,
  ): Promise<{ merchant: StoredMerchant; changed: boolean } | null> {
    return await this.#db.transaction(async (tx) => {
      // One statement, so two operators granting at once cannot both replace
      // the instant. `updated_at` is deliberately not written: the grant has
      // its own instant and changes no merchant setting.
      const [granted] = await tx
        .update(merchants)
        .set({ liveApprovedAt: new Date(at) })
        .where(and(eq(merchants.id, id), isNull(merchants.liveApprovedAt)))
        .returning({ id: merchants.id });
      // Read after the write either way, which tells a repeat from a missing
      // merchant.
      const [merchant] = await this.#merchantsWhere(tx, eq(merchants.id, id));
      if (merchant === undefined) {
        return null;
      }
      const answer = { merchant, changed: granted !== undefined };
      if (answer.changed) await recordWith(tx, analytics, answer, new Date(at));
      return answer;
    });
  }

  async withdrawLiveApproval(
    id: string,
  ): Promise<{ merchant: StoredMerchant; changed: boolean } | null> {
    // Conditional on a grant standing, so of two withdrawals at once exactly
    // one reports the change.
    const [withdrawn] = await this.#db
      .update(merchants)
      .set({ liveApprovedAt: null })
      .where(and(eq(merchants.id, id), isNotNull(merchants.liveApprovedAt)))
      .returning({ id: merchants.id });
    const merchant = await this.merchantById(id);
    return merchant === null ? null : { merchant, changed: withdrawn !== undefined };
  }

  async merchants(): Promise<readonly StoredMerchant[]> {
    return this.#merchantsWhere(this.#db);
  }

  async setServiceName(
    id: string,
    serviceName: string | null,
    at: number,
    analytics?: AnalyticsOf<StoredMerchant>,
  ): Promise<StoredMerchant | null> {
    return this.#setListing(id, { serviceName }, at, analytics);
  }

  async setSellerSite(
    id: string,
    sellerSite: string,
    at: number,
    analytics?: AnalyticsOf<StoredMerchant>,
  ): Promise<StoredMerchant | null> {
    return this.#setListing(id, { sellerSite }, at, analytics);
  }

  /**
   * Writes the merchant's listing name or shop's site, recording `analytics`
   * only where the row held another value. The row is held from the read to
   * the write, so of two saves of one new value only the first records it.
   */
  async #setListing(
    id: string,
    listing: { readonly serviceName: string | null } | { readonly sellerSite: string },
    at: number,
    analytics: AnalyticsOf<StoredMerchant> | undefined,
  ): Promise<StoredMerchant | null> {
    return await this.#db.transaction(async (tx) => {
      const [before] = await tx
        .select({ serviceName: merchants.serviceName, sellerSite: merchants.sellerSite })
        .from(merchants)
        .where(eq(merchants.id, id))
        .for("no key update");
      if (before === undefined) {
        return null;
      }
      await tx
        .update(merchants)
        .set({ ...listing, updatedAt: new Date(at) })
        .where(eq(merchants.id, id));
      const [merchant] = await this.#merchantsWhere(tx, eq(merchants.id, id));
      if (merchant === undefined) {
        return null;
      }
      const changed =
        "serviceName" in listing
          ? before.serviceName !== listing.serviceName
          : before.sellerSite !== listing.sellerSite;
      if (changed) await recordWith(tx, analytics, merchant, new Date(at));
      return merchant;
    });
  }

  async setPayoutWallet(
    id: string,
    expected: PayoutWalletRead,
    next: PayoutWalletWrite,
    at: number,
    analytics?: AnalyticsOf<WalletWritten>,
  ): Promise<WalletWritten | "moved" | null> {
    const splits = splitsOfTheWrite(id, this.#network, next);
    // The wallet and its splits in one transaction: a split that cannot be
    // written leaves the wallet as it was, and a wallet that moved records no
    // split.
    return await this.#db.transaction(async (tx): Promise<WalletWritten | "moved" | null> => {
      // Compare and write in one statement, so two changes read from one row
      // cannot both be recorded. `is not distinct from`, because `=` against a
      // null answers nothing.
      const [row] = await tx
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
        .returning({ id: merchants.id });
      if (row === undefined) {
        // Nothing matched: the row has moved, or there is no such merchant.
        const [found] = await tx
          .select({ id: merchants.id })
          .from(merchants)
          .where(eq(merchants.id, id))
          .limit(1);
        return found === undefined ? null : "moved";
      }
      const recorded = await recordWithin(tx, splits, at);
      const [merchant] = await this.#merchantsWhere(tx, eq(merchants.id, id));
      if (merchant === undefined) {
        throw new Error(`the wallet of ${id} was written and the merchant could not be read back`);
      }
      const written = { merchant, recorded };
      await recordWith(tx, analytics, written, new Date(at));
      return written;
    });
  }

  // --- the payout splits ----------------------------------------------------

  async recordPayoutSplits(
    splits: readonly PayoutSplit[],
    at: number,
  ): Promise<readonly RecordedPayoutSplit[]> {
    const once = [...new Map(splits.map((split) => [split.address, split])).values()];
    return await this.#db.transaction((tx) => recordWithin(tx, once, at));
  }

  async payoutSplitAt(address: string): Promise<RecordedPayoutSplit | null> {
    const [row] = await this.#db
      .select()
      .from(payoutSplits)
      .where(sql`lower(${payoutSplits.address}) = lower(${address})`)
      .orderBy(payoutSplits.recordedAt)
      .limit(1);
    return row === undefined ? null : recordedSplitOf(row);
  }

  async networksWithPayoutSplits(): Promise<readonly string[]> {
    const rows = await this.#db
      .selectDistinct({ network: payoutSplits.network })
      .from(payoutSplits)
      .orderBy(payoutSplits.network);
    return rows.map((row) => row.network);
  }

  async payoutSplitsOn(network: string): Promise<readonly RecordedPayoutSplit[]> {
    const rows = await this.#db
      .select()
      .from(payoutSplits)
      .where(eq(payoutSplits.network, network))
      .orderBy(payoutSplits.recordedAt, sql`${payoutSplits.address} collate "C"`);
    return rows.map(recordedSplitOf);
  }

  /**
   * The merchant's splits that can hold money at `at`: the split of their
   * wallet in force then, and every split an order of theirs was verified
   * against, in either spelling.
   */
  async splitsToPayOutFor(
    network: string,
    merchantId: string,
    at: number,
  ): Promise<readonly RecordedPayoutSplit[]> {
    const rows = await this.#db
      .select()
      .from(payoutSplits)
      .where(
        and(
          eq(payoutSplits.network, network),
          eq(payoutSplits.merchantId, merchantId),
          or(
            exists(
              this.#db
                .select({ id: merchants.id })
                .from(merchants)
                .where(
                  and(
                    eq(merchants.id, payoutSplits.merchantId),
                    sql`lower(case when ${merchants.pendingPayoutWalletFrom} <= ${new Date(at)}
                          then ${merchants.pendingPayoutWallet}
                          else ${merchants.payoutWallet} end) = lower(${payoutSplits.merchantWallet})`,
                  ),
                ),
            ),
            // In the shape of the orders' index on the merchant and the
            // lowered address, so each split costs one look-up.
            exists(
              this.#db
                .select({ id: orders.id })
                .from(orders)
                .where(
                  and(
                    eq(orders.merchantId, payoutSplits.merchantId),
                    sql`lower(${orders.record} ->> 'payTo') = lower(${payoutSplits.address})`,
                  ),
                ),
            ),
          ),
        ),
      )
      .orderBy(payoutSplits.recordedAt, sql`${payoutSplits.address} collate "C"`);
    return rows.map(recordedSplitOf);
  }

  async addKey(
    key: {
      readonly id: string;
      readonly merchantId: string;
      readonly label: string;
      readonly digest: string;
    },
    at: number,
    analytics?: AnalyticsOf<StoredKey>,
  ): Promise<StoredKey> {
    // The two uniqueness rules are told apart by name: a taken identifier is
    // our generator colliding, a taken digest is the same secret written
    // twice by racing writers.
    //
    // Never rethrow or wrap the driver's error here: it carries the digest in
    // its parameters and its detail line.
    let row: typeof merchantKeys.$inferSelect | undefined;
    try {
      [row] = await this.#db.transaction(async (tx) => {
        const written = await tx
          .insert(merchantKeys)
          .values({
            id: key.id,
            merchantId: key.merchantId,
            label: key.label,
            digest: key.digest,
            createdAt: new Date(at),
          })
          .returning();
        const [issued] = written;
        if (issued !== undefined) {
          await recordWith(tx, analytics, storedKeyOf(issued), new Date(at));
        }
        return written;
      });
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

  async noteKeyUse(id: string, at: number, userAgent: string | null): Promise<void> {
    // Never-backwards is in the predicate, not a read then a write: two
    // gateways with two clocks write this without waiting for each other. A
    // key that is gone matches nothing, which is fine.
    await this.#db
      .update(merchantKeys)
      .set({ lastUsedAt: new Date(at), lastUserAgent: userAgent })
      .where(
        and(
          eq(merchantKeys.id, id),
          or(isNull(merchantKeys.lastUsedAt), lt(merchantKeys.lastUsedAt, new Date(at))),
        ),
      );
  }

  async noteContact(merchantId: string, at: number): Promise<void> {
    // Selected rather than inserted as values, so a merchant who is not there
    // writes nothing instead of failing the foreign key.
    await this.#db.execute(sql`
      insert into ${merchantContact} (merchant_id, polled_at)
      select ${merchants.id}, ${new Date(at)} from ${merchants} where ${merchants.id} = ${merchantId}
      on conflict (merchant_id)
      do update set polled_at = greatest(${merchantContact.polledAt}, excluded.polled_at)`);
  }

  async lastContact(merchantId: string): Promise<number | null> {
    const [row] = await this.#db
      .select({ polledAt: merchantContact.polledAt })
      .from(merchantContact)
      .where(eq(merchantContact.merchantId, merchantId))
      .limit(1);
    return row?.polledAt.getTime() ?? null;
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
    analytics?: AnalyticsOf<StoredCard>,
  ): Promise<StoredCard> {
    return await this.#db.transaction(async (tx) => {
      // Republishing keeps the existing card's identifier, so the address
      // agents hold does not change.
      const [row] = await tx
        .insert(cards)
        .values({
          id: this.#ids("item"),
          merchantId,
          merchantItemId: card.merchant_item_id,
          card,
          asOf: new Date(at),
          publishedAt: new Date(at),
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
        // A row this statement inserted carries no xmax, and one it updated
        // carries the lock its conflict took: the statement itself, and no read
        // beside it, says whether the card is new.
        .returning({ ...getTableColumns(cards), made: sql<boolean>`(xmax = 0)` });
      if (row !== undefined) {
        const stored = storedCardOf(row);
        if (row.made) await recordWith(tx, analytics, stored, new Date(at));
        return stored;
      }

      const [standing] = await tx
        .select()
        .from(cards)
        .where(
          and(eq(cards.merchantId, merchantId), eq(cards.merchantItemId, card.merchant_item_id)),
        )
        .limit(1);
      if (standing === undefined) {
        throw new Error(`publishing ${card.merchant_item_id} wrote no row and found none`);
      }
      return storedCardOf(standing);
    });
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
        split: splitRecordedFor(this.#network, merchants.payoutWallet),
        pendingSplit: splitRecordedFor(this.#network, merchants.pendingPayoutWallet),
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
      merchant: row.selling,
      payoutWallet: payoutWalletOf(row),
      serviceName: row.serviceName,
      sellerSite: row.sellerSite,
      liveApprovedAt: row.liveApprovedAt?.getTime() ?? null,
      integration: integrationOf(row.integration),
    }));
  }

  async setCardPaused(
    merchantId: string,
    id: string,
    paused: boolean,
    analytics?: AnalyticsOf<StoredCard>,
  ): Promise<StoredCard | null> {
    // Another merchant's card is answered as missing.
    const theirs = and(eq(cards.id, id), eq(cards.merchantId, merchantId));
    return await this.#db.transaction(async (tx) => {
      // Held from the read to the write, so of two pauses at once only the
      // first finds the card on sale.
      const [before] = await tx
        .select({ paused: cards.paused })
        .from(cards)
        .where(theirs)
        .for("no key update");
      if (before === undefined) {
        return null;
      }
      const [row] = await tx.update(cards).set({ paused }).where(theirs).returning();
      if (row === undefined) {
        return null;
      }
      const stored = storedCardOf(row);
      if (before.paused !== paused) await recordWith(tx, analytics, stored, new Date());
      return stored;
    });
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
    return row.selling;
  }

  async setSelling(
    merchantId: string,
    selling: MerchantSelling,
    analytics?: AnalyticsEvent,
  ): Promise<void> {
    await this.#db.transaction(async (tx) => {
      // Held from the read to the write, so of two stops at once only the
      // first finds the merchant selling.
      const [before] = await tx
        .select({ selling: merchants.selling })
        .from(merchants)
        .where(eq(merchants.id, merchantId))
        .for("no key update");
      if (before === undefined) {
        throw new Error(`there is no merchant ${merchantId} to stop or start selling`);
      }
      await tx
        .update(merchants)
        .set({ selling, updatedAt: sql`now()` })
        .where(eq(merchants.id, merchantId));
      if (before.selling !== selling) await recordWith(tx, analytics, undefined, new Date());
    });
  }

  async switchIntegration(
    merchantId: string,
    to: Integration,
    analytics?: AnalyticsEvent,
  ): Promise<IntegrationSwitch> {
    return await this.#db.transaction(async (tx): Promise<IntegrationSwitch> => {
      // Held for update, so the birth of an order, which holds the same row
      // while it writes (`addOrder`), waits for this or finishes first — and
      // then the read of the orders below, a statement of its own, sees it.
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
            not(inArray(orders.state, [...NO_PENDING_HANDLER])),
          ),
        )
        .orderBy(orders.createdAt);
      if (waiting.length > 0) {
        return { switched: false, waiting: waiting.map((row) => row.id) };
      }

      const comingBack =
        to === "api" && merchant.selling === "open"
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
      if (sellingPaused) await recordWith(tx, analytics, undefined, new Date());
      return { switched: true, sellingPaused };
    });
  }

  // --- orders ---------------------------------------------------------------

  async addOrder(record: StoredOrder, birth?: Birth, analytics?: AnalyticsEvent): Promise<Born> {
    try {
      if (birth === undefined && analytics === undefined) {
        await this.#db.insert(orders).values(rowFor(record));
        return "written";
      }
      return await this.#db.transaction(async (tx): Promise<Born> => {
        if (birth !== undefined) {
          // Held against every other birth for this merchant, or two of them
          // would count the same waiting purchases and both be written, and
          // against a switch (`switchIntegration`). Not `for update`: that
          // would also hold up the key-share lock every receipt written for
          // this merchant takes meanwhile.
          const [merchant] = await tx
            .select({ integration: merchants.integration })
            .from(merchants)
            .where(eq(merchants.id, record.merchantId))
            .limit(1)
            .for("no key update");
          if (merchant === undefined || integrationOf(merchant.integration) !== birth.through) {
            return "switched_away";
          }
          const waiting = await this.#waiting(
            tx,
            record.merchantId,
            record.order.timestamps.createdAt,
            birth.waitingAtMost,
          );
          if (waiting >= birth.waitingAtMost) {
            return "too_many_waiting";
          }
        }
        // Recorded ahead of the insert, so an insert refused as a duplicate
        // takes the event back with it.
        if (analytics !== undefined) {
          await recordAlong(tx, analytics, new Date(record.order.timestamps.createdAt));
        }
        await tx.insert(orders).values(rowFor(record));
        for (const clock of birth?.clocks ?? []) {
          await this.#envelopes.remindWithin(tx, clock.reminder, clock.afterMs);
        }
        return "written";
      });
    } catch (thrown) {
      const refused = uniquenessRefused(thrown);
      if (refused === null) {
        throw thrown;
      }
      // Which rule refused is checked, not assumed, so a uniqueness rule added
      // later is not misreported as a duplicate order. The same words as the
      // in-memory store. The driver's error is not carried as a cause: its
      // parameters hold the whole order, payment included.
      if (refused.constraint === ORDER_IDENTIFIER_TAKEN) {
        throw new Error(`the order ${record.order.id} is already written down`);
      }
      if (refused.constraint === PAYMENT_REF_TAKEN) {
        throw new Error(
          `the order ${record.order.id} names a payment reference another order already has`,
        );
      }
      throw new Error(unknownRuleRefused(`writing the order ${record.order.id}`, refused));
    }
  }

  async waitingForPayment(merchantId: string, at: number, atMost: number): Promise<number> {
    return this.#waiting(this.#db, merchantId, at, atMost);
  }

  /**
   * `waitsForPayment`, spelled in SQL: the states as the partial index has
   * them, and the count stopped at `atMost`, so it reads at most that many
   * rows.
   */
  async #waiting(on: Queries, merchantId: string, at: number, atMost: number): Promise<number> {
    const times = sql`${orders.record} -> 'order' -> 'timestamps'`;
    const windows = sql`${orders.record} -> 'order' -> 'policy' -> 'deadlines'`;
    const [counted] = await on.select({ waiting: sql<number>`count(*)::int` }).from(
      on
        .select({ one: sql`1` })
        .from(orders)
        .where(
          and(
            eq(orders.merchantId, merchantId),
            sql`${orders.state} in ${WAITING_STATES}`,
            sql`${orders.record} -> 'order' ->> 'payment' = 'none'`,
            sql`case ${orders.state}
              when 'quoted' then (${times} ->> 'quotedAt') is null
                or (${times} ->> 'quotedAt')::numeric + (${windows} ->> 'quoteTtlMs')::numeric > ${at}
              when 'created' then (${times} ->> 'createdAt')::numeric
                + (${windows} ->> 'quoteResponseMs')::numeric
                + (${windows} ->> 'quoteTtlMs')::numeric > ${at}
              else true end`,
          ),
        )
        .limit(atMost)
        .as("waiting"),
    );
    return counted?.waiting ?? 0;
  }

  async orderById(id: string): Promise<StoredOrder | null> {
    const [row] = await this.#db
      .select({ record: orders.record })
      .from(orders)
      .where(eq(orders.id, id))
      .limit(1);
    return row?.record ?? null;
  }

  async orderByPaymentRef(paymentRef: string): Promise<StoredOrder | null> {
    // Spelled as the index is, or the planner reads every order to answer.
    const [row] = await this.#db
      .select({ record: orders.record })
      .from(orders)
      .where(sql`(${orders.record} ->> 'paymentRef') = ${paymentRef}`)
      .limit(1);
    return row?.record ?? null;
  }

  async merchantOrder(merchantId: string, id: string): Promise<StoredOrder | null> {
    const [row] = await this.#db
      .select({ record: orders.record })
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.merchantId, merchantId)))
      .limit(1);
    return row?.record ?? null;
  }

  async orders(
    merchantId: string,
    query?: { readonly open?: boolean; readonly leaveOutLapsed?: boolean },
  ): Promise<readonly StoredOrder[]> {
    const rows = await this.#db
      .select({ record: orders.record })
      .from(orders)
      .where(
        and(
          eq(orders.merchantId, merchantId),
          query?.open === true ? eq(orders.open, true) : undefined,
          query?.leaveOutLapsed === true ? eq(orders.lapsed, false) : undefined,
        ),
      )
      .orderBy(orders.createdAt);
    return rows.map((row) => row.record);
  }

  async lapsedAttempts(
    merchantId: string,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<{ readonly orders: readonly StoredOrder[]; readonly of: number }> {
    const theirs = and(eq(orders.merchantId, merchantId), eq(orders.lapsed, true));
    const [counted] = await this.#db
      .select({ of: sql<number>`count(*)::int` })
      .from(orders)
      .where(theirs);
    const rows =
      page.limit === 0
        ? []
        : await this.#db
            .select({ record: orders.record })
            .from(orders)
            .where(theirs)
            .orderBy(desc(orders.createdAt), desc(orders.id))
            .limit(page.limit)
            .offset(page.offset);
    return { orders: rows.map((row) => row.record), of: counted?.of ?? 0 };
  }

  async openOrders(): Promise<readonly StoredOrder[]> {
    const rows = await this.#db
      .select({ record: orders.record })
      .from(orders)
      .where(eq(orders.open, true))
      .orderBy(orders.createdAt);
    return rows.map((row) => row.record);
  }

  async unresolvedPayments(afterId = "", limit = 100): Promise<readonly StoredOrder[]> {
    const rows = await this.#db
      .select({ record: orders.record })
      .from(orders)
      .where(
        and(
          sql`${orders.id} > ${afterId}`,
          sql`${orders.record} -> 'order' ->> 'payment' in ('settling', 'outcome_unknown')`,
        ),
      )
      .orderBy(orders.id)
      .limit(limit);
    return rows.map((row) => row.record);
  }

  async paymentOrders(afterId = "", limit = 100): Promise<readonly StoredOrder[]> {
    const rows = await this.#db
      .select({ record: orders.record })
      .from(orders)
      .where(and(sql`${orders.id} > ${afterId}`, sql`${orders.record} ->> 'payment' is not null`))
      .orderBy(orders.id)
      .limit(limit);
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
          console.error(`[gateway] could not let go of ${name}: ${failureNamed(thrown)}`);
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

  async forgetLapsedBefore(instant: number, limit: number): Promise<number> {
    // Skipping what is locked leaves an order somebody is deciding about to
    // the next run, and lets two runs share the work without waiting.
    const gone = await this.#db.execute(sql`
      delete from ${orders} where ${orders.id} in (
        select ${orders.id} from ${orders}
        where ${orders.lapsed} and ${orders.updatedAt} < ${new Date(instant)}
          and not exists (select 1 from ${receipts} where ${receipts.orderId} = ${orders.id})
          and not exists (
            select 1 from ${paymentClaims} where ${paymentClaims.orderId} = ${orders.id}
          )
        order by ${orders.updatedAt}
        limit ${limit}
        for update skip locked
      )`);
    return gone.rowCount ?? 0;
  }

  async deliveredWithoutReceipt(): Promise<readonly StoredOrder[]> {
    // The missing receipt is asked in the predicate, so the answer is the size
    // of what is wrong, normally nothing. The read is not bounded: with no
    // index on `state`, this and `openOrders` scan the orders table. Add an
    // index when the table grows large.
    const rows = await this.#db
      .select({ record: orders.record })
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
    analytics?: OrderAnalytics,
  ): Promise<OrderLookup<T>> {
    // Streams written to inside the transaction, woken only after the commit.
    const streams: string[] = [];
    const lookup = await this.#db.transaction(async (tx): Promise<OrderLookup<T>> => {
      // The row lock makes a second decision about this order wait here.
      // Where a merchant is named it is in the same predicate, so a stranger's
      // order is never selected or locked.
      const [row] = await tx
        .select({ record: orders.record, merchantId: orders.merchantId })
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
      // The merchant always comes from the row, never from the save: an
      // order's merchant never changes, and a document disagreeing with the
      // column would list an order under one merchant while its envelopes
      // went to another.
      const saved =
        decided.save === undefined ? undefined : { ...decided.save, merchantId: row.merchantId };
      // Recorded ahead of the writes below, so any of them refusing takes the
      // events back with it.
      const observed = saved === undefined ? [] : (analytics?.(row.record, saved) ?? []);
      for (const { event, at } of observed) {
        await recordAlong(tx, event, new Date(at));
      }

      // The writes that must not be lost go in this transaction, so a process
      // that dies mid-flight did all of them or none, the queue's job inserts
      // included.
      for (const write of decided.alongside ?? []) {
        switch (write.kind) {
          case "retain_payment": {
            const retained = await tx
              .update(paymentClaims)
              .set({ retained: true })
              .where(
                and(
                  eq(paymentClaims.fingerprint, write.fingerprint),
                  eq(paymentClaims.orderId, write.orderId),
                ),
              )
              .returning({ fingerprint: paymentClaims.fingerprint });
            if (retained.length !== 1)
              throw new Error("the payment claim no longer belongs to this order");
            break;
          }
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

      if (saved !== undefined) {
        const next = rowFor(saved);
        await tx
          .update(orders)
          .set({
            state: next.state,
            open: next.open,
            lapsed: next.lapsed,
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

  async paymentClaimHolder(fingerprint: string): Promise<ClaimHolder | null> {
    const [row] = await this.#db
      .select({ orderId: paymentClaims.orderId, retained: paymentClaims.retained })
      .from(paymentClaims)
      .where(eq(paymentClaims.fingerprint, fingerprint));
    return row ?? null;
  }

  async releaseClaim(fingerprint: string, orderId: string): Promise<void> {
    // A claim another order holds is never released by this one.
    await this.#db
      .delete(paymentClaims)
      .where(
        and(
          eq(paymentClaims.fingerprint, fingerprint),
          eq(paymentClaims.orderId, orderId),
          eq(paymentClaims.retained, false),
        ),
      );
  }

  async forgetClaimsBefore(instant: number): Promise<number> {
    const gone = await this.#db
      .delete(paymentClaims)
      .where(and(lt(paymentClaims.claimedAt, new Date(instant)), eq(paymentClaims.retained, false)))
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
const PAYMENT_REF_TAKEN = "orders_payment_ref_unique";
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
  /** The split recorded for each, as `splitRecordedFor` reads it, or null. */
  split: SplitAsJson | null;
  pendingSplit: SplitAsJson | null;
}

/**
 * The wallet columns as one value. The table refuses half a pending change; if
 * one appears anyway it is read as nothing pending, never as a change taking
 * effect at an instant nobody wrote.
 */
function payoutWalletOf(row: WalletColumns): StoredPayoutWallet {
  return {
    address: row.payoutWallet,
    split: row.split === null ? null : recordedSplitOf(splitColumnsOf(row.split)),
    pending:
      row.pendingPayoutWallet === null || row.pendingPayoutWalletFrom === null
        ? null
        : {
            address: row.pendingPayoutWallet,
            takesEffectAt: row.pendingPayoutWalletFrom.getTime(),
            split:
              row.pendingSplit === null ? null : recordedSplitOf(splitColumnsOf(row.pendingSplit)),
          },
  };
}

/** Every column of a merchant, for a read that adds the splits beside them. */
const MERCHANT_COLUMNS = {
  id: merchants.id,
  name: merchants.name,
  serviceName: merchants.serviceName,
  sellerSite: merchants.sellerSite,
  payoutWallet: merchants.payoutWallet,
  pendingPayoutWallet: merchants.pendingPayoutWallet,
  pendingPayoutWalletFrom: merchants.pendingPayoutWalletFrom,
  liveApprovedAt: merchants.liveApprovedAt,
  selling: merchants.selling,
  integration: merchants.integration,
  createdAt: merchants.createdAt,
};

/** A row of the registry as `row_to_json` writes it: the column names, the instant as text. */
interface SplitAsJson {
  readonly address: string;
  readonly network: string;
  readonly merchant_id: string;
  readonly merchant_wallet: string;
  readonly commission_wallet: string;
  readonly merchant_allocation: number;
  readonly commission_allocation: number;
  readonly total_allocation: number;
  readonly distribution_incentive: number;
  readonly owner: string;
  readonly salt: string;
  readonly factory: string;
  readonly recorded_at: string;
}

/**
 * The split recorded on this network for the merchant's wallet in this
 * column, as one JSON value, or null. The wallet is compared in lower case,
 * as the table's key compares it, so the key makes it at most one row and a
 * wallet stored in lower case finds the row that names it checksummed.
 */
const splitRecordedFor = (
  network: string,
  wallet: typeof merchants.payoutWallet | typeof merchants.pendingPayoutWallet,
) =>
  sql<SplitAsJson | null>`(
    select row_to_json(recorded) from ${payoutSplits} as recorded
    where recorded.network = ${network} and recorded.merchant_id = ${merchants.id}
      and lower(recorded.merchant_wallet) = lower(${wallet}))`;

function splitColumnsOf(json: SplitAsJson): typeof payoutSplits.$inferSelect {
  return {
    address: json.address,
    network: json.network,
    merchantId: json.merchant_id,
    merchantWallet: json.merchant_wallet,
    commissionWallet: json.commission_wallet,
    merchantAllocation: json.merchant_allocation,
    commissionAllocation: json.commission_allocation,
    totalAllocation: json.total_allocation,
    distributionIncentive: json.distribution_incentive,
    owner: json.owner,
    salt: json.salt,
    factory: json.factory,
    recordedAt: new Date(json.recorded_at),
  };
}

function recordedSplitOf(row: typeof payoutSplits.$inferSelect): RecordedPayoutSplit {
  return {
    address: row.address,
    network: row.network,
    merchantId: row.merchantId,
    merchantWallet: row.merchantWallet,
    commissionWallet: row.commissionWallet,
    merchantAllocation: row.merchantAllocation,
    commissionAllocation: row.commissionAllocation,
    totalAllocation: row.totalAllocation,
    distributionIncentive: row.distributionIncentive,
    owner: row.owner,
    salt: row.salt,
    factory: row.factory,
    recordedAt: row.recordedAt.getTime(),
  };
}

/**
 * How many splits one statement records. A statement carries at most 65,535
 * values and a row is thirteen, so a start over five thousand wallets without
 * splits, sent as one statement, would be refused on every attempt.
 */
const SPLITS_PER_STATEMENT = 1_000;

/**
 * Records the splits with no row yet, inside the caller's transaction, and
 * returns those it recorded. A split already recorded under its merchant,
 * wallet and network is left as it is, provided it is recorded at the same
 * address; any other clash refuses, and the transaction with it.
 */
async function recordWithin(
  tx: Queries,
  splits: readonly PayoutSplit[],
  at: number,
): Promise<RecordedPayoutSplit[]> {
  const inserted: (typeof payoutSplits.$inferSelect)[] = [];
  for (let from = 0; from < splits.length; from += SPLITS_PER_STATEMENT) {
    const chunk = splits.slice(from, from + SPLITS_PER_STATEMENT);
    inserted.push(
      ...(await tx
        .insert(payoutSplits)
        .values(chunk.map((split) => ({ ...split, recordedAt: new Date(at) })))
        .onConflictDoNothing()
        .returning()),
    );
  }
  const written = new Set(inserted.map((row) => row.address));
  for (const split of splits) {
    if (written.has(split.address)) {
      continue;
    }
    const [held] = await tx
      .select({ address: payoutSplits.address })
      .from(payoutSplits)
      .where(
        and(
          eq(payoutSplits.network, split.network),
          eq(payoutSplits.merchantId, split.merchantId),
          sql`lower(${payoutSplits.merchantWallet}) = lower(${split.merchantWallet})`,
        ),
      )
      .limit(1);
    if (held?.address !== split.address) {
      throw recordedOtherwise(split);
    }
  }
  return inserted.map(recordedSplitOf);
}

function storedMerchantOf(
  row: WalletColumns & {
    id: string;
    name: string;
    serviceName: string | null;
    sellerSite: string | null;
    liveApprovedAt: Date | null;
    selling: MerchantSelling;
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
    selling: row.selling,
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
  lastUserAgent: string | null;
}): StoredKey {
  return {
    id: row.id,
    merchantId: row.merchantId,
    label: row.label,
    createdAt: row.createdAt.getTime(),
    disabledAt: row.disabledAt === null ? null : row.disabledAt.getTime(),
    lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.getTime(),
    lastUserAgent: row.lastUserAgent,
  };
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
    open: listedAsOpen(record.order),
    lapsed: lapsedAttempt(record),
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
    console.error(`[gateway] an idle database connection failed: ${failureNamed(error)}`);
  });

  // One shared function, since listeners are removed by identity.
  const noticeTheFailure = (failed: unknown) => {
    console.error(
      `[gateway] a database connection somebody was holding failed: ${failureNamed(failed)}`,
    );
  };
  pool.on("acquire", (client) => client.on("error", noticeTheFailure));
  pool.on("release", (_failed, client) => client.removeListener("error", noticeTheFailure));

  return { db: drizzle(pool), pool };
}

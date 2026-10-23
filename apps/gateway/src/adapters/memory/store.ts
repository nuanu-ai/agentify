/**
 * The store in memory. The application logic is tested against it, so it keeps
 * the Postgres adapter's promises: an order is held per order while a decision
 * is made (a promise queue per identifier where Postgres takes a row lock),
 * orders are frozen on the way in so a caller editing a kept reference cannot
 * edit the store, and every read that names a merchant filters on it exactly
 * as the SQL does, because the two-merchant tests run here.
 */

import { listedAsOpen, type MerchantSelling } from "@agentify/core";
import type { Card, Receipt, WorkerEnvelope } from "@nuanu-ai/agentify-contracts";
import type { AnalyticsEvent } from "../../analytics/events.js";
import type { Clock, Ids } from "../../ports/clock.js";
import type { Reminder } from "../../ports/queue.js";
import {
  type AnalyticsOf,
  analyticsEventOf,
  type Birth,
  type Born,
  type CatalogEntry,
  type ClaimHolder,
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
  type WithTheOrder,
  waitsForPayment,
} from "../../ports/store.js";
import { isSameAddress } from "../../split/address.js";
import type { PayoutSplit } from "../../split/parameters.js";
import { recordedOtherwise, splitsOfTheWrite } from "../registry.js";

/**
 * Where this store puts an envelope that must be written with an order. `stage`
 * takes the envelope, and may refuse, before the order is written; the call it
 * returns makes the envelope visible to workers after. Postgres gets both from
 * one transaction, and here the ordering stands in for it: taking the envelope
 * late leaves an order claiming a hand-over that never happened, and showing
 * it early lets the poll hand over a merchant event for an order not yet
 * written.
 */
export interface Envelopes {
  stage(merchantId: string, envelope: WorkerEnvelope, afterMs?: number): Promise<() => void>;
  /**
   * Lets go of the envelopes that carry a parcel's address in the same two
   * halves: anything that would refuse refuses here, and the returned call
   * takes them off the stream once the order recording the erasure is written.
   */
  forget(merchantId: string, orderId: string, priceQuestion: string | null): Promise<() => void>;
  /** Sets a reminder an order's birth asked for, once the order is written. */
  remind(reminder: Reminder, afterMs: number): Promise<void>;
}

/**
 * For a store built without a stream, which only commands and catalog tests
 * use: writing an order there refuses out loud rather than dropping a
 * merchant's work.
 */
const noEnvelopes: Envelopes = {
  async stage(_merchantId, envelope) {
    throw new Error(
      `this store was built with nowhere to put the envelope ${envelope.id}: a store that writes orders is given a stream`,
    );
  },
  async forget(_merchantId, orderId) {
    throw new Error(
      `this store was built with no stream to take ${orderId}'s envelopes off: a store that writes orders is given a stream`,
    );
  },
  async remind(reminder) {
    throw new Error(
      `this store was built with no queue to set the clock of ${reminder.orderId} on: a store that writes orders is given one`,
    );
  },
};

interface MerchantRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  selling: MerchantSelling;
  serviceName: string | null;
  sellerSite: string | null;
  payoutWallet: PayoutWalletRead;
  liveApprovedAt: number | null;
  /** The integration this merchant sells through now. */
  integration: Integration;
}

export class MemoryStore implements Store {
  readonly #merchants = new Map<string, MerchantRow>();
  readonly #keys = new Map<string, StoredKey>();
  readonly #keysByDigest = new Map<string, string>();
  readonly #cards = new Map<string, StoredCard>();
  /**
   * Keyed by merchant and their own product identifier, which is unique only
   * within one merchant's catalog.
   */
  readonly #cardIdByMerchantKey = new Map<string, string>();
  readonly #orders = new Map<string, StoredOrder>();
  /** When each order was last written, by this store's clock, as Postgres stamps a row. */
  readonly #written = new Map<string, number>();
  /** The latest poll recorded for each merchant. */
  readonly #contact = new Map<string, number>();
  readonly #receipts = new Map<string, { merchantId: string; receipt: Receipt }>();
  /** Which order owns which payment, so no payment is spent on two. */
  #paymentLock: Promise<unknown> = Promise.resolve();
  readonly #paymentClaims = new Map<string, { orderId: string; at: number; retained?: boolean }>();
  /** Every split recorded, frozen, in the order recorded. */
  readonly #splits: RecordedPayoutSplit[] = [];
  /** The tail of the queue of decisions waiting on each order. */
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #running = new Set<string>();
  readonly #network: string;
  readonly #ids: Ids;
  readonly #now: Clock;
  readonly #envelopes: Envelopes;
  /** Every analytics event recorded, in the order recorded. */
  readonly #analytics: { readonly event: AnalyticsEvent; readonly at: Date }[] = [];

  constructor(
    network: string,
    ids: Ids,
    now: Clock = () => Date.now(),
    envelopes: Envelopes = noEnvelopes,
  ) {
    this.#network = network;
    this.#ids = ids;
    this.#now = now;
    this.#envelopes = envelopes;
  }

  get network(): string {
    return this.#network;
  }

  // --- product analytics ----------------------------------------------------

  /** What a test reads back: every analytics event recorded, in recording order. */
  get recordedAnalytics(): readonly { readonly event: AnalyticsEvent; readonly at: Date }[] {
    return [...this.#analytics];
  }

  async recordAnalytics(event: AnalyticsEvent, at: number | Date): Promise<void> {
    this.#analytics.push({ event, at: new Date(at) });
  }

  /** Records what a committing write's `analytics` makes of what it committed. */
  async #recordWith<R>(
    analytics: AnalyticsOf<R> | undefined,
    committed: R,
    at: number,
  ): Promise<void> {
    const event = analyticsEventOf(analytics, committed);
    if (event !== null) await this.recordAnalytics(event, at);
  }

  // --- merchants and their keys ---------------------------------------------

  async addMerchant(
    merchant: { readonly id: string; readonly name: string },
    at: number,
  ): Promise<StoredMerchant | null> {
    if (this.#merchants.has(merchant.id)) {
      return null;
    }
    const row: MerchantRow = {
      id: merchant.id,
      name: merchant.name,
      createdAt: at,
      selling: "open",
      serviceName: null,
      sellerSite: null,
      payoutWallet: { address: null, pending: null },
      liveApprovedAt: null,
      integration: "api",
    };
    this.#merchants.set(merchant.id, row);
    return this.#storedMerchantOf(row);
  }

  async merchantById(id: string): Promise<StoredMerchant | null> {
    const row = this.#merchants.get(id);
    return row === undefined ? null : this.#storedMerchantOf(row);
  }

  async grantLiveApproval(
    id: string,
    at: number,
    analytics?: AnalyticsOf<{ merchant: StoredMerchant; changed: boolean }>,
  ): Promise<{ merchant: StoredMerchant; changed: boolean } | null> {
    const row = this.#merchants.get(id);
    if (row === undefined) {
      return null;
    }
    const changed = row.liveApprovedAt === null;
    row.liveApprovedAt ??= at;
    const granted = { merchant: this.#storedMerchantOf(row), changed };
    if (changed) await this.#recordWith(analytics, granted, at);
    return granted;
  }

  async withdrawLiveApproval(
    id: string,
  ): Promise<{ merchant: StoredMerchant; changed: boolean } | null> {
    const row = this.#merchants.get(id);
    if (row === undefined) {
      return null;
    }
    const changed = row.liveApprovedAt !== null;
    row.liveApprovedAt = null;
    return { merchant: this.#storedMerchantOf(row), changed };
  }

  async merchants(): Promise<readonly StoredMerchant[]> {
    return [...this.#merchants.values()].map((row) => this.#storedMerchantOf(row));
  }

  async setServiceName(
    id: string,
    serviceName: string | null,
    at: number,
    analytics?: AnalyticsOf<StoredMerchant>,
  ): Promise<StoredMerchant | null> {
    const row = this.#merchants.get(id);
    if (row === undefined) {
      return null;
    }
    const changed = row.serviceName !== serviceName;
    row.serviceName = serviceName;
    const merchant = this.#storedMerchantOf(row);
    if (changed) await this.#recordWith(analytics, merchant, at);
    return merchant;
  }

  async setSellerSite(
    id: string,
    sellerSite: string,
    at: number,
    analytics?: AnalyticsOf<StoredMerchant>,
  ): Promise<StoredMerchant | null> {
    const row = this.#merchants.get(id);
    if (row === undefined) {
      return null;
    }
    const changed = row.sellerSite !== sellerSite;
    row.sellerSite = sellerSite;
    const merchant = this.#storedMerchantOf(row);
    if (changed) await this.#recordWith(analytics, merchant, at);
    return merchant;
  }

  async setPayoutWallet(
    id: string,
    expected: PayoutWalletRead,
    next: PayoutWalletWrite,
    at: number,
    analytics?: AnalyticsOf<WalletWritten>,
  ): Promise<WalletWritten | "moved" | null> {
    const splits = splitsOfTheWrite(id, this.#network, next);
    const row = this.#merchants.get(id);
    if (row === undefined) {
      return null;
    }
    // Nothing may be awaited between the comparison and the writes, or this
    // stops being the one transaction the database makes of the wallet and
    // its splits; whatever would refuse refuses before either is written.
    if (!sameWallet(row.payoutWallet, expected)) {
      return "moved";
    }
    const fresh = toRecord(this.#splits, splits);
    row.payoutWallet = {
      address: next.address,
      pending:
        next.pending === null
          ? null
          : { address: next.pending.address, takesEffectAt: next.pending.takesEffectAt },
    };
    const recorded = this.#record(fresh, at);
    const written = { merchant: this.#storedMerchantOf(row), recorded };
    await this.#recordWith(analytics, written, at);
    return written;
  }

  /**
   * Writes a merchant's wallet columns and no split. Only tests call this, to
   * hold what a start finds where a wallet was written without its split;
   * everything else writes a wallet through `setPayoutWallet`, with its split.
   */
  async writeWalletWithoutSplit(id: string, wallet: PayoutWalletRead): Promise<void> {
    const row = this.#merchants.get(id);
    if (row === undefined) {
      throw new Error(`there is no merchant ${id} to write a wallet for`);
    }
    row.payoutWallet = wallet;
  }

  // --- the payout splits ----------------------------------------------------

  async recordPayoutSplits(
    splits: readonly PayoutSplit[],
    at: number,
  ): Promise<readonly RecordedPayoutSplit[]> {
    return this.#record(toRecord(this.#splits, splits), at);
  }

  async payoutSplitAt(address: string): Promise<RecordedPayoutSplit | null> {
    return (
      this.#splits.find((split) => split.address.toLowerCase() === address.toLowerCase()) ?? null
    );
  }

  async networksWithPayoutSplits(): Promise<readonly string[]> {
    return [...new Set(this.#splits.map((split) => split.network))];
  }

  async splitsToPayOutFor(
    network: string,
    merchantId: string,
    at: number,
  ): Promise<readonly RecordedPayoutSplit[]> {
    const paidTo = new Set(
      [...this.#orders.values()].flatMap((record) =>
        record.payTo === null ? [] : [`${record.merchantId}\u0000${record.payTo.toLowerCase()}`],
      ),
    );
    return splitsInOrder(
      this.#splits.filter((split) => {
        if (split.network !== network || split.merchantId !== merchantId) return false;
        const wallet = this.#merchants.get(split.merchantId)?.payoutWallet;
        const inForce =
          wallet?.pending != null && wallet.pending.takesEffectAt <= at
            ? wallet.pending.address
            : wallet?.address;
        return (
          (inForce != null && isSameAddress(inForce, split.merchantWallet)) ||
          paidTo.has(`${split.merchantId}\u0000${split.address.toLowerCase()}`)
        );
      }),
    );
  }

  async payoutSplitsOn(network: string): Promise<readonly RecordedPayoutSplit[]> {
    return splitsInOrder(this.#splits.filter((split) => split.network === network));
  }

  /** Writes these splits, recorded at `at`, and hands back what was written. */
  #record(splits: readonly PayoutSplit[], at: number): readonly RecordedPayoutSplit[] {
    const recorded = splits.map((split) => Object.freeze({ ...split, recordedAt: at }));
    this.#splits.push(...recorded);
    return recorded;
  }

  /**
   * The split recorded for this merchant's wallet on this store's network, in
   * whichever spelling either is written, or null.
   */
  #splitOf(merchantId: string, wallet: string): RecordedPayoutSplit | null {
    return (
      this.#splits.find(
        (split) =>
          split.network === this.#network &&
          split.merchantId === merchantId &&
          isSameAddress(split.merchantWallet, wallet),
      ) ?? null
    );
  }

  #walletOf(row: MerchantRow): StoredPayoutWallet {
    const { address, pending } = row.payoutWallet;
    return {
      address,
      split: address === null ? null : this.#splitOf(row.id, address),
      pending:
        pending === null ? null : { ...pending, split: this.#splitOf(row.id, pending.address) },
    };
  }

  #storedMerchantOf(row: MerchantRow): StoredMerchant {
    return {
      id: row.id,
      name: row.name,
      serviceName: row.serviceName,
      sellerSite: row.sellerSite,
      payoutWallet: this.#walletOf(row),
      liveApprovedAt: row.liveApprovedAt,
      selling: row.selling,
      integration: row.integration,
      createdAt: row.createdAt,
    };
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
    if (!this.#merchants.has(key.merchantId)) {
      // The database refuses this with a foreign key; written down here, it
      // would be a key that opens a door onto nothing.
      throw new Error(`there is no merchant ${key.merchantId} for a key to belong to`);
    }
    // The database refuses a duplicate identifier; a map would silently
    // replace one merchant's key with another's.
    if (this.#keys.has(key.id)) {
      throw new Error(`the key ${key.id} is already written down`);
    }
    if (this.#keysByDigest.has(key.digest)) {
      throw new Error(`a key with that digest is already written down`);
    }
    const stored: StoredKey = Object.freeze({
      id: key.id,
      merchantId: key.merchantId,
      label: key.label,
      createdAt: at,
      disabledAt: null,
      lastUsedAt: null,
      lastUserAgent: null,
    });
    this.#keys.set(stored.id, stored);
    this.#keysByDigest.set(key.digest, stored.id);
    await this.#recordWith(analytics, stored, at);
    return stored;
  }

  async noteKeyUse(id: string, at: number, userAgent: string | null): Promise<void> {
    const found = this.#keys.get(id);
    if (found === undefined) {
      // Removed with its merchant after the door read it; nothing to write.
      return;
    }
    if (found.lastUsedAt !== null && found.lastUsedAt >= at) {
      // Two gateways on two clocks can deliver an older call after a newer
      // one; the mark only moves forwards.
      return;
    }
    this.#keys.set(found.id, Object.freeze({ ...found, lastUsedAt: at, lastUserAgent: userAgent }));
  }

  async noteContact(merchantId: string, at: number): Promise<void> {
    if (!this.#merchants.has(merchantId)) return;
    this.#contact.set(merchantId, Math.max(this.#contact.get(merchantId) ?? at, at));
  }

  async lastContact(merchantId: string): Promise<number | null> {
    return this.#contact.get(merchantId) ?? null;
  }

  async workingKey(digest: string): Promise<StoredKey | null> {
    const keyId = this.#keysByDigest.get(digest);
    const key = keyId === undefined ? undefined : this.#keys.get(keyId);
    // A disabled key answers exactly what a key nobody issued answers.
    return key === undefined || key.disabledAt !== null ? null : key;
  }

  async keyByDigest(digest: string): Promise<StoredKey | null> {
    const keyId = this.#keysByDigest.get(digest);
    return (keyId === undefined ? undefined : this.#keys.get(keyId)) ?? null;
  }

  async keysOf(merchantId: string): Promise<readonly StoredKey[]> {
    // Sorted as the database sorts, so a test about a merchant's keys means
    // the same in both adapters even when two keys share an instant.
    return [...this.#keys.values()]
      .filter((key) => key.merchantId === merchantId)
      .sort((one, other) => one.createdAt - other.createdAt || (one.id < other.id ? -1 : 1));
  }

  async disableKey(id: string, at: number): Promise<StoredKey | null> {
    const found = this.#keys.get(id);
    return found === undefined ? null : this.#revoke(found, at);
  }

  async disableKeyOf(merchantId: string, id: string, at: number): Promise<StoredKey | null> {
    const found = this.#keys.get(id);
    // Another merchant's key is not found rather than refused, so a refusal
    // says nothing about whose keys exist.
    if (found === undefined || found.merchantId !== merchantId) {
      return null;
    }
    return this.#revoke(found, at);
  }

  #revoke(found: StoredKey, at: number): StoredKey {
    const stored: StoredKey = Object.freeze({ ...found, disabledAt: found.disabledAt ?? at });
    this.#keys.set(found.id, stored);
    return stored;
  }

  // --- the catalog ----------------------------------------------------------

  async publishCard(
    merchantId: string,
    card: Card,
    at: number,
    integration: Integration = "api",
    analytics?: AnalyticsOf<StoredCard>,
  ): Promise<StoredCard> {
    const owned = catalogKey(merchantId, card.merchant_item_id);
    const existing = this.#cardIdByMerchantKey.get(owned);
    const before = existing === undefined ? undefined : this.#cards.get(existing);
    // A card stays with the integration that first published it.
    if (before !== undefined && before.integration !== integration) {
      return before;
    }
    const id = existing ?? this.#ids("item");
    // A pause survives a republish: editing a price never puts a product back
    // on sale.
    const paused = before?.paused ?? false;
    const stored: StoredCard = Object.freeze({
      id,
      merchantId,
      card,
      asOf: at,
      paused,
      integration,
    });

    this.#cardIdByMerchantKey.set(owned, id);
    this.#cards.set(id, stored);
    if (before === undefined) await this.#recordWith(analytics, stored, at);
    return stored;
  }

  async cardById(id: string): Promise<StoredCard | null> {
    return this.#cards.get(id) ?? null;
  }

  async cards(merchantId: string): Promise<readonly StoredCard[]> {
    return [...this.#cards.values()].filter((card) => card.merchantId === merchantId);
  }

  async catalogEntries(): Promise<readonly CatalogEntry[]> {
    return [...this.#cards.values()].map((card) => ({
      card,
      merchant: this.#sellingOf(card.merchantId),
      payoutWallet: this.#walletOfMerchant(card.merchantId),
      serviceName: this.#merchants.get(card.merchantId)?.serviceName ?? null,
      sellerSite: this.#merchants.get(card.merchantId)?.sellerSite ?? null,
      liveApprovedAt: this.#merchants.get(card.merchantId)?.liveApprovedAt ?? null,
      integration: this.#merchants.get(card.merchantId)?.integration ?? "api",
    }));
  }

  async setCardPaused(
    merchantId: string,
    id: string,
    paused: boolean,
    analytics?: AnalyticsOf<StoredCard>,
  ): Promise<StoredCard | null> {
    const found = this.#cards.get(id);
    // Another merchant's card is not found, the same answer as a card that is
    // not there, so pausing cannot discover what exists.
    if (found === undefined || found.merchantId !== merchantId) {
      return null;
    }
    const stored: StoredCard = Object.freeze({ ...found, paused });
    this.#cards.set(id, stored);
    if (found.paused !== paused) await this.#recordWith(analytics, stored, this.#now());
    return stored;
  }

  async selling(merchantId: string): Promise<MerchantSelling> {
    return this.#sellingOf(merchantId);
  }

  async setSelling(
    merchantId: string,
    selling: MerchantSelling,
    analytics?: AnalyticsEvent,
  ): Promise<void> {
    const row = this.#merchants.get(merchantId);
    if (row === undefined) {
      throw new Error(`there is no merchant ${merchantId} to stop or start selling`);
    }
    const changed = row.selling !== selling;
    row.selling = selling;
    if (changed) await this.#recordWith(analytics, undefined, this.#now());
  }

  async switchIntegration(
    merchantId: string,
    to: Integration,
    analytics?: AnalyticsEvent,
  ): Promise<IntegrationSwitch> {
    // No await between the reads and the write, so nothing interleaves with
    // it in the one process this map lives in, the birth of an order included.
    const row = this.#merchants.get(merchantId);
    if (row === undefined) {
      throw new Error(`there is no merchant ${merchantId} to switch to ${to}`);
    }
    if (row.integration === to) {
      return { switched: true, sellingPaused: false };
    }
    const waiting = [...this.#orders.values()]
      .filter(
        (record) =>
          record.merchantId === merchantId &&
          listedAsOpen(record.order) &&
          !(NO_PENDING_HANDLER as readonly string[]).includes(record.order.state),
      )
      .sort((one, other) => one.order.timestamps.createdAt - other.order.timestamps.createdAt)
      .map((record) => record.order.id);
    if (waiting.length > 0) {
      return { switched: false, waiting };
    }
    const sellingPaused =
      to === "api" &&
      row.selling === "open" &&
      [...this.#cards.values()].some(
        (card) => card.merchantId === merchantId && card.integration === to && !card.paused,
      );
    row.integration = to;
    if (sellingPaused) {
      row.selling = "paused";
      await this.#recordWith(analytics, undefined, this.#now());
    }
    return { switched: true, sellingPaused };
  }

  // --- orders ---------------------------------------------------------------

  async addOrder(record: StoredOrder, birth?: Birth, analytics?: AnalyticsEvent): Promise<Born> {
    if (this.#orders.has(record.order.id)) {
      throw new Error(`the order ${record.order.id} is already written down`);
    }
    if ([...this.#orders.values()].some((held) => held.buyerKey === record.buyerKey)) {
      throw new Error(`the order ${record.order.id} carries a buyer's key another order has`);
    }
    // No await from here to the write, so the count and the write are one step
    // against every other birth in the one process this map lives in.
    if (birth !== undefined) {
      if (this.#merchants.get(record.merchantId)?.integration !== birth.through) {
        return "switched_away";
      }
      if (
        this.#waiting(record.merchantId, record.order.timestamps.createdAt, birth.waitingAtMost) >=
        birth.waitingAtMost
      ) {
        return "too_many_waiting";
      }
    }
    this.#orders.set(record.order.id, Object.freeze({ ...record }));
    this.#written.set(record.order.id, this.#now());
    // Set after the write and taken back with it where one is refused, as the
    // transaction on Postgres rolls back the order with its clocks.
    try {
      for (const clock of birth?.clocks ?? []) {
        await this.#envelopes.remind(clock.reminder, clock.afterMs);
      }
    } catch (thrown) {
      this.#orders.delete(record.order.id);
      this.#written.delete(record.order.id);
      throw thrown;
    }
    if (analytics !== undefined) {
      await this.recordAnalytics(analytics, record.order.timestamps.createdAt);
    }
    return "written";
  }

  async waitingForPayment(merchantId: string, at: number, atMost: number): Promise<number> {
    return this.#waiting(merchantId, at, atMost);
  }

  #waiting(merchantId: string, at: number, atMost: number): number {
    const waiting = [...this.#orders.values()].filter(
      (held) => held.merchantId === merchantId && waitsForPayment(held, at),
    ).length;
    return Math.min(waiting, atMost);
  }

  async orderById(id: string): Promise<StoredOrder | null> {
    return this.#orders.get(id) ?? null;
  }

  async orderByBuyerKey(buyerKey: string): Promise<StoredOrder | null> {
    return [...this.#orders.values()].find((record) => record.buyerKey === buyerKey) ?? null;
  }

  async merchantOrder(merchantId: string, id: string): Promise<StoredOrder | null> {
    const found = this.#orders.get(id);
    return found === undefined || found.merchantId !== merchantId ? null : found;
  }

  async orders(
    merchantId: string,
    query?: { readonly open?: boolean; readonly leaveOutLapsed?: boolean },
  ): Promise<readonly StoredOrder[]> {
    const mine = [...this.#orders.values()].filter(
      (record) =>
        record.merchantId === merchantId &&
        (query?.leaveOutLapsed !== true || !lapsedAttempt(record)),
    );
    return query?.open === true ? mine.filter((record) => listedAsOpen(record.order)) : mine;
  }

  async lapsedAttempts(
    merchantId: string,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<{ readonly orders: readonly StoredOrder[]; readonly of: number }> {
    const lapsed = [...this.#orders.values()]
      .filter((record) => record.merchantId === merchantId && lapsedAttempt(record))
      .sort(
        (one, other) =>
          other.order.timestamps.createdAt - one.order.timestamps.createdAt ||
          (one.order.id < other.order.id ? 1 : -1),
      );
    return { orders: lapsed.slice(page.offset, page.offset + page.limit), of: lapsed.length };
  }

  async withOrder<T>(
    id: string,
    change: (found: StoredOrder) => Promise<OrderChange<T>> | OrderChange<T>,
    scope?: MerchantScope,
    analytics?: OrderAnalytics,
  ): Promise<OrderLookup<T>> {
    // Each order's decisions run one after another. Only the tail of the chain
    // is kept, so an idle order costs one settled promise.
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const mine = previous.then(async (): Promise<OrderLookup<T>> => {
      const found = this.#orders.get(id);
      // Ownership is read under the same hold, so there is no window between
      // learning whose the order is and acting on it.
      if (found === undefined || (scope !== undefined && found.merchantId !== scope.merchantId)) {
        return { found: false };
      }

      const decided = await change(found);

      // Three steps, which Postgres gets from one transaction: take everything
      // that goes with the order, so anything that would refuse does so before
      // the order is written; write the order; then make what was taken
      // visible. Writing the order first could leave it claiming an effect that
      // never happened, and making envelopes visible first lets the poll hand
      // over a merchant event for an order not yet written. Envelopes are taken
      // before receipts because taking an envelope can refuse and writing a
      // receipt cannot, so a refusal leaves nothing written.
      const alongside = [...(decided.alongside ?? [])].sort(
        (one, other) => rankOf(one) - rankOf(other),
      );
      const write = async (): Promise<OrderLookup<T>> => {
        const arrivals: (() => void)[] = [];
        for (const write of alongside) {
          arrivals.push(await this.#takeWithTheOrder(write));
        }

        if (decided.save !== undefined) {
          // The merchant comes from the order that was read, not from the save,
          // as the Postgres adapter takes it from the row: no decision may change
          // whose sale it is.
          const saved = Object.freeze({ ...decided.save, merchantId: found.merchantId });
          const observed = analytics?.(found, saved) ?? [];
          this.#orders.set(id, saved);
          this.#written.set(id, this.#now());
          for (const { event, at } of observed) {
            await this.recordAnalytics(event, at);
          }
        }

        // None of these can refuse, which is what makes the order safe to have
        // written first.
        for (const arrive of arrivals) {
          arrive();
        }
        return { found: true, result: decided.result };
      };
      return alongside.some((write) => write.kind === "retain_payment")
        ? this.#withPaymentClaims(write)
        : write();
    });

    // The chain must not break on a failed decision, or every later decision
    // about that order would inherit the failure and never run.
    this.#locks.set(
      id,
      mine.catch(() => undefined),
    );
    return mine;
  }

  async openOrders(): Promise<readonly StoredOrder[]> {
    return [...this.#orders.values()].filter((record) => listedAsOpen(record.order));
  }

  async unresolvedPayments(afterId = "", limit = 100): Promise<readonly StoredOrder[]> {
    return [...this.#orders.values()]
      .filter(
        (record) =>
          record.order.id > afterId &&
          (record.order.payment === "settling" || record.order.payment === "outcome_unknown"),
      )
      .sort((one, other) => (one.order.id < other.order.id ? -1 : 1))
      .slice(0, limit);
  }

  async paymentOrders(afterId = "", limit = 100): Promise<readonly StoredOrder[]> {
    return [...this.#orders.values()]
      .filter((record) => record.order.id > afterId && record.payment !== null)
      .sort((one, other) => (one.order.id < other.order.id ? -1 : 1))
      .slice(0, limit);
  }

  async runAlone<T>(name: string, work: () => Promise<T>): Promise<Ran<T>> {
    // The name is taken before anything is awaited, which is what makes it a
    // lock: two callers starting in the same turn cannot both pass this check.
    if (this.#running.has(name)) {
      return { ran: false };
    }
    this.#running.add(name);
    try {
      return { ran: true, result: await work() };
    } finally {
      this.#running.delete(name);
    }
  }

  async forgetLapsedBefore(instant: number, limit: number): Promise<number> {
    const claimed = new Set([...this.#paymentClaims.values()].map((claim) => claim.orderId));
    const gone = [...this.#orders.values()]
      .filter(
        (record) =>
          lapsedAttempt(record) &&
          (this.#written.get(record.order.id) ?? instant) < instant &&
          !this.#receipts.has(record.order.id) &&
          !claimed.has(record.order.id),
      )
      .slice(0, limit);
    for (const record of gone) {
      this.#orders.delete(record.order.id);
      this.#written.delete(record.order.id);
    }
    return gone.length;
  }

  async deliveredWithoutReceipt(): Promise<readonly StoredOrder[]> {
    return [...this.#orders.values()].filter(
      (record) => record.order.state === "delivered" && !this.#receipts.has(record.order.id),
    );
  }

  /**
   * Takes one write that goes with an order and returns the call that makes it
   * visible. A receipt is visible as soon as it is written, since writing it
   * cannot refuse, so for a microtask before the order is written a reader
   * could see a `delivered` receipt for an order that still says otherwise. It
   * goes through `putReceipt` so a receipt's merchant is decided in one place.
   */
  async #takeWithTheOrder(write: WithTheOrder): Promise<() => void> {
    switch (write.kind) {
      case "retain_payment": {
        const claim = this.#paymentClaims.get(write.fingerprint);
        if (claim?.orderId !== write.orderId)
          throw new Error("the payment claim no longer belongs to this order");
        return () => {
          claim.retained = true;
        };
      }
      case "receipt":
        await this.putReceipt(write.merchantId, write.receipt);
        return () => {};
      case "envelope":
        return this.#envelopes.stage(write.merchantId, write.envelope, write.afterMs);
      case "forget":
        return this.#envelopes.forget(write.merchantId, write.orderId, write.priceQuestion);
    }
  }

  // --- payments -------------------------------------------------------------

  async claimPayment(fingerprint: string, orderId: string): Promise<PaymentClaim> {
    return this.#withPaymentClaims(() => {
      const held = this.#paymentClaims.get(fingerprint);
      if (held === undefined) {
        this.#paymentClaims.set(fingerprint, { orderId, at: this.#now() });
        return { claimed: true };
      }
      // The same order presenting the same payment again is an ordinary retry,
      // and it still owns it.
      return held.orderId === orderId
        ? { claimed: true }
        : { claimed: false, heldBy: held.orderId };
    });
  }

  async paymentClaimHolder(fingerprint: string): Promise<ClaimHolder | null> {
    return this.#withPaymentClaims(() => {
      const claim = this.#paymentClaims.get(fingerprint);
      return claim === undefined
        ? null
        : { orderId: claim.orderId, retained: claim.retained === true };
    });
  }

  async releaseClaim(fingerprint: string, orderId: string): Promise<void> {
    // Only the holder lets go, so this can never hand one buyer's signature to
    // another.
    await this.#withPaymentClaims(() => {
      const claim = this.#paymentClaims.get(fingerprint);
      if (claim?.orderId === orderId && !claim.retained) {
        this.#paymentClaims.delete(fingerprint);
      }
    });
  }

  async forgetClaimsBefore(instant: number): Promise<number> {
    return this.#withPaymentClaims(() => {
      let gone = 0;
      for (const [fingerprint, claim] of [...this.#paymentClaims]) {
        if (claim.at < instant && !claim.retained) {
          this.#paymentClaims.delete(fingerprint);
          gone += 1;
        }
      }
      return gone;
    });
  }

  #withPaymentClaims<T>(work: () => T | Promise<T>): Promise<T> {
    const pending = this.#paymentLock.then(work);
    this.#paymentLock = pending.catch(() => undefined);
    return pending;
  }

  // --- receipts -------------------------------------------------------------

  async putReceipt(merchantId: string, receipt: Receipt): Promise<void> {
    // A receipt is rewritten as its order moves on, but keeps the merchant it
    // was first written with, as the Postgres upsert leaves that column out.
    const held = this.#receipts.get(receipt.order_id);
    this.#receipts.set(receipt.order_id, {
      merchantId: held?.merchantId ?? merchantId,
      receipt: Object.freeze({ ...receipt }),
    });
  }

  async receiptForOrder(orderId: string): Promise<Receipt | null> {
    return this.#receipts.get(orderId)?.receipt ?? null;
  }

  async receipts(merchantId: string): Promise<readonly Receipt[]> {
    return [...this.#receipts.values()]
      .filter((held) => held.merchantId === merchantId)
      .map((held) => held.receipt);
  }

  #walletOfMerchant(merchantId: string): StoredPayoutWallet {
    const row = this.#merchants.get(merchantId);
    return row === undefined ? NO_WALLET : this.#walletOf(row);
  }

  /**
   * A missing merchant is a defect, since every key, card and order names one
   * that exists, so this throws rather than answer "open" for somebody nobody
   * can find.
   */
  #sellingOf(merchantId: string): MerchantSelling {
    const row = this.#merchants.get(merchantId);
    if (row === undefined) {
      throw new Error(`there is no merchant ${merchantId}, so there is no word for their selling`);
    }
    return row.selling;
  }
}

/** Writes that can refuse are taken before those that cannot. */
function rankOf(write: WithTheOrder): number {
  return write.kind === "receipt" ? 1 : 0;
}

function catalogKey(merchantId: string, merchantItemId: string): string {
  // A separator neither half can carry: a merchant's product identifier may
  // hold spaces and slashes ("SKU 100/1"), so a printable separator could make
  // two different pairs one string.
  return `${merchantId}\u0000${merchantItemId}`;
}

const NO_WALLET: StoredPayoutWallet = { address: null, split: null, pending: null };

/**
 * Those of `splits` not recorded yet, each once, or a refusal where one's
 * merchant, wallet and network, or its address, is recorded otherwise, as the
 * table's two unique keys refuse it: both compare an address in either
 * spelling.
 */
function toRecord(
  recorded: readonly RecordedPayoutSplit[],
  splits: readonly PayoutSplit[],
): readonly PayoutSplit[] {
  const fresh: PayoutSplit[] = [];
  for (const split of splits) {
    const held = [...recorded, ...fresh].find(
      (one) =>
        one.network === split.network &&
        ((one.merchantId === split.merchantId &&
          isSameAddress(one.merchantWallet, split.merchantWallet)) ||
          isSameAddress(one.address, split.address)),
    );
    if (held === undefined) {
      fresh.push(split);
    } else if (
      held.address !== split.address ||
      held.merchantId !== split.merchantId ||
      !isSameAddress(held.merchantWallet, split.merchantWallet)
    ) {
      throw recordedOtherwise(split);
    }
  }
  return fresh;
}

/**
 * In the order recorded, the address settling a tie by its characters, as
 * Postgres sorts them. Two splits of one network never share an address.
 */
function splitsInOrder(splits: readonly RecordedPayoutSplit[]): readonly RecordedPayoutSplit[] {
  return [...splits].sort(
    (one, other) => one.recordedAt - other.recordedAt || (one.address < other.address ? -1 : 1),
  );
}

function sameWallet(one: PayoutWalletRead, other: PayoutWalletRead): boolean {
  return (
    one.address === other.address &&
    one.pending?.address === other.pending?.address &&
    one.pending?.takesEffectAt === other.pending?.takesEffectAt
  );
}

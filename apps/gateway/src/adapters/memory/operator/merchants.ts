/** The merchants area's reads across merchants, in memory, over the store's holdings. */

import { readinessOf, type SurfaceMode } from "@agentify/core";
import type { Money, Receipt } from "@nuanu-ai/agentify-contracts";
import { payoutWalletAt } from "../../../app/runtime.js";
import {
  amountOfScaled,
  dayOf,
  MERCHANT_PAGE_CUT,
  MERCHANT_SEGMENTS,
  type MerchantCard,
  type MerchantList,
  type MerchantListQuery,
  type MerchantRecord,
  type MerchantRow,
  merchantLimitOf,
  type OperatorMerchants,
  type OrderWorthALook,
  SELLING_DAYS,
  type SellingDay,
  type SettledSales,
  scaledAmount,
  searchOf,
  segmentOf,
  sellingFrom,
  WORTH_A_LOOK_STATES,
} from "../../../ports/operator/merchants.js";
import { paymentUnknown } from "../../../ports/operator/orders.js";
import { lapsedAttempt, type StoredMerchant } from "../../../ports/store.js";
import type { MemoryHoldings } from "../store.js";
import type { MemoryScope } from "./index.js";

const DAY_MS = 86_400_000;

/** Payments whose money moved, summed exactly in each currency. */
function settledOf(receipts: readonly Receipt[]): SettledSales {
  const sums = new Map<string, bigint>();
  for (const { price } of receipts) {
    sums.set(price.currency, (sums.get(price.currency) ?? 0n) + scaledAmount(price.amount));
  }
  const sorted: Money[] = [...sums.entries()]
    .sort(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0))
    .map(([currency, scaled]) => ({ amount: amountOfScaled(scaled), currency }));
  return { count: receipts.length, sums: sorted };
}

const paidAtOf = (receipt: Receipt): number => Date.parse(receipt.paid_at);

/** Everything one merchant's row and page are drawn from, as of `at` on `surface`. */
function factsOf(
  holdings: MemoryHoldings,
  merchant: StoredMerchant,
  at: number,
  surface: SurfaceMode,
) {
  const wallet = payoutWalletAt(merchant.payoutWallet, at);
  const { missing } = readinessOf(
    {
      sellerName: merchant.serviceName,
      payoutWallet: wallet.address !== null && wallet.split !== null ? wallet.split.address : null,
      liveApproval: merchant.liveApprovedAt !== null,
    },
    surface,
  );
  const cards = holdings.cards.filter((card) => card.merchantId === merchant.id);
  const ofIntegration = cards.filter((card) => card.integration === merchant.integration);
  const sells = missing.length === 0 && merchant.selling === "open";
  const onSale = (card: (typeof cards)[number]) =>
    sells && !card.paused && card.integration === merchant.integration;
  const keys = holdings.keys.filter((key) => key.merchantId === merchant.id);
  const from = sellingFrom(at);
  const counted = (instant: number) => instant >= from && instant <= at;
  const receipts = holdings.receipts
    .filter((held) => held.merchantId === merchant.id)
    .map((held) => held.receipt);
  const inDays = receipts.filter((receipt) => counted(paidAtOf(receipt)));
  const orders = holdings.orders
    .map((held) => held.record)
    .filter((record) => record.merchantId === merchant.id);
  const lastSale = receipts.reduce<number | null>(
    (latest, receipt) => Math.max(latest ?? Number.NEGATIVE_INFINITY, paidAtOf(receipt)),
    null,
  );
  const row: MerchantRow = {
    id: merchant.id,
    serviceName: merchant.serviceName,
    sellerSite: merchant.sellerSite,
    createdAt: merchant.createdAt,
    integration: merchant.integration,
    segment: segmentOf({
      surface,
      missing,
      selling: merchant.selling,
      ofIntegration: ofIntegration.length,
      unpaused: ofIntegration.filter((card) => !card.paused).length,
    }),
    missing,
    keys: { issued: keys.length, working: keys.filter((key) => key.disabledAt === null).length },
    lastContactAt: holdings.contact.get(merchant.id) ?? null,
    cards: { onSale: cards.filter(onSale).length, published: cards.length },
    thirtyDays: {
      from,
      orders: orders.filter(
        (record) => !lapsedAttempt(record) && counted(record.order.timestamps.createdAt),
      ).length,
      settled: settledOf(inDays),
    },
    lastSaleAt: lastSale,
  };
  return { row, wallet, cards, onSale, keys, inDays, orders, from };
}

/** The list's order: who waits for the operator, then the latest sale, then the newest merchant. */
function listed(one: MerchantRow, other: MerchantRow): number {
  const waits = (row: MerchantRow) => (row.segment === "waiting" ? 0 : 1);
  return (
    waits(one) - waits(other) ||
    (other.lastSaleAt ?? Number.NEGATIVE_INFINITY) - (one.lastSaleAt ?? Number.NEGATIVE_INFINITY) ||
    other.createdAt - one.createdAt ||
    (one.id < other.id ? -1 : one.id > other.id ? 1 : 0)
  );
}

const byText = (one: string, other: string): number => (one < other ? -1 : one > other ? 1 : 0);

export const memoryOperatorMerchants = (scope: MemoryScope): OperatorMerchants => ({
  async list(query: MerchantListQuery): Promise<MerchantList> {
    const holdings = scope.holdings();
    const search = searchOf(query);
    const also = new Set(query.alsoIds ?? []);
    const found = holdings.merchants
      .filter(
        (merchant) =>
          search === null ||
          also.has(merchant.id) ||
          [merchant.serviceName, merchant.sellerSite, merchant.id].some((text) =>
            text?.toLowerCase().includes(search),
          ),
      )
      .map((merchant) => factsOf(holdings, merchant, query.at, query.surface).row);
    const segments = Object.fromEntries([
      ["all", found.length],
      ...MERCHANT_SEGMENTS.map((segment) => [
        segment,
        found.filter((row) => row.segment === segment).length,
      ]),
    ]) as MerchantList["segments"];
    const inSegment =
      query.segment === undefined ? found : found.filter((row) => row.segment === query.segment);
    return {
      rows: [...inSegment].sort(listed).slice(0, merchantLimitOf(query)),
      total: inSegment.length,
      segments,
    };
  },

  async merchant(id, { at, surface }): Promise<MerchantRecord | null> {
    const holdings = scope.holdings();
    const merchant = holdings.merchants.find((one) => one.id === id);
    if (merchant === undefined) return null;
    const { row, wallet, cards, onSale, keys, inDays, orders, from } = factsOf(
      holdings,
      merchant,
      at,
      surface,
    );

    const days: SellingDay[] = [];
    for (let n = 0; n < SELLING_DAYS; n += 1) {
      const day = dayOf(from + n * DAY_MS);
      days.push({
        day,
        ...settledOf(inDays.filter((receipt) => dayOf(paidAtOf(receipt)) === day)),
      });
    }

    const worth = orders
      .filter(
        (record) =>
          paymentUnknown(record) ||
          (WORTH_A_LOOK_STATES as readonly string[]).includes(record.order.state),
      )
      .sort(
        (one, other) =>
          other.order.timestamps.createdAt - one.order.timestamps.createdAt ||
          byText(other.order.id, one.order.id),
      );
    const worthALook: OrderWorthALook[] = worth.slice(0, MERCHANT_PAGE_CUT.orders).map((record) => {
      const price = record.order.price ?? record.order.cardPrice;
      return {
        id: record.order.id,
        state: record.order.state,
        payment: record.order.payment,
        price: { amount: price.amount, currency: price.currency },
        createdAt: record.order.timestamps.createdAt,
        itemId: record.itemId,
        title: holdings.cards.find((card) => card.id === record.itemId)?.card.title ?? null,
      };
    });

    const cardRows: MerchantCard[] = [...cards]
      .sort((one, other) => byText(one.card.merchant_item_id, other.card.merchant_item_id))
      .slice(0, MERCHANT_PAGE_CUT.cards)
      .map((card) => ({
        id: card.id,
        card: card.card,
        publishedAt: card.asOf,
        paused: card.paused,
        integration: card.integration,
        onSale: onSale(card),
      }));

    const { keys: _keys, cards: _cards, thirtyDays, ...head } = row;
    return {
      ...head,
      selling: merchant.selling,
      liveApprovedAt: merchant.liveApprovedAt,
      wallet:
        wallet.address === null
          ? null
          : {
              address: wallet.address,
              split: wallet.split?.address ?? null,
              pending: wallet.pending === null ? null : { landsAt: wallet.pending.takesEffectAt },
            },
      keys: {
        rows: [...keys]
          .sort((one, other) => other.createdAt - one.createdAt || byText(other.id, one.id))
          .slice(0, MERCHANT_PAGE_CUT.keys)
          .map(({ id: keyId, label, createdAt, lastUsedAt, disabledAt }) => ({
            id: keyId,
            label,
            createdAt,
            lastUsedAt,
            disabledAt,
          })),
        total: keys.length,
      },
      cards: { rows: cardRows, total: cards.length, onSale: row.cards.onSale },
      thirtyDays: { ...thirtyDays, days },
      worthALook: { rows: worthALook, total: worth.length },
    };
  },
});

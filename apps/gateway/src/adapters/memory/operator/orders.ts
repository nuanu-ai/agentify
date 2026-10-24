/** The orders area's reads across merchants, in memory, over the store's holdings. */

import { payoutWalletAt } from "../../../app/runtime.js";
import { lookupOf } from "../../../ports/operator/lookup.js";
import {
  type Found,
  type OperatorOrders,
  ORDER_SEGMENTS,
  ORDERS_PAGE,
  type OrderMerchant,
  type OrdersCursor,
  type OrdersShown,
  segmentOf,
} from "../../../ports/operator/orders.js";
import {
  type OrderSeller,
  operatorOrderOf,
  orderRowOf,
} from "../../../ports/operator/orders-as-read.js";
import type { StoredMerchant, StoredOrder } from "../../../ports/store.js";
import type { MemoryHoldings } from "../store.js";
import type { MemoryScope } from "./index.js";

const sellerOf = (merchant: StoredMerchant): OrderSeller => ({
  id: merchant.id,
  name: merchant.name,
  serviceName: merchant.serviceName,
  sellerSite: merchant.sellerSite,
});

const merchantOf = ({ id, name, serviceName }: StoredMerchant): OrderMerchant => ({
  id,
  name,
  serviceName,
});

/** Every transaction an order's payment names: the one that paid it, and recovery's hint. */
const transactionsOf = (record: StoredOrder): string[] =>
  [
    record.settlement?.transaction,
    record.paymentAttempt?.transaction,
    record.paymentAttempt?.completion?.settled
      ? record.paymentAttempt.completion.transaction
      : undefined,
  ].filter((hash): hash is string => hash !== undefined);

/** Newest first, a tie in the moment broken by the identifier, as Postgres sorts them. */
const newestFirst = (one: StoredOrder, other: StoredOrder): number =>
  other.order.timestamps.createdAt - one.order.timestamps.createdAt ||
  (other.order.id < one.order.id ? -1 : other.order.id > one.order.id ? 1 : 0);

const before = (record: StoredOrder, cursor: OrdersCursor): boolean =>
  record.order.timestamps.createdAt < cursor.createdAt ||
  (record.order.timestamps.createdAt === cursor.createdAt && record.order.id < cursor.id);

const byId = <T extends { readonly id: string }>(one: T, other: T): number =>
  one.id < other.id ? -1 : one.id > other.id ? 1 : 0;

export const memoryOperatorOrders = (scope: MemoryScope): OperatorOrders => {
  const read = (): Holding => holdingOf(scope.holdings());

  return {
    async orders(query) {
      const held = read();
      const search = query.search?.trim().toLowerCase() ?? "";
      const matched = held.orders.filter(
        (record) =>
          (query.merchantId === undefined || record.merchantId === query.merchantId) &&
          (search === "" ||
            [
              record.order.id,
              held.titleOf(record) ?? "",
              record.merchantItemId,
              ...transactionsOf(record),
            ].some((field) => field.toLowerCase().includes(search))),
      );
      const counts = Object.fromEntries(
        [...ORDER_SEGMENTS, "all" as const].map((segment) => [
          segment,
          matched.filter((record) => shownIn(record, segment)).length,
        ]),
      ) as Record<OrdersShown, number>;
      const shown = matched.filter((record) => shownIn(record, query.shown)).sort(newestFirst);
      const cursor = query.before;
      const rest = cursor === undefined ? shown : shown.filter((record) => before(record, cursor));
      const page = rest.slice(0, ORDERS_PAGE);
      const last = page.at(-1);
      return {
        counts,
        rows: page.map((record) => held.rowOf(record)),
        newer: shown.length - rest.length,
        earlier:
          rest.length > ORDERS_PAGE && last !== undefined
            ? { createdAt: last.order.timestamps.createdAt, id: last.order.id }
            : null,
        merchants: held.merchants
          .filter((merchant) => held.orders.some((record) => record.merchantId === merchant.id))
          .map(merchantOf)
          .sort(byId),
      };
    },

    async order(id) {
      const held = read();
      const record = held.orders.find((one) => one.order.id === id);
      if (record === undefined) return null;
      const receipt = held.receipts.find((one) => one.receipt.order_id === id)?.receipt ?? null;
      return operatorOrderOf(
        record,
        sellerOf(held.merchant(record.merchantId)),
        held.titleOf(record),
        receipt,
      );
    },

    async find(text, at) {
      const held = read();
      const asked = lookupOf(text);
      const orders = (by: "id" | "transaction", records: readonly StoredOrder[]): Found[] =>
        records
          .map((record) => ({ kind: "order" as const, by, order: held.rowOf(record) }))
          .sort((one, other) => byId(one.order, other.order));
      const merchants = (
        by: "id" | "wallet" | "split" | "site",
        found: readonly StoredMerchant[],
      ): Found[] =>
        found
          .map((merchant) => ({ kind: "merchant" as const, by, merchant: merchantOf(merchant) }))
          .sort((one, other) => byId(one.merchant, other.merchant));
      switch (asked.kind) {
        case "order":
          return orders(
            "id",
            held.orders.filter((record) => record.order.id === asked.id),
          );
        case "merchant":
          return merchants(
            "id",
            held.merchants.filter((merchant) => merchant.id === asked.id),
          );
        case "transaction":
          return orders(
            "transaction",
            held.orders.filter((record) =>
              transactionsOf(record).some((hash) => hash.toLowerCase() === asked.hash),
            ),
          );
        case "address": {
          // A split is found only once a payment has gone to it.
          const split = held
            .splits(at)
            .filter(
              (one) =>
                one.address.toLowerCase() === asked.address &&
                held.orders.some(
                  (record) =>
                    record.merchantId === one.merchantId &&
                    record.payTo?.toLowerCase() === asked.address,
                ),
            );
          if (split.length > 0) {
            return merchants(
              "split",
              held.merchants.filter((merchant) =>
                split.some((one) => one.merchantId === merchant.id),
              ),
            );
          }
          return merchants(
            "wallet",
            held.merchants.filter(
              (merchant) =>
                payoutWalletAt(merchant.payoutWallet, at).address?.toLowerCase() ===
                  asked.address ||
                held
                  .splits(at)
                  .some(
                    (one) =>
                      one.merchantId === merchant.id &&
                      one.merchantWallet.toLowerCase() === asked.address,
                  ),
            ),
          );
        }
        case "site":
          return merchants(
            "site",
            held.merchants.filter(
              (merchant) => merchant.sellerSite?.toLowerCase() === asked.origin,
            ),
          );
        case "email":
        case "none":
          return [];
      }
    },
  };

  function holdingOf(holdings: MemoryHoldings): Holding {
    const merchant = (id: string): StoredMerchant => {
      const found = holdings.merchants.find((one) => one.id === id);
      if (found === undefined)
        throw new Error(`an order names the merchant ${id}, and there is no such merchant`);
      return found;
    };
    const titleOf = (record: StoredOrder): string | null =>
      holdings.cards.find((card) => card.id === record.itemId)?.card.title ?? null;
    return {
      orders: holdings.orders.map((one) => one.record),
      merchants: holdings.merchants,
      receipts: holdings.receipts,
      merchant,
      titleOf,
      rowOf: (record) =>
        orderRowOf(record, merchantOf(merchant(record.merchantId)), titleOf(record)),
      // The splits of this network whose merchant is still held, less any
      // waiting behind a wallet change that has not landed at `at`.
      splits: (at) =>
        holdings.splits.filter((split) => {
          if (split.network !== scope.network) return false;
          const owner = holdings.merchants.find((one) => one.id === split.merchantId);
          if (owner === undefined) return false;
          const waiting = owner.payoutWallet.pending;
          return !(
            waiting !== null &&
            waiting.takesEffectAt > at &&
            waiting.address.toLowerCase() === split.merchantWallet.toLowerCase()
          );
        }),
    };
  }
};

interface Holding {
  readonly orders: readonly StoredOrder[];
  readonly merchants: readonly StoredMerchant[];
  readonly receipts: MemoryHoldings["receipts"];
  merchant(id: string): StoredMerchant;
  titleOf(record: StoredOrder): string | null;
  rowOf(record: StoredOrder): ReturnType<typeof orderRowOf>;
  splits(at: number): MemoryHoldings["splits"];
}

const shownIn = (record: StoredOrder, shown: OrdersShown): boolean =>
  shown === "all" || segmentOf(record) === shown;

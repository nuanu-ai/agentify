/** The figures area's reads across merchants, in memory, over the store's holdings. */

import { silentAt } from "../../../app/gateway.js";
import {
  askedOn,
  CHART_DAYS,
  dayNumberOf,
  daysBackFrom,
  dayWritten,
  endOfDayOf,
  FUNNEL_STEPS,
  type FunnelStep,
  inCodeOrder,
  type OperatorFigures,
  PERIOD_DAYS,
  PREPAID_FULFILLMENT,
  RECENT_DAYS,
  SILENT_NAMED_AT_MOST,
  UNKNOWN_MERCHANTS_NAMED_AT_MOST,
  WAITING_NAMED_AT_MOST,
} from "../../../ports/operator/figures.js";
import { commissionOn, dollarsOf, microsOf, tallyOf } from "../../../ports/operator/money.js";
import { paymentUnknown } from "../../../ports/operator/orders.js";
import { lapsedAttempt } from "../../../ports/store.js";
import {
  namedAndPaid,
  onSale,
  priceOf,
  ready,
  type SettledSale,
  settledSales,
} from "./figures-standing.js";
import type { MemoryScope } from "./index.js";

const sum = (values: readonly bigint[]): bigint => values.reduce((all, one) => all + one, 0n);

const talliedSales = (sales: readonly SettledSale[]) =>
  tallyOf(sum(sales.map((sale) => sale.micros)), sales.length);

export const memoryOperatorFigures = (scope: MemoryScope): OperatorFigures => ({
  async waitingForAdmission(asked) {
    const { merchants, cards, contact } = scope.holdings();
    const waiting = askedOn(asked.surface).admission
      ? merchants
          .filter((merchant) => merchant.liveApprovedAt === null && namedAndPaid(merchant, asked))
          .sort((one, other) => one.createdAt - other.createdAt || inCodeOrder(one.id, other.id))
      : [];
    return {
      readAt: asked.at,
      of: waiting.length,
      merchants: waiting.slice(0, WAITING_NAMED_AT_MOST).map((merchant) => ({
        merchantId: merchant.id,
        name: merchant.name,
        serviceName: merchant.serviceName ?? "",
        sellerSite: merchant.sellerSite,
        createdAt: merchant.createdAt,
        integration: merchant.integration,
        lastContact: contact.get(merchant.id) ?? null,
        cardsPublished: cards.filter((card) => card.merchantId === merchant.id).length,
      })),
    };
  },

  async unknownPayments(asked) {
    const { merchants, orders } = scope.holdings();
    const unknown = orders.map(({ record }) => record).filter(paymentUnknown);
    const byMerchant = new Map<string, number>();
    for (const record of unknown) {
      byMerchant.set(record.merchantId, (byMerchant.get(record.merchantId) ?? 0) + 1);
    }
    const names = new Map(merchants.map((merchant) => [merchant.id, merchant.name]));
    const sent = unknown.map(
      (record) => record.order.timestamps.settleStartedAt ?? record.order.timestamps.createdAt,
    );
    return {
      readAt: asked.at,
      ...tallyOf(
        sum(
          unknown.map((record) => {
            const price = priceOf(record);
            return microsOf(price.amount, price.currency);
          }),
        ),
        unknown.length,
      ),
      oldestSince: sent.length === 0 ? null : Math.min(...sent),
      merchants: [...byMerchant]
        .sort(([one, many], [other, more]) => more - many || inCodeOrder(one, other))
        .slice(0, UNKNOWN_MERCHANTS_NAMED_AT_MOST)
        .map(([merchantId, count]) => ({ merchantId, name: names.get(merchantId) ?? "", count })),
      merchantsOf: byMerchant.size,
    };
  },

  async workers(asked) {
    const { merchants, cards, contact } = scope.holdings();
    const silent = merchants
      .filter(
        (merchant) =>
          merchant.selling === "open" &&
          merchant.integration === "api" &&
          ready(merchant, asked) &&
          silentAt(contact.get(merchant.id) ?? null, asked.at) &&
          cards.some(
            (card) =>
              card.merchantId === merchant.id &&
              !card.paused &&
              card.integration === "api" &&
              PREPAID_FULFILLMENT.includes(card.card.fulfillment ?? "sync"),
          ),
      )
      .map((merchant) => ({
        merchantId: merchant.id,
        name: merchant.name,
        since: contact.get(merchant.id) ?? null,
      }))
      .sort(
        (one, other) =>
          (one.since ?? Number.NEGATIVE_INFINITY) - (other.since ?? Number.NEGATIVE_INFINITY) ||
          inCodeOrder(one.merchantId, other.merchantId),
      );
    return {
      readAt: asked.at,
      connectedWithin: [...contact.values()].filter((polled) => !silentAt(polled, asked.at)).length,
      everConnected: contact.size,
      silent: silent.slice(0, SILENT_NAMED_AT_MOST),
      silentOf: silent.length,
    };
  },

  async analyticsOutbox(asked) {
    // Nothing in memory sends an event, so every one recorded waits.
    return {
      readAt: asked.at,
      waiting: scope.holdings().analytics.length,
      givenUp: 0,
      givenUpSince: null,
      refused: 0,
    };
  },

  async merchantCounts(asked) {
    const { merchants, cards } = scope.holdings();
    const byId = new Map(merchants.map((merchant) => [merchant.id, merchant]));
    const selling = new Set(
      cards
        .filter((card) => {
          const merchant = byId.get(card.merchantId);
          return merchant !== undefined && onSale(card, merchant, asked);
        })
        .map((card) => card.merchantId),
    );
    return {
      readAt: asked.at,
      total: merchants.length,
      selling: selling.size,
      admitted: merchants.filter((merchant) => merchant.liveApprovedAt !== null).length,
      waitingForAdmission: askedOn(asked.surface).admission
        ? merchants.filter(
            (merchant) => merchant.liveApprovedAt === null && namedAndPaid(merchant, asked),
          ).length
        : 0,
    };
  },

  async recentOrders(asked) {
    const from = daysBackFrom(asked.at, RECENT_DAYS);
    const until = endOfDayOf(asked.at);
    const recent = scope
      .holdings()
      .orders.map(({ record }) => record)
      .filter(
        (record) =>
          record.order.timestamps.createdAt >= from && record.order.timestamps.createdAt < until,
      );
    const kept = recent.filter((record) => !lapsedAttempt(record));
    return {
      readAt: asked.at,
      count: kept.length,
      delivered: kept.filter((record) => record.order.state === "delivered").length,
      paymentUnknown: kept.filter(paymentUnknown).length,
      lapsed: recent.length - kept.length,
    };
  },

  async money(asked, period) {
    const days = PERIOD_DAYS[period];
    const from = days === null ? null : daysBackFrom(asked.at, days);
    const until = endOfDayOf(asked.at);
    const settled = settledSales(scope.holdings(), scope.network);
    const sales = settled.filter(
      (sale) =>
        days === null ||
        (from !== null &&
          sale.settledAt !== null &&
          sale.settledAt >= from &&
          sale.settledAt < until),
    );
    const intoSplits = sales.filter((sale) => sale.split !== null);
    const bySplit = new Map<string, { split: NonNullable<SettledSale["split"]>; micros: bigint }>();
    for (const sale of intoSplits) {
      const split = sale.split as NonNullable<SettledSale["split"]>;
      const held = bySplit.get(split.address) ?? { split, micros: 0n };
      bySplit.set(split.address, { split, micros: held.micros + sale.micros });
    }
    const noDelivery = sales.filter((sale) => !sale.delivered);
    const byState = new Map<string, number>();
    for (const sale of noDelivery) {
      byState.set(sale.record.order.state, (byState.get(sale.record.order.state) ?? 0) + 1);
    }
    return {
      readAt: asked.at,
      period,
      from,
      sales: talliedSales(sales),
      undated: talliedSales(settled.filter((sale) => sale.settledAt === null)),
      commission: dollarsOf(
        sum([...bySplit.values()].map(({ split, micros }) => commissionOn(micros, split))),
      ),
      intoSplits: talliedSales(intoSplits),
      straightToWallet: talliedSales(sales.filter((sale) => sale.split === null)),
      noDelivery: talliedSales(noDelivery),
      noDeliveryByState: [...byState]
        .sort(([one], [other]) => inCodeOrder(one, other))
        .map(([state, count]) => ({ state, count })),
    };
  },

  async salesByDay(asked) {
    const first = dayNumberOf(daysBackFrom(asked.at, CHART_DAYS));
    const sales = settledSales(scope.holdings(), scope.network);
    return {
      readAt: asked.at,
      days: Array.from({ length: CHART_DAYS }, (_, index) => {
        const day = first + index;
        const onDay = sales.filter(
          (sale) => sale.settledAt !== null && dayNumberOf(sale.settledAt) === day,
        );
        return {
          day: dayWritten(day),
          delivered: talliedSales(onDay.filter((sale) => sale.delivered)),
          noDelivery: talliedSales(onDay.filter((sale) => !sale.delivered)),
        };
      }),
      undated: talliedSales(sales.filter((sale) => sale.settledAt === null)),
    };
  },

  async funnel(asked, shops) {
    const holdings = scope.holdings();
    const { merchants, keys, cards, contact } = holdings;
    const shop = new Set(shops.merchantIds);
    const withKey = new Set(keys.map((key) => key.merchantId));
    const sold = new Set(
      settledSales(holdings, scope.network).map((sale) => sale.record.merchantId),
    );
    const admission = askedOn(asked.surface).admission;
    const steps = FUNNEL_STEPS.filter((step) => admission || step !== "admitted");
    const took: Record<FunnelStep, (merchant: (typeof merchants)[number]) => boolean> = {
      created: () => true,
      seller_name: (merchant) => merchant.serviceName !== null,
      payout_wallet: (merchant) => merchant.payoutWallet.address !== null,
      key_or_shop: (merchant) => withKey.has(merchant.id) || shop.has(merchant.id),
      connected: (merchant) => contact.has(merchant.id) || shop.has(merchant.id),
      admitted: (merchant) => merchant.liveApprovedAt !== null,
      card_on_sale: (merchant) =>
        cards.some((card) => card.merchantId === merchant.id && onSale(card, merchant, asked)),
      first_sale: (merchant) => sold.has(merchant.id),
    };
    return {
      readAt: asked.at,
      steps: steps.map((step, index) => ({
        step,
        merchants: merchants.filter((merchant) =>
          steps.slice(0, index + 1).every((taken) => took[taken](merchant)),
        ).length,
      })),
    };
  },
});

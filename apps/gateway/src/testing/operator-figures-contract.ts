/**
 * What the operator's figures and splits promise, run over memory under
 * `pnpm test` and over Postgres as a db-test, so the overview, Money and
 * Health say the same of the same rows whichever reader draws them. Every row
 * is written through the store's own port, so both readers are handed the
 * same channel.
 *
 * What only Postgres can show stays in its own file: that a read which fails
 * throws instead of answering zero, and that sums are made in the database.
 */

import type { Order } from "@agentify/core";
import type { Card, Receipt } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import type { AnalyticsEvent } from "../analytics/events.js";
import type { FiguresAsked, OperatorFigures } from "../ports/operator/figures.js";
import type { OperatorSplits } from "../ports/operator/splits.js";
import type { PaymentAttempt, Store, StoredOrder } from "../ports/store.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "../split/networks.js";
import { payoutSplitFor } from "../split/parameters.js";
import { storeAcceptedOrder } from "./accepted-order.js";
import { anOrder } from "./store-contract.js";

/** The channel the stores are opened for. */
const NETWORK = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532");

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** The moment every read is made at: the afternoon of a UTC day, so "today" has a morning. */
const NOW = Date.parse("2026-10-23T14:05:00.000Z");
const TODAY = Date.parse("2026-10-23T00:00:00.000Z");

const LIVE: FiguresAsked = { at: NOW, surface: "live" };
const TEST: FiguresAsked = { at: NOW, surface: "test" };

const A = "mch_a";
const B = "mch_b";
const C = "mch_c";

/** Wallets in the checksummed spelling a write hands the store. */
const W1 = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const W2 = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const W3 = "0xde3F8C4422A7F8C94bce9Cc2Ec118665108148EF";

const splitOf = (merchantId: string, wallet: string) => payoutSplitFor(NETWORK, merchantId, wallet);

const aCard = (sku: string, fulfillment: "sync" | "async" = "sync"): Card => ({
  merchant_item_id: sku,
  title: "A seven day eSIM",
  description: "Seven days of data",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment,
  ...(fulfillment === "async" ? { fulfill_deadline_seconds: 3_600 } : {}),
});

interface Sale {
  readonly merchantId?: string;
  readonly amount?: string;
  readonly currency?: string;
  readonly state?: Order["state"];
  /** When the order says it was paid. */
  readonly paidAt?: number | null;
  /** The block time of a payment observed on the chain, which outranks every other word. */
  readonly onChainAt?: number;
  /** Where it was paid: a split's address, or a wallet before payments went to splits. */
  readonly payTo?: string | null;
  readonly payment?: Order["payment"];
  readonly createdAt?: number;
  readonly settleStartedAt?: number | null;
  readonly priced?: boolean;
}

/** An order whose payment stands as `sale.payment`, settled unless told otherwise. */
const aSale = (id: string, sale: Sale = {}): StoredOrder => {
  const base = anOrder(id, sale.state ?? "delivered", {
    merchantId: sale.merchantId ?? A,
    createdAt: sale.createdAt ?? sale.paidAt ?? NOW - HOUR,
  });
  const attempt: PaymentAttempt | undefined =
    sale.onChainAt === undefined
      ? undefined
      : {
          id: `att_${id}`,
          startedAt: sale.onChainAt,
          completion: {
            settled: true,
            transaction: `0x${"b".repeat(64)}`,
            executedAt: sale.onChainAt,
            source: "chain",
          },
        };
  return {
    ...base,
    order: {
      ...base.order,
      payment: sale.payment ?? "settled",
      price:
        sale.priced === false
          ? null
          : { amount: sale.amount ?? "10.00", currency: sale.currency ?? "USD", asOf: 0 },
      test: false,
      timestamps: {
        ...base.order.timestamps,
        paidAt: sale.paidAt === undefined ? NOW - HOUR : sale.paidAt,
        settleStartedAt: sale.settleStartedAt ?? null,
      },
    },
    payTo: sale.payTo === undefined ? splitOf(sale.merchantId ?? A, W1).address : sale.payTo,
    paidBy: "0x00000000000000000000000000000000000000aa",
    ...(attempt === undefined ? {} : { paymentAttempt: attempt }),
  };
};

const aReceipt = (orderId: string, paidAt: number): Receipt => ({
  id: `rcp_${orderId}`,
  order_id: orderId,
  item_id: "item_1",
  price: {
    amount: "10.00",
    currency: "USD",
    at: new Date(paidAt).toISOString(),
    as_of: new Date(paidAt).toISOString(),
  },
  paid_at: new Date(paidAt).toISOString(),
  outcome: "delivered",
  test: false,
});

const anEvent: AnalyticsEvent = {
  name: "agc_selling_changed",
  actor: "merchant_worker",
  source: "gateway",
  fields: { entity: "merchant", change: "paused" },
};

/** What a read leaves when the moment it was read at is set aside. */
const without = <T extends { readonly readAt: number }>(read: T): Omit<T, "readAt"> => {
  const { readAt: _, ...rest } = read;
  return rest;
};

/**
 * Runs the contract against what `open` returns: an empty store opened for
 * Base Sepolia, and the operator's reader over the same rows.
 */
export function describeOperatorFigures(
  name: string,
  open: () => Promise<{
    readonly store: Store;
    readonly reader: { readonly figures: OperatorFigures; readonly splits: OperatorSplits };
  }>,
): void {
  /** A merchant ready to sell on the live channel: named, paid at W1, admitted. */
  const ready = async (store: Store, id: string, at = NOW - 20 * DAY): Promise<void> => {
    await store.addMerchant({ id, name: `Merchant ${id}` }, at);
    await store.setServiceName(id, `Seller ${id}`, at);
    await store.setPayoutWallet(
      id,
      { address: null, pending: null },
      { address: W1, split: splitOf(id, W1), pending: null },
      at,
    );
    await store.grantLiveApproval(id, at);
  };

  describe(name, () => {
    describe("on an empty channel", () => {
      it("reads zeros, each carrying the moment it was read", async () => {
        // A zero drawn here says "there are none", which is only true because
        // the read succeeded; a page reading it must be able to tell.
        const { reader } = await open();
        const { figures, splits } = reader;

        expect(await figures.waitingForAdmission(LIVE)).toStrictEqual({
          readAt: NOW,
          merchants: [],
          of: 0,
        });
        expect(await figures.unknownPayments(LIVE)).toStrictEqual({
          readAt: NOW,
          amount: "0.00",
          count: 0,
          oldestSince: null,
          merchants: [],
          merchantsOf: 0,
        });
        expect(await figures.workers(LIVE)).toStrictEqual({
          readAt: NOW,
          connectedWithin: 0,
          everConnected: 0,
          silent: [],
          silentOf: 0,
        });
        expect(await figures.analyticsOutbox(LIVE)).toStrictEqual({
          readAt: NOW,
          waiting: 0,
          givenUp: 0,
          givenUpSince: null,
          refused: 0,
        });
        expect(await figures.merchantCounts(LIVE)).toStrictEqual({
          readAt: NOW,
          total: 0,
          selling: 0,
          admitted: 0,
          waitingForAdmission: 0,
        });
        expect(await figures.recentOrders(LIVE)).toStrictEqual({
          readAt: NOW,
          count: 0,
          delivered: 0,
          paymentUnknown: 0,
        });
        const nothing = { amount: "0.00", count: 0 };
        expect(await figures.money(LIVE, "all")).toStrictEqual({
          readAt: NOW,
          period: "all",
          from: null,
          sales: nothing,
          undated: nothing,
          commission: "0.00",
          intoSplits: nothing,
          straightToWallet: nothing,
          noDelivery: nothing,
          noDeliveryByState: [],
        });
        const chart = await figures.salesByDay(LIVE);
        expect(chart.readAt).toBe(NOW);
        expect(chart.days).toHaveLength(30);
        expect(chart.undated).toStrictEqual(nothing);
        expect(chart.days.every((day) => day.delivered.count + day.noDelivery.count === 0)).toBe(
          true,
        );
        expect(await figures.funnel(LIVE, { merchantIds: [] })).toStrictEqual({
          readAt: NOW,
          steps: [
            { step: "created", merchants: 0 },
            { step: "seller_name", merchants: 0 },
            { step: "payout_wallet", merchants: 0 },
            { step: "key_or_shop", merchants: 0 },
            { step: "connected", merchants: 0 },
            { step: "admitted", merchants: 0 },
            { step: "card_on_sale", merchants: 0 },
            { step: "first_sale", merchants: 0 },
          ],
        });
        expect(await splits.splits(LIVE)).toStrictEqual({
          readAt: NOW,
          rows: [],
          of: 0,
          empty: 0,
          waiting: 0,
        });
      });
    });

    describe("settled sales", () => {
      it("count every order whose payment settled, whatever became of its goods, and nothing else", async () => {
        // An unfulfilled order's money is in the merchant's split like any
        // other's; an order still settling, unanswered or refused is not a sale.
        const { store, reader } = await open();
        await ready(store, A);
        await storeAcceptedOrder(store, aSale("ord_delivered", { amount: "10.00" }));
        await storeAcceptedOrder(
          store,
          aSale("ord_unfulfilled", { amount: "2.50", state: "unfulfilled" }),
        );
        await storeAcceptedOrder(
          store,
          aSale("ord_closed", { amount: "1.25", state: "fulfillment_closed" }),
        );
        await storeAcceptedOrder(
          store,
          aSale("ord_settling", { payment: "settling", state: "paid" }),
        );
        await storeAcceptedOrder(
          store,
          aSale("ord_unknown", { payment: "outcome_unknown", state: "dispatched" }),
        );
        await storeAcceptedOrder(
          store,
          aSale("ord_failed", { payment: "settle_failed", state: "rejected" }),
        );

        const money = await reader.figures.money(LIVE, "7d");

        expect(money.sales).toStrictEqual({ amount: "13.75", count: 3 });
        expect(money.noDelivery).toStrictEqual({ amount: "3.75", count: 2 });
        expect(money.noDeliveryByState).toStrictEqual([
          { state: "fulfillment_closed", count: 1 },
          { state: "unfulfilled", count: 1 },
        ]);
      });

      it("count a payment whose outcome is unknown apart, with its amount and its age, never as a sale", async () => {
        const { store, reader } = await open();
        await ready(store, A);
        await ready(store, B);
        await storeAcceptedOrder(
          store,
          aSale("ord_u1", {
            payment: "outcome_unknown",
            state: "dispatched",
            amount: "4.00",
            settleStartedAt: NOW - 3 * HOUR,
          }),
        );
        await storeAcceptedOrder(
          store,
          aSale("ord_u2", {
            payment: "settling",
            state: "paid",
            amount: "6.00",
            settleStartedAt: NOW - HOUR,
          }),
        );
        await storeAcceptedOrder(
          store,
          aSale("ord_u3", {
            merchantId: B,
            payment: "outcome_unknown",
            state: "dispatched",
            amount: "1.00",
            settleStartedAt: NOW - 2 * HOUR,
          }),
        );

        expect(without(await reader.figures.unknownPayments(LIVE))).toStrictEqual({
          amount: "11.00",
          count: 3,
          oldestSince: NOW - 3 * HOUR,
          merchants: [
            { merchantId: A, name: "Merchant mch_a", count: 2 },
            { merchantId: B, name: "Merchant mch_b", count: 1 },
          ],
          merchantsOf: 2,
        });
        expect((await reader.figures.money(LIVE, "all")).sales.count).toBe(0);
      });

      it("are dated by the moment the order records them as paid, and a block's time outranks it", async () => {
        // A payment recovered from the chain is dated by its block, which may
        // be days before the order learned of it. A receipt written later,
        // when goods paid for after delivery were handed over, does not move
        // the day: the order's own word is the one every screen reads.
        const { store, reader } = await open();
        await ready(store, A);
        await storeAcceptedOrder(
          store,
          aSale("ord_chain", { paidAt: NOW - HOUR, onChainAt: TODAY - 10 * DAY + HOUR }),
        );
        await storeAcceptedOrder(store, aSale("ord_receipt", { paidAt: TODAY - 3 * DAY + HOUR }));
        await store.putReceipt(A, aReceipt("ord_receipt", TODAY - DAY + HOUR));
        await storeAcceptedOrder(store, aSale("ord_order", { paidAt: TODAY - DAY + HOUR }));

        const days = (await reader.figures.salesByDay(LIVE)).days;
        const counted = Object.fromEntries(
          days
            .filter((day) => day.delivered.count > 0)
            .map((day) => [day.day, day.delivered.count]),
        );

        expect(counted).toStrictEqual({ "2026-10-13": 1, "2026-10-20": 1, "2026-10-22": 1 });
      });

      it("with no moment recorded are counted in all time and apart, and in no day or period", async () => {
        const { store, reader } = await open();
        await ready(store, A);
        await storeAcceptedOrder(store, aSale("ord_dated", { amount: "1.00" }));
        await storeAcceptedOrder(store, aSale("ord_undated", { amount: "2.00", paidAt: null }));

        const ever = await reader.figures.money(LIVE, "all");
        const week = await reader.figures.money(LIVE, "7d");
        const chart = await reader.figures.salesByDay(LIVE);

        expect(ever.sales).toStrictEqual({ amount: "3.00", count: 2 });
        expect(ever.undated).toStrictEqual({ amount: "2.00", count: 1 });
        expect(week.sales).toStrictEqual({ amount: "1.00", count: 1 });
        expect(week.undated).toStrictEqual({ amount: "2.00", count: 1 });
        expect(chart.undated).toStrictEqual({ amount: "2.00", count: 1 });
        expect(chart.days.reduce((all, day) => all + day.delivered.count, 0)).toBe(1);
      });

      it("fail the read when one carries an amount that is not in dollars, rather than adding it in", async () => {
        const { store, reader } = await open();
        await ready(store, A);
        await storeAcceptedOrder(store, aSale("ord_dollars", { amount: "10.00" }));
        await storeAcceptedOrder(store, aSale("ord_euros", { amount: "10.00", currency: "EUR" }));

        await expect(reader.figures.money(LIVE, "all")).rejects.toThrow(/EUR/);
        await expect(reader.figures.salesByDay(LIVE)).rejects.toThrow(/EUR/);
      });

      it("fail the read when one carries no price, rather than counting it as nothing", async () => {
        const { store, reader } = await open();
        await ready(store, A);
        await storeAcceptedOrder(store, aSale("ord_unpriced", { priced: false }));

        await expect(reader.figures.money(LIVE, "all")).rejects.toThrow(/ord_unpriced/);
      });
    });

    describe("the periods", () => {
      it("are today and the days before it, in UTC, so a period and its bars add to one number", async () => {
        const { store, reader } = await open();
        await ready(store, A, NOW - 60 * DAY);
        await storeAcceptedOrder(
          store,
          aSale("ord_today", { paidAt: TODAY + HOUR, amount: "1.00" }),
        );
        await storeAcceptedOrder(
          store,
          aSale("ord_d6", { paidAt: TODAY - 6 * DAY, amount: "2.00" }),
        );
        await storeAcceptedOrder(
          store,
          aSale("ord_d7", { paidAt: TODAY - 7 * DAY + HOUR, amount: "4.00" }),
        );
        await storeAcceptedOrder(
          store,
          aSale("ord_d29", { paidAt: TODAY - 29 * DAY, amount: "8.00" }),
        );
        await storeAcceptedOrder(
          store,
          aSale("ord_d30", { paidAt: TODAY - 30 * DAY + HOUR, amount: "16.00" }),
        );

        const week = await reader.figures.money(LIVE, "7d");
        const month = await reader.figures.money(LIVE, "30d");
        const ever = await reader.figures.money(LIVE, "all");
        const chart = await reader.figures.salesByDay(LIVE);

        expect(week.from).toBe(TODAY - 6 * DAY);
        expect(week.sales).toStrictEqual({ amount: "3.00", count: 2 });
        expect(month.from).toBe(TODAY - 29 * DAY);
        expect(month.sales).toStrictEqual({ amount: "15.00", count: 4 });
        expect(ever.sales).toStrictEqual({ amount: "31.00", count: 5 });
        expect(chart.days[0]?.day).toBe("2026-09-24");
        expect(chart.days[29]?.day).toBe("2026-10-23");
        expect(chart.days.reduce((all, day) => all + day.delivered.count, 0)).toBe(
          month.sales.count,
        );
      });
    });

    describe("the commission", () => {
      it("accrues only on payments into a split, and payments straight to a wallet are counted apart", async () => {
        // Before payments went to splits a live payment went to the merchant's
        // wallet, and nothing of it was ever Agentify's.
        const { store, reader } = await open();
        await ready(store, A);
        await storeAcceptedOrder(store, aSale("ord_split", { amount: "100.00" }));
        await storeAcceptedOrder(store, aSale("ord_split_2", { amount: "18.50" }));
        await storeAcceptedOrder(store, aSale("ord_wallet", { amount: "353.00", payTo: W1 }));

        const money = await reader.figures.money(LIVE, "all");

        expect(money.sales).toStrictEqual({ amount: "471.50", count: 3 });
        expect(money.intoSplits).toStrictEqual({ amount: "118.50", count: 2 });
        expect(money.straightToWallet).toStrictEqual({ amount: "353.00", count: 1 });
        expect(money.commission).toBe("0.1185");
      });

      it("is rounded down to the millionth, as the split rounds it", async () => {
        const { store, reader } = await open();
        await ready(store, A);
        await storeAcceptedOrder(store, aSale("ord_tiny", { amount: "0.000999" }));

        expect((await reader.figures.money(LIVE, "all")).commission).toBe("0.00");
      });

      it("matches a split whichever spelling the order wrote its address in", async () => {
        const { store, reader } = await open();
        await ready(store, A);
        await storeAcceptedOrder(
          store,
          aSale("ord_lower", { amount: "10.00", payTo: splitOf(A, W1).address.toLowerCase() }),
        );

        expect((await reader.figures.money(LIVE, "all")).intoSplits.count).toBe(1);
      });
    });

    describe("the splits", () => {
      it("are one row each, and an old split keeps what settled into it after its merchant moved wallets", async () => {
        const { store, reader } = await open();
        await ready(store, A);
        await storeAcceptedOrder(store, aSale("ord_old", { amount: "20.00" }));
        await store.setPayoutWallet(
          A,
          { address: W1, pending: null },
          { address: W2, split: splitOf(A, W2), pending: null },
          NOW - DAY,
        );
        await storeAcceptedOrder(
          store,
          aSale("ord_new", { amount: "5.00", payTo: splitOf(A, W2).address }),
        );

        const read = await reader.splits.splits(LIVE);

        expect(read.of).toBe(2);
        expect(read.empty).toBe(0);
        expect(
          read.rows.map((row) => ({
            address: row.address,
            wallet: row.merchantWallet,
            inForce: row.inForce,
            settled: row.settled,
            name: row.merchantName,
          })),
        ).toStrictEqual([
          {
            address: splitOf(A, W1).address,
            wallet: W1,
            inForce: false,
            settled: { amount: "20.00", count: 1 },
            name: "Merchant mch_a",
          },
          {
            address: splitOf(A, W2).address,
            wallet: W2,
            inForce: true,
            settled: { amount: "5.00", count: 1 },
            name: "Merchant mch_a",
          },
        ]);
      });

      it("leave out a split waiting behind a wallet change, and count it", async () => {
        // Nothing hands out the address of a wallet that has not taken effect:
        // whoever moved it may not be the merchant.
        const { store, reader } = await open();
        await ready(store, A);
        await store.setPayoutWallet(
          A,
          { address: W1, pending: null },
          {
            address: W1,
            split: splitOf(A, W1),
            pending: { address: W3, takesEffectAt: NOW + DAY, split: splitOf(A, W3) },
          },
          NOW - HOUR,
        );

        const read = await reader.splits.splits(LIVE);

        expect(read.rows.map((row) => row.merchantWallet)).toStrictEqual([W1]);
        expect(read.waiting).toBe(1);
        expect(JSON.stringify(read)).not.toContain(splitOf(A, W3).address);
      });

      it("leave out a split waiting behind a wallet change though another merchant's order names its address", async () => {
        // Only the split's own merchant can have been asked to pay into it;
        // an order of anyone else's naming that address does not make it hold money.
        const { store, reader } = await open();
        await ready(store, A);
        await ready(store, B);
        await store.setPayoutWallet(
          A,
          { address: W1, pending: null },
          {
            address: W1,
            split: splitOf(A, W1),
            pending: { address: W3, takesEffectAt: NOW + DAY, split: splitOf(A, W3) },
          },
          NOW - HOUR,
        );
        await storeAcceptedOrder(
          store,
          aSale("ord_other", { merchantId: B, amount: "5.00", payTo: splitOf(A, W3).address }),
        );

        const read = await reader.splits.splits(LIVE);

        expect(read.waiting).toBe(1);
        expect(read.rows.map((row) => row.address)).not.toContain(splitOf(A, W3).address);
      });

      it("list a split that holds nothing, and count it as empty", async () => {
        const { store, reader } = await open();
        await ready(store, A);

        const read = await reader.splits.splits(LIVE);

        expect(read.rows.map((row) => row.settled)).toStrictEqual([{ amount: "0.00", count: 0 }]);
        expect(read.empty).toBe(1);
      });
    });

    describe("the merchants", () => {
      it("waiting for admission are those with a seller name and a wallet, not admitted, the longest waiting first", async () => {
        const { store, reader } = await open();
        await store.addMerchant({ id: A, name: "Example Roasters" }, NOW - 5 * DAY);
        await store.setServiceName(A, "Example Roasters", NOW - 5 * DAY);
        await store.setPayoutWallet(
          A,
          { address: null, pending: null },
          { address: W1, split: splitOf(A, W1), pending: null },
          NOW - 5 * DAY,
        );
        await store.publishCard(A, aCard("sku-1"), NOW - 4 * DAY);
        await store.noteContact(A, NOW - 3 * 60_000);
        await store.addMerchant({ id: B, name: "Only named" }, NOW - 9 * DAY);
        await store.setServiceName(B, "Only named", NOW - 9 * DAY);
        await ready(store, C);

        for (const [id, createdAt] of [
          ["mch_z", NOW - 6 * DAY],
          ["mch_y", NOW - 6 * DAY],
          ["mch_d", NOW - 2 * DAY],
        ] as const) {
          await store.addMerchant({ id, name: id }, createdAt);
          await store.setServiceName(id, id, createdAt);
          await store.setPayoutWallet(
            id,
            { address: null, pending: null },
            { address: W1, split: splitOf(id, W1), pending: null },
            createdAt,
          );
        }
        const read = await reader.figures.waitingForAdmission(LIVE);
        expect(read.merchants.map((merchant) => merchant.merchantId)).toStrictEqual([
          "mch_y",
          "mch_z",
          A,
          "mch_d",
        ]);

        expect(without(read)).toStrictEqual({
          of: 4,
          merchants: [
            expect.objectContaining({ merchantId: "mch_y", createdAt: NOW - 6 * DAY }),
            expect.objectContaining({ merchantId: "mch_z", createdAt: NOW - 6 * DAY }),
            {
              merchantId: A,
              name: "Example Roasters",
              serviceName: "Example Roasters",
              sellerSite: null,
              createdAt: NOW - 5 * DAY,
              integration: "api",
              lastContact: NOW - 3 * 60_000,
              cardsPublished: 1,
            },
            expect.objectContaining({ merchantId: "mch_d", createdAt: NOW - 2 * DAY }),
          ],
        });
        expect((await reader.figures.merchantCounts(LIVE)).waitingForAdmission).toBe(4);
      });

      it("wait for nobody on a channel that admits nobody", async () => {
        const { store, reader } = await open();
        await store.addMerchant({ id: A, name: "Merchant" }, NOW - DAY);
        await store.setServiceName(A, "Seller", NOW - DAY);
        await store.setPayoutWallet(
          A,
          { address: null, pending: null },
          { address: W1, split: splitOf(A, W1), pending: null },
          NOW - DAY,
        );

        expect((await reader.figures.waitingForAdmission(TEST)).of).toBe(0);
        expect((await reader.figures.merchantCounts(TEST)).waitingForAdmission).toBe(0);
      });

      it("selling are those with a card on sale now, which the live channel holds to admission", async () => {
        const { store, reader } = await open();
        await ready(store, A);
        await store.publishCard(A, aCard("sku-1"), NOW - DAY);
        // Named and paid, never admitted: on sale on the test channel only.
        await store.addMerchant({ id: B, name: "B" }, NOW - DAY);
        await store.setServiceName(B, "B", NOW - DAY);
        await store.setPayoutWallet(
          B,
          { address: null, pending: null },
          { address: W2, split: splitOf(B, W2), pending: null },
          NOW - DAY,
        );
        await store.publishCard(B, aCard("sku-1"), NOW - DAY);
        // Ready, with its only card paused.
        await ready(store, C);
        const paused = await store.publishCard(C, aCard("sku-1"), NOW - DAY);
        await store.setCardPaused(C, paused.id, true);

        expect(without(await reader.figures.merchantCounts(LIVE))).toStrictEqual({
          total: 3,
          selling: 1,
          admitted: 2,
          waitingForAdmission: 1,
        });
        expect((await reader.figures.merchantCounts(TEST)).selling).toBe(2);
      });

      it("whose process went silent while any card of theirs is on sale are named, and polls within the window are counted", async () => {
        const { store, reader } = await open();
        await ready(store, A);
        await store.publishCard(A, aCard("sku-1", "async"), NOW - DAY);
        await store.noteContact(A, NOW - 11 * 60_000);
        // Silent too, with only a card paid after its goods, which the
        // catalogue leaves out all the same.
        await ready(store, B);
        await store.publishCard(B, aCard("sku-1", "sync"), NOW - DAY);
        await store.noteContact(B, NOW - HOUR);
        await ready(store, C);
        await store.publishCard(C, aCard("sku-1", "async"), NOW - DAY);
        await store.noteContact(C, NOW - 60_000);

        expect(without(await reader.figures.workers(LIVE))).toStrictEqual({
          connectedWithin: 1,
          everConnected: 3,
          silent: [
            { merchantId: B, name: "Merchant mch_b", since: NOW - HOUR },
            { merchantId: A, name: "Merchant mch_a", since: NOW - 11 * 60_000 },
          ],
          silentOf: 2,
        });
      });
    });

    describe("the orders of the last seven days", () => {
      it("count accepted expired orders alongside delivered and unknown payments", async () => {
        const { store, reader } = await open();
        await ready(store, A);
        await storeAcceptedOrder(store, aSale("ord_delivered", { createdAt: NOW - 2 * DAY }));
        await storeAcceptedOrder(
          store,
          aSale("ord_unknown", {
            createdAt: NOW - DAY,
            payment: "outcome_unknown",
            state: "dispatched",
          }),
        );
        await storeAcceptedOrder(
          store,
          aSale("ord_expired", {
            state: "expired",
            payment: "verified",
            paidAt: null,
            createdAt: NOW - DAY,
          }),
        );
        await storeAcceptedOrder(store, aSale("ord_old", { createdAt: TODAY - 7 * DAY }));

        expect(without(await reader.figures.recentOrders(LIVE))).toStrictEqual({
          count: 3,
          delivered: 1,
          paymentUnknown: 1,
        });
      });
    });

    describe("the funnel", () => {
      it("counts at each step only the merchants who took every step before it", async () => {
        const { store, reader } = await open();
        // Took every step, and sold.
        await ready(store, A);
        await store.addKey({ id: "key_a", merchantId: A, label: "k", digest: "d".repeat(64) }, NOW);
        await store.noteContact(A, NOW - 60_000);
        await store.publishCard(A, aCard("sku-1"), NOW - DAY);
        await storeAcceptedOrder(store, aSale("ord_a"));
        // Connected a shop, which only the dashboard knows, and was admitted.
        await ready(store, B);
        // A key and nothing else: stops at the first step.
        await store.addMerchant({ id: C, name: "C" }, NOW);
        await store.addKey({ id: "key_c", merchantId: C, label: "k", digest: "e".repeat(64) }, NOW);

        const steps = (await reader.figures.funnel(LIVE, { merchantIds: [B] })).steps;

        expect(steps).toStrictEqual([
          { step: "created", merchants: 3 },
          { step: "seller_name", merchants: 2 },
          { step: "payout_wallet", merchants: 2 },
          { step: "key_or_shop", merchants: 2 },
          { step: "connected", merchants: 2 },
          { step: "admitted", merchants: 2 },
          { step: "card_on_sale", merchants: 1 },
          { step: "first_sale", merchants: 1 },
        ]);
        expect(
          (await reader.figures.funnel(TEST, { merchantIds: [B] })).steps.map((each) => each.step),
        ).not.toContain("admitted");
      });
    });

    describe("the analytics outbox", () => {
      it("counts an event just recorded as waiting", async () => {
        const { store, reader } = await open();
        await store.recordAnalytics(anEvent, NOW - 60_000);

        expect((await reader.figures.analyticsOutbox(LIVE)).waiting).toBe(1);
      });
    });
  });
}

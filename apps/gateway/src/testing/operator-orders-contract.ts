/**
 * The promises of the operator's orders reads, run against memory under
 * `pnpm test` and against Postgres under `pnpm test:db`, so the two readers
 * cannot drift apart: the same rows written through the store must read back
 * as the same list, the same order and the same lookup.
 *
 * A read that fails is each reader's own case: memory cannot fail, and the
 * Postgres one is held in its database test.
 */

import type { Order } from "@agentify/core";
import type { Card, Receipt } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import {
  type Found,
  type OperatorOrders,
  ORDER_SEGMENTS,
  type OrdersShown,
} from "../ports/operator/orders.js";
import type { Store, StoredCard, StoredOrder } from "../ports/store.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "../split/networks.js";
import { payoutSplitFor } from "../split/parameters.js";
import { anOrder } from "./store-contract.js";

export interface OrdersUnderTest {
  /** The store the rows are written through; empty, opened for Base Sepolia. */
  readonly store: Store;
  /** The reader over that store's rows. */
  readonly orders: OperatorOrders;
}

const SEPOLIA = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532");

const A = "mch_a";
const B = "mch_b";
/** A merchant with no orders, selling from the same site as A. */
const C = "mch_c";

/** Wallets in the checksummed spelling a merchant gives them. */
const W1 = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const W2 = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const W3 = "0xde3F8C4422A7F8C94bce9Cc2Ec118665108148EF";
/** The wallet that signed a buyer's payment, which no read may hand out. */
const PAYER = "0x52908400098527886E0F7030069857D2E4169EE7";

const SPLIT_A1 = payoutSplitFor(SEPOLIA, A, W1);
const SPLIT_A2 = payoutSplitFor(SEPOLIA, A, W2);
const SPLIT_B = payoutSplitFor(SEPOLIA, B, W3);

/** When A's change of wallet from W1 to W2 lands. */
const LANDS = 5_000_000;
/** A moment of reading before it lands. */
const NOW = 4_000_000;

const PAID_TX = `0x${"ab".repeat(32)}`;
const HINT_TX = `0x${"cd".repeat(32)}`;

/** Things the orders hold that no operator's read may carry, in any field. */
const SECRET_PARAM = "a value the buyer typed";
const SECRET_GOODS = "https://goods.example/a-download-only-the-buyer-holds";
const SECRET_STREET = "Jl. Raya Kediri, Beraban";
const SECRET_PAYMENT = "the payment the agent presented";

const t = (step: number): number => 1_000_000 + step * 1_000;

const card = (merchantItemId: string, title: string): Card => ({
  merchant_item_id: merchantItemId,
  title,
  description: "a product",
  price: { amount: "8.00", currency: "USD" },
  result: { access_url: { type: "string" } },
  fulfillment: "sync",
});

/** An order of `card` made at `at`, with whatever else the case needs. */
function sold(
  id: string,
  state: Order["state"],
  item: StoredCard,
  at: number,
  change: {
    readonly order?: Partial<Order>;
    readonly timestamps?: Partial<Order["timestamps"]>;
    readonly record?: Partial<StoredOrder>;
    readonly priced?: boolean;
  } = {},
): StoredOrder {
  const base = anOrder(id, state, {
    merchantId: item.merchantId,
    createdAt: at,
    buyerKey: `bk_secret_${id}`,
  });
  const priced = change.priced ?? true;
  return {
    ...base,
    itemId: item.id,
    merchantItemId: item.card.merchant_item_id,
    ...change.record,
    order: {
      ...base.order,
      ...(priced
        ? {
            price: { amount: "8.00", currency: "USD", asOf: at },
            quoteSource: "card_snapshot" as const,
          }
        : {}),
      ...change.order,
      timestamps: {
        ...base.order.timestamps,
        ...(priced ? { quotedAt: at + 1 } : {}),
        ...change.timestamps,
      },
    },
  };
}

const ON_PURCHASE = { mode: { settle: "on_purchase" } } as const;
const PARCEL = { mode: { settle: "on_purchase", parcel: true } } as const;

const RECEIPT: Receipt = {
  id: "rcp_delivered",
  order_id: "ord_delivered",
  item_id: "set below",
  price: {
    amount: "8.00",
    currency: "USD",
    at: "2026-10-23T10:00:00.000Z",
    as_of: "2026-10-23T10:00:00.000Z",
  },
  paid_at: "2026-10-23T10:00:05.000Z",
  outcome: "delivered",
  transaction: PAID_TX,
  test: true,
};

/**
 * A channel of three merchants and eleven orders, at least one in every
 * segment and several on its edges. Its counts, by segment:
 * payment unknown 2, unfulfilled 1, delivered not paid 1, in progress 2,
 * ended 4, lapsed 1, all 11.
 */
async function aChannel(store: Store): Promise<{ readonly eu: StoredCard }> {
  const none = { address: null, pending: null };
  await store.addMerchant({ id: A, name: "Merchant A" }, 1);
  await store.addMerchant({ id: B, name: "Merchant B" }, 2);
  await store.addMerchant({ id: C, name: "Merchant C" }, 3);
  await store.setServiceName(A, "Seller A", 4);
  await store.setSellerSite(A, "https://shop.example", 5);
  await store.setSellerSite(B, "https://other.example", 5);
  await store.setSellerSite(C, "https://shop.example", 5);
  await store.setPayoutWallet(
    A,
    none,
    {
      address: W1,
      split: SPLIT_A1,
      pending: { address: W2, takesEffectAt: LANDS, split: SPLIT_A2 },
    },
    6,
  );
  await store.setPayoutWallet(B, none, { address: W3, split: SPLIT_B, pending: null }, 6);
  const eu = await store.publishCard(A, card("esim-eu", "eSIM Europe"), 7);
  const vpn = await store.publishCard(B, card("vpn-month", "VPN for a month"), 7);

  const orders: StoredOrder[] = [
    sold("ord_lapsed", "rejected", eu, t(1), {
      priced: false,
      order: { closure: { cause: "unavailable" } },
    }),
    sold("ord_failed", "failed", vpn, t(2), {
      order: { closure: { cause: "merchant_refused", code: "out_of_stock", message: "Sold out" } },
    }),
    sold("ord_delivered", "delivered", eu, t(3), {
      order: { payment: "settled", dispatch: { attempts: 1, accepted: false } },
      timestamps: { paidAt: t(3) + 2, dispatchedAt: t(3) + 3, settleStartedAt: t(3) + 4 },
      record: {
        params: { note: SECRET_PARAM },
        delivery: { access_url: SECRET_GOODS },
        payment: SECRET_PAYMENT,
        payTo: SPLIT_A1.address,
        paidBy: PAYER,
        paymentRecovery: {
          kind: "evm-exact-eip3009",
          network: "eip155:84532",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payer: PAYER,
          payTo: SPLIT_A1.address,
          amount: "8000000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${"01".repeat(32)}`,
          notBefore: "0",
        },
        paymentAttempt: {
          id: "pat_1",
          startedAt: t(3) + 4,
          completion: {
            settled: true,
            transaction: PAID_TX,
            executedAt: t(3) + 5,
            source: "facilitator",
          },
        },
        settlement: { transaction: PAID_TX },
        paymentWords: [
          { at: t(3) + 1, about: "verify", said: `valid, signed by ${PAYER}` },
          { at: t(3) + 6, about: "settle", said: `success in ${PAID_TX}` },
        ],
        paymentWordsDropped: 3,
      },
    }),
    sold("ord_closed", "fulfillment_closed", eu, t(4), {
      order: {
        ...ON_PURCHASE,
        payment: "settled",
        dispatch: { attempts: 2, accepted: false },
        closure: { cause: "deadline_expired", deadline: "async_fulfillment" },
        merchantClosure: { at: t(4) + 9, message: "We sent the money back." },
      },
      timestamps: { settleStartedAt: t(4) + 2, paidAt: t(4) + 3, dispatchedAt: t(4) + 4 },
      record: { payTo: SPLIT_A1.address, paidBy: PAYER },
    }),
    sold("ord_unfulfilled", "unfulfilled", eu, t(5), {
      order: { ...ON_PURCHASE, payment: "settled" },
      timestamps: { settleStartedAt: t(5) + 2, paidAt: t(5) + 3 },
      record: { payTo: SPLIT_A1.address, paidBy: PAYER },
    }),
    sold("ord_unpaid", "delivered_unpaid", vpn, t(6), {
      order: { payment: "settle_failed" },
      record: { delivery: { access_url: SECRET_GOODS }, paidBy: PAYER },
    }),
    sold("ord_progress", "quoted", vpn, t(7)),
    sold("ord_settling", "paid", eu, t(8), {
      order: { ...ON_PURCHASE, payment: "settling" },
      timestamps: { settleStartedAt: t(8) + 2 },
      record: { payTo: SPLIT_A1.address, paidBy: PAYER },
    }),
    sold("ord_unknown", "rejected", eu, t(9), {
      order: {
        ...ON_PURCHASE,
        payment: "outcome_unknown",
        closure: { cause: "payment_outcome_unknown" },
      },
      timestamps: { settleStartedAt: t(9) + 2 },
      record: {
        payTo: SPLIT_A1.address,
        paidBy: PAYER,
        paymentAttempt: {
          id: "pat_2",
          startedAt: t(9) + 2,
          transaction: HINT_TX,
          nextBlock: "0x10",
          completion: null,
        },
      },
    }),
    sold("ord_parcel", "delivered", vpn, t(10), {
      order: { ...PARCEL, payment: "settled", dispatch: { attempts: 1, accepted: true } },
      timestamps: { settleStartedAt: t(10) + 2, paidAt: t(10) + 3, dispatchedAt: t(10) + 4 },
      record: {
        shipTo: { erasedAt: t(10) + 5 },
        delivery: {
          carrier: "The shop's own courier",
          tracking_number: null,
          shipped_at: new Date(t(10) + 6).toISOString(),
        },
        payTo: SPLIT_B.address,
        paidBy: PAYER,
      },
    }),
    sold("ord_held", "quoted", eu, t(11), {
      order: PARCEL,
      record: {
        params: { size: SECRET_PARAM },
        shipTo: {
          name: "The buyer",
          line_one: SECRET_STREET,
          city: "Tabanan",
          country: "ID",
          phone_number: "+62 000 0000 0000",
        },
      },
    }),
  ];
  for (const order of orders) await store.addOrder(order);
  await store.putReceipt(A, { ...RECEIPT, item_id: eu.id });
  return { eu };
}

const ZERO: Readonly<Record<OrdersShown, number>> = {
  payment_unknown: 0,
  unfulfilled: 0,
  delivered_unpaid: 0,
  in_progress: 0,
  ended: 0,
  lapsed: 0,
  all: 0,
};

const idsOf = (rows: readonly { readonly id: string }[]): string[] => rows.map((row) => row.id);

/** What a lookup found, as kind, what matched and the record's identifier. */
const namedBy = (found: readonly Found[]): string[] =>
  found.map((one) =>
    one.kind === "order"
      ? `order ${one.by} ${one.order.id}`
      : `merchant ${one.by} ${one.merchant.id}`,
  );

export function describeOperatorOrders(name: string, open: () => Promise<OrdersUnderTest>): void {
  describe(name, () => {
    describe("the orders list", () => {
      it("on an empty channel counts zero in every segment from a read that succeeded", async () => {
        const { orders } = await open();

        expect(await orders.orders({ shown: "all" })).toStrictEqual({
          counts: ZERO,
          rows: [],
          newer: 0,
          earlier: null,
          merchants: [],
        });
      });

      it("puts every order in exactly one segment, and counts all as their sum", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        const page = await orders.orders({ shown: "all" });

        expect(page.counts).toStrictEqual({
          payment_unknown: 2,
          unfulfilled: 1,
          delivered_unpaid: 1,
          in_progress: 2,
          ended: 4,
          lapsed: 1,
          all: 11,
        });
        expect(ORDER_SEGMENTS.reduce((sum, segment) => sum + page.counts[segment], 0)).toBe(11);
      });

      it("lists each segment's orders and no other, newest first", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        const listed = async (shown: OrdersShown) => idsOf((await orders.orders({ shown })).rows);

        expect(await listed("payment_unknown")).toStrictEqual(["ord_unknown", "ord_settling"]);
        expect(await listed("unfulfilled")).toStrictEqual(["ord_unfulfilled"]);
        expect(await listed("delivered_unpaid")).toStrictEqual(["ord_unpaid"]);
        expect(await listed("in_progress")).toStrictEqual(["ord_held", "ord_progress"]);
        expect(await listed("ended")).toStrictEqual([
          "ord_parcel",
          "ord_closed",
          "ord_delivered",
          "ord_failed",
        ]);
        expect(await listed("lapsed")).toStrictEqual(["ord_lapsed"]);
        expect((await listed("all")).length).toBe(11);
      });

      it("names on a row the facts the list draws", async () => {
        const { store, orders } = await open();
        const { eu } = await aChannel(store);

        const { rows } = await orders.orders({ shown: "ended" });

        expect(rows.find((row) => row.id === "ord_delivered")).toStrictEqual({
          id: "ord_delivered",
          createdAt: t(3),
          pricedAt: t(3) + 1,
          merchant: { id: A, name: "Merchant A", serviceName: "Seller A" },
          product: { itemId: eu.id, merchantItemId: "esim-eu", title: "eSIM Europe" },
          price: { amount: "8.00", currency: "USD" },
          status: "delivered",
          payment: "paid",
          segment: "ended",
          test: true,
        });
        const lapsed = (await orders.orders({ shown: "lapsed" })).rows[0];
        expect(lapsed).toMatchObject({
          pricedAt: null,
          price: null,
          status: "rejected",
          payment: "not_paid",
        });
        const unknown = (await orders.orders({ shown: "payment_unknown" })).rows[0];
        expect(unknown).toMatchObject({ status: "payment_unresolved", payment: "unresolved" });
      });

      it("offers the merchants that have orders to filter by, and no other", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        expect((await orders.orders({ shown: "all" })).merchants).toStrictEqual([
          { id: A, name: "Merchant A", serviceName: "Seller A" },
          { id: B, name: "Merchant B", serviceName: null },
        ]);
      });

      it("filtered by a merchant, lists and counts that merchant's orders alone", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        const theirs = await orders.orders({ shown: "all", merchantId: B });

        expect(theirs.counts).toStrictEqual({
          ...ZERO,
          delivered_unpaid: 1,
          in_progress: 1,
          ended: 2,
          all: 4,
        });
        expect(idsOf(theirs.rows)).toStrictEqual([
          "ord_parcel",
          "ord_progress",
          "ord_unpaid",
          "ord_failed",
        ]);
        expect(await orders.orders({ shown: "all", merchantId: "mch_nobody" })).toMatchObject({
          counts: ZERO,
          rows: [],
        });
      });

      it("searches the order identifier, the product's title and identifier, and the transaction, ignoring case", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        const found = async (search: string) =>
          idsOf((await orders.orders({ shown: "all", search })).rows);

        expect(await found("  ORD_DELIVERED ")).toStrictEqual(["ord_delivered"]);
        expect((await found("europe")).length).toBe(7);
        expect(await found("VPN-MONTH")).toStrictEqual([
          "ord_parcel",
          "ord_progress",
          "ord_unpaid",
          "ord_failed",
        ]);
        expect(await found(PAID_TX.toUpperCase().replace("0X", "0x"))).toStrictEqual([
          "ord_delivered",
        ]);
        expect(await found(HINT_TX.slice(0, 20))).toStrictEqual(["ord_unknown"]);
        expect(await found("   ")).toHaveLength(11);
      });

      it("counts a search that matches nothing as zero in every segment", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        expect(await orders.orders({ shown: "all", search: "no such thing" })).toMatchObject({
          counts: ZERO,
          rows: [],
          earlier: null,
        });
      });

      it("never matches what it does not show, such as a buyer's key or the values they entered", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        for (const search of ["bk_secret_", SECRET_PARAM, SECRET_STREET, PAYER]) {
          expect((await orders.orders({ shown: "all", search })).counts.all).toBe(0);
        }
      });

      it("is cut at fifty with the total, and leads to the earlier ones from where the cut fell", async () => {
        const { store, orders } = await open();
        await store.addMerchant({ id: A, name: "Merchant A" }, 1);
        const eu = await store.publishCard(A, card("esim-eu", "eSIM Europe"), 2);
        for (let step = 1; step <= 53; step += 1) {
          const id = `ord_p${String(step).padStart(2, "0")}`;
          // The cut falls between two orders made in the same millisecond.
          await store.addOrder(sold(id, "quoted", eu, t(step === 3 ? 4 : step)));
        }

        const first = await orders.orders({ shown: "in_progress" });

        expect(first.counts.in_progress).toBe(53);
        expect(first.rows).toHaveLength(50);
        expect(first.rows[0]?.id).toBe("ord_p53");
        expect(first.rows[49]?.id).toBe("ord_p04");
        expect(first.newer).toBe(0);
        expect(first.earlier).toStrictEqual({ createdAt: t(4), id: "ord_p04" });

        const second = await orders.orders({
          shown: "in_progress",
          before: first.earlier ?? undefined,
        });

        expect(idsOf(second.rows)).toStrictEqual(["ord_p03", "ord_p02", "ord_p01"]);
        expect(second.newer).toBe(50);
        expect(second.earlier).toBeNull();
        expect(second.counts.in_progress).toBe(53);
      });

      it("ends a page that holds exactly the last orders with no way to earlier ones", async () => {
        const { store, orders } = await open();
        await store.addMerchant({ id: A, name: "Merchant A" }, 1);
        const eu = await store.publishCard(A, card("esim-eu", "eSIM Europe"), 2);
        for (let step = 1; step <= 50; step += 1) {
          await store.addOrder(
            sold(`ord_q${String(step).padStart(2, "0")}`, "quoted", eu, t(step)),
          );
        }

        const page = await orders.orders({ shown: "all" });

        expect(page.rows).toHaveLength(50);
        expect(page.earlier).toBeNull();
      });
    });

    describe("one order", () => {
      it("is null where the channel holds no such order", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        expect(await orders.order("ord_nothing")).toBeNull();
      });

      it("reads as the agent and the merchant read it, with its payment and its receipt", async () => {
        const { store, orders } = await open();
        const { eu } = await aChannel(store);

        const read = await orders.order("ord_delivered");

        expect(read).toMatchObject({
          id: "ord_delivered",
          state: "delivered",
          fulfillment: "sync",
          quoteSource: "card_snapshot",
          merchant: { id: A, name: "Merchant A", serviceName: "Seller A" },
          product: { itemId: eu.id, merchantItemId: "esim-eu", title: "eSIM Europe" },
          agent: {
            status: "delivered",
            payment_status: "paid",
            transaction: PAID_TX,
            seller: { name: "Seller A", site: "https://shop.example" },
          },
          merchantReads: {
            status: "delivered",
            payment_status: "paid",
            onOpenList: false,
            lapsed: false,
          },
          receipt: { ...RECEIPT, item_id: eu.id },
          withheld: { buyerEntered: true, address: null, goods: true },
        });
        expect(read?.paid).toStrictEqual({
          stage: "settled",
          status: "paid",
          paidInto: SPLIT_A1.address,
          transaction: PAID_TX,
          attempt: {
            startedAt: t(3) + 4,
            completion: { settled: true, executedAt: t(3) + 5, source: "facilitator" },
            searchHint: null,
            nextBlock: null,
          },
          words: [
            { at: t(3) + 1, about: "verify", said: "valid, signed by a wallet" },
            { at: t(3) + 6, about: "settle", said: `success in ${PAID_TX}` },
          ],
          wordsDropped: 3,
          unknownSince: null,
        });
      });

      it("tells its story by the moments the record keeps, and places a step it keeps no time for after what it follows", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        const delivered = await orders.order("ord_delivered");
        expect(delivered?.timeline.map((step) => [step.kind, step.at])).toStrictEqual([
          ["created", t(3)],
          ["priced", t(3) + 1],
          ["facilitator_said", t(3) + 1],
          ["paid", t(3) + 2],
          ["handed_over", t(3) + 3],
          ["goods_delivered", null],
          ["charge_sent", t(3) + 4],
          ["payment_completed", t(3) + 5],
          ["facilitator_said", t(3) + 6],
        ]);

        const closed = await orders.order("ord_closed");
        expect(closed?.timeline).toStrictEqual([
          { kind: "created", at: t(4) },
          { kind: "priced", at: t(4) + 1, price: { amount: "8.00", currency: "USD" } },
          { kind: "charge_sent", at: t(4) + 2 },
          { kind: "paid", at: t(4) + 3 },
          { kind: "handed_over", at: t(4) + 4, times: 2, takenOn: false },
          {
            kind: "ended",
            at: null,
            closure: { cause: "deadline_expired", deadline: "async_fulfillment" },
          },
          { kind: "closed_by_merchant", at: t(4) + 9, withMessage: true },
        ]);
        expect(closed?.agent).toMatchObject({
          status: "fulfillment_closed",
          payment_status: "paid",
          reason: { code: "merchant_closed" },
          merchant_closure: { message: "We sent the money back." },
        });
      });

      it("says since when a payment's outcome is unknown and what recovery holds, as the agent's unresolved", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        const read = await orders.order("ord_unknown");

        expect(read).toMatchObject({
          segment: "payment_unknown",
          agent: { status: "payment_unresolved", payment_status: "unresolved" },
          paid: {
            stage: "outcome_unknown",
            transaction: null,
            unknownSince: t(9) + 2,
            attempt: { completion: null, searchHint: HINT_TX, nextBlock: "0x10" },
          },
        });
      });

      it("says of a parcel when its shipment was recorded and its address erased, never the address", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        const parcel = await orders.order("ord_parcel");
        expect(parcel).toMatchObject({
          status: "shipped",
          fulfillment: "ship",
          withheld: { buyerEntered: false, address: { erasedAt: t(10) + 5 }, goods: false },
        });
        expect(parcel?.timeline.map((step) => step.kind).slice(-2)).toStrictEqual([
          "address_erased",
          "shipment_recorded",
        ]);
        expect(parcel?.timeline.at(-1)?.at).toBe(t(10) + 6);

        const held = await orders.order("ord_held");
        expect(held?.withheld).toStrictEqual({ buyerEntered: true, address: "held", goods: false });
      });

      it("hands out no buyer's key, address, entered value, goods, payment or payer's wallet", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        for (const id of ["ord_delivered", "ord_held", "ord_unpaid", "ord_parcel", "ord_unknown"]) {
          const read = JSON.stringify(await orders.order(id)).toLowerCase();
          for (const secret of [
            "bk_secret_",
            "status_url",
            SECRET_PARAM,
            SECRET_GOODS,
            SECRET_STREET,
            SECRET_PAYMENT,
            PAYER,
          ]) {
            expect(read).not.toContain(secret.toLowerCase());
          }
        }
      });
    });

    describe("the lookup", () => {
      it("goes from an order's identifier to that order, and finds none for one the channel lacks", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        expect(namedBy(await orders.find(" ord_delivered ", NOW))).toStrictEqual([
          "order id ord_delivered",
        ]);
        expect(await orders.find("ord_nothing", NOW)).toStrictEqual([]);
      });

      it("goes from a merchant's identifier to that merchant", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        expect(await orders.find(B, NOW)).toStrictEqual([
          {
            kind: "merchant",
            by: "id",
            merchant: { id: B, name: "Merchant B", serviceName: null },
          },
        ]);
        expect(await orders.find("mch_nobody", NOW)).toStrictEqual([]);
      });

      it("goes from a transaction, in either case, to the order its payment names", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        const found = await orders.find(`0x${PAID_TX.slice(2).toUpperCase()}`, NOW);
        expect(namedBy(found)).toStrictEqual(["order transaction ord_delivered"]);
        expect(found[0]?.kind === "order" && found[0].order.status).toBe("delivered");
        expect(namedBy(await orders.find(HINT_TX, NOW))).toStrictEqual([
          "order transaction ord_unknown",
        ]);
        expect(await orders.find(`0x${"ef".repeat(32)}`, NOW)).toStrictEqual([]);
      });

      it("goes from a wallet in force or its split to the merchant, and never to a split waiting behind a change", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        expect(namedBy(await orders.find(W1.toLowerCase(), NOW))).toStrictEqual([
          "merchant wallet mch_a",
        ]);
        expect(namedBy(await orders.find(SPLIT_A1.address, NOW))).toStrictEqual([
          "merchant split mch_a",
        ]);
        expect(await orders.find(SPLIT_A2.address, NOW)).toStrictEqual([]);
        expect(await orders.find(W2, NOW)).toStrictEqual([]);
        expect(await orders.find(PAYER, NOW)).toStrictEqual([]);
      });

      it("once a change has landed, goes from the new wallet and its split, and still from the old wallet", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        expect(namedBy(await orders.find(W2, LANDS))).toStrictEqual(["merchant wallet mch_a"]);
        expect(namedBy(await orders.find(SPLIT_A2.address, LANDS))).toStrictEqual([
          "merchant split mch_a",
        ]);
        expect(namedBy(await orders.find(W1, LANDS))).toStrictEqual(["merchant wallet mch_a"]);
      });

      it("goes from a site, written any way, to every merchant selling from it", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        expect(namedBy(await orders.find("SHOP.example/products/esim?x=1", NOW))).toStrictEqual([
          "merchant site mch_a",
          "merchant site mch_c",
        ]);
        expect(namedBy(await orders.find("https://other.example", NOW))).toStrictEqual([
          "merchant site mch_b",
        ]);
        expect(await orders.find("nowhere.example", NOW)).toStrictEqual([]);
      });

      it("finds nothing for an email address, a blank or a word that names no record", async () => {
        const { store, orders } = await open();
        await aChannel(store);

        for (const text of ["buyer@shop.example", "", "   ", "freeland", "0x1234"]) {
          expect(await orders.find(text, NOW)).toStrictEqual([]);
        }
      });
    });
  });
}

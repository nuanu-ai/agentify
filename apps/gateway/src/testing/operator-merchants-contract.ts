/**
 * What the operator's reads of merchants promise, run against the memory
 * reader in `pnpm test` and against the Postgres one as a database test, over
 * the same rows written through the store, so the two cannot drift apart: the
 * list's segments, counts, order, search and cut; and one merchant's page.
 *
 * Every zero asserted here comes from a read that succeeded and found nothing.
 */

import type { Order, SurfaceMode } from "@agentify/core";
import type { Card, Receipt } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import type {
  MerchantList,
  MerchantRecord,
  OperatorMerchants,
} from "../ports/operator/merchants.js";
import type { Store, StoredOrder } from "../ports/store.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "../split/networks.js";
import { payoutSplitFor } from "../split/parameters.js";
import { storeAcceptedOrder } from "./accepted-order.js";
import { anOrder } from "./store-contract.js";

/** What a case is handed: an empty store opened for Base Sepolia, and the reader over it. */
export interface OperatorMerchantsUnderTest {
  readonly store: Store;
  readonly merchants: OperatorMerchants;
}

const NETWORK = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532");

/** 23 Oct 2026, 14:05 UTC: the instant every read is asked as of. */
const AT = Date.UTC(2026, 9, 23, 14, 5);
const DAY = 86_400_000;
/** Midnight UTC twenty-nine days before `AT`'s day: the first instant of its thirty days. */
const FROM = Date.UTC(2026, 8, 24);

const W1 = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const W2 = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

const NO_WALLET = { address: null, split: null, pending: null } as const;

const card = (merchantItemId: string, title: string): Card => ({
  merchant_item_id: merchantItemId,
  title,
  description: "a product",
  price: { amount: "5.00", currency: "USD" },
  result: { access_url: { type: "string" } },
  fulfillment: "sync",
});

interface Setup {
  readonly name?: string;
  readonly site?: string;
  readonly wallet?: string;
  readonly admitted?: boolean;
  readonly cards?: number;
}

/** A merchant made through the store's own writes, as the dashboard and the gateway make them. */
async function merchant(store: Store, id: string, createdAt: number, setup: Setup = {}) {
  await store.addMerchant({ id, name: "made in the dashboard" }, createdAt);
  if (setup.name !== undefined) await store.setServiceName(id, setup.name, createdAt);
  if (setup.site !== undefined) await store.setSellerSite(id, setup.site, createdAt);
  if (setup.wallet !== undefined) {
    const written = await store.setPayoutWallet(
      id,
      NO_WALLET,
      { address: setup.wallet, split: payoutSplitFor(NETWORK, id, setup.wallet), pending: null },
      createdAt,
    );
    expect(typeof written).toBe("object");
  }
  if (setup.admitted === true) await store.grantLiveApproval(id, createdAt);
  const published: string[] = [];
  for (let n = 1; n <= (setup.cards ?? 0); n += 1) {
    published.push((await store.publishCard(id, card(`sku-${n}`, `Card ${n}`), createdAt)).id);
  }
  return published;
}

const SELLS = { name: "A seller", wallet: W1, admitted: true, cards: 1 } as const;

/** An order of `merchantId`, made at `createdAt`, with its own changes to the machine's order. */
const order = (
  id: string,
  merchantId: string,
  createdAt: number,
  state: Order["state"],
  change: Partial<Order> = {},
  rest: Partial<StoredOrder> = {},
): StoredOrder => {
  const made = anOrder(id, state, { merchantId, createdAt });
  return {
    ...made,
    paidBy: "0x00000000000000000000000000000000000000aa",
    ...rest,
    order: { ...made.order, payment: state === "delivered" ? "settled" : "verified", ...change },
  };
};

/**
 * A settled sale of `merchantId`'s: an order whose payment settled, priced
 * `amount` dollars, paid at `paidAt` (or with no moment recorded), in `state`,
 * and seen on the chain at `executedAt` where given. Made long before the
 * thirty days, so it counts as a sale there and not as an order.
 */
const sale = (
  id: string,
  merchantId: string,
  paidAt: number | null,
  amount: string,
  { state = "delivered", executedAt }: { state?: Order["state"]; executedAt?: number } = {},
): StoredOrder => {
  const made = anOrder(id, state, { merchantId, createdAt: 1_000 });
  return {
    ...made,
    paidBy: "0x00000000000000000000000000000000000000aa",
    ...(executedAt === undefined
      ? {}
      : {
          paymentAttempt: {
            id: `pa_${id}`,
            startedAt: 1_000,
            completion: { settled: true, transaction: `0x${id}`, executedAt, source: "chain" },
          },
        }),
    order: {
      ...made.order,
      payment: "settled",
      price: { amount, currency: "USD", asOf: 1_000 },
      timestamps: { ...made.order.timestamps, paidAt },
    },
  };
};

/** A receipt for an order that holds no settled payment, which makes no sale by itself. */
const receiptAlone = (orderId: string, paidAt: number): Receipt => ({
  id: `rcp_${orderId}`,
  order_id: orderId,
  item_id: "item_1",
  price: {
    amount: "7.00",
    currency: "USD",
    at: new Date(paidAt).toISOString(),
    as_of: new Date(paidAt).toISOString(),
  },
  paid_at: new Date(paidAt).toISOString(),
  outcome: "delivered",
  test: true,
});

const NO_SALES = { amount: "0.00", count: 0 } as const;

const LIVE = { at: AT, surface: "live" } as const satisfies { at: number; surface: SurfaceMode };

export function describeOperatorMerchants(
  name: string,
  open: () => Promise<OperatorMerchantsUnderTest>,
): void {
  describe(name, () => {
    describe("the list", () => {
      /**
       * One merchant for every way of standing, on the live channel:
       * two waiting (one with a card, one with none), one selling, two paused
       * (their sales, and every card), and three setting up (a name only,
       * nothing missing and no card, cards only of an integration left).
       */
      const everyStanding = async () => {
        const under = await open();
        const { store } = under;
        await merchant(store, "mch_waits", 1_000, { name: "Waits", wallet: W1, cards: 1 });
        await merchant(store, "mch_waits_bare", 2_000, { name: "Waits bare", wallet: W2 });
        await merchant(store, "mch_sells", 3_000, SELLS);
        await merchant(store, "mch_paused", 4_000, SELLS);
        await store.setSelling("mch_paused", "paused");
        const [only] = await merchant(store, "mch_cards_paused", 5_000, SELLS);
        await store.setCardPaused("mch_cards_paused", only ?? "", true);
        await merchant(store, "mch_named", 6_000, { name: "Named" });
        await merchant(store, "mch_empty", 7_000, { ...SELLS, cards: 0 });
        await merchant(store, "mch_switched", 8_000, SELLS);
        const switched = await store.switchIntegration("mch_switched", "woocommerce");
        expect(switched.switched).toBe(true);
        return under;
      };

      it("puts every merchant in one segment by what the live channel asks, and counts each", async () => {
        const { merchants } = await everyStanding();

        const list = await merchants.list({ ...LIVE, limit: 50 });

        expect(list.segments).toStrictEqual({
          all: 8,
          waiting: 2,
          selling: 1,
          paused: 2,
          setting_up: 3,
        });
        const segment = Object.fromEntries(list.rows.map((row) => [row.id, row.segment]));
        expect(segment).toStrictEqual({
          mch_waits: "waiting",
          mch_waits_bare: "waiting",
          mch_sells: "selling",
          mch_paused: "paused",
          mch_cards_paused: "paused",
          mch_named: "setting_up",
          mch_empty: "setting_up",
          mch_switched: "setting_up",
        });
        const missing = Object.fromEntries(list.rows.map((row) => [row.id, row.missing]));
        expect(missing.mch_waits).toStrictEqual(["no_operator_approval"]);
        expect(missing.mch_named).toStrictEqual(["no_payout_wallet", "no_operator_approval"]);
        expect(missing.mch_sells).toStrictEqual([]);
      });

      it("asks no admission on the test channel, where nobody waits for one", async () => {
        const { merchants } = await everyStanding();

        const list = await merchants.list({ at: AT, surface: "test", limit: 50 });

        expect(list.segments.waiting).toBe(0);
        const byId = new Map(list.rows.map((row) => [row.id, row]));
        expect(byId.get("mch_waits")?.segment).toBe("selling");
        expect(byId.get("mch_waits")?.missing).toStrictEqual([]);
        expect(byId.get("mch_waits_bare")?.segment).toBe("setting_up");
        expect(byId.get("mch_named")?.missing).toStrictEqual(["no_payout_wallet"]);
      });

      it("narrows to one segment and cuts it, saying how many there are in all", async () => {
        const { merchants } = await everyStanding();

        const setting = await merchants.list({ ...LIVE, segment: "setting_up", limit: 2 });

        expect(setting.total).toBe(3);
        expect(setting.rows).toHaveLength(2);
        expect(setting.rows.every((row) => row.segment === "setting_up")).toBe(true);
        expect(setting.segments.all).toBe(8);
        expect((await merchants.list({ ...LIVE, limit: 0 })).rows).toHaveLength(1);
      });

      it("lists first who waits for the operator, then by the latest sale, then the newest merchant", async () => {
        const under = await open();
        const { store, merchants } = under;
        await merchant(store, "mch_old_sale", 1_000, SELLS);
        await merchant(store, "mch_new_sale", 2_000, SELLS);
        await merchant(store, "mch_never_old", 3_000, SELLS);
        await merchant(store, "mch_never_new", 4_000, SELLS);
        await merchant(store, "mch_waits", 500, { name: "Waits", wallet: W1 });
        await storeAcceptedOrder(store, sale("ord_old", "mch_old_sale", AT - 40 * DAY, "1.00"));
        await storeAcceptedOrder(store, sale("ord_new", "mch_new_sale", AT - DAY, "1.00"));

        const list = await merchants.list({ ...LIVE, limit: 50 });

        expect(list.rows.map((row) => row.id)).toStrictEqual([
          "mch_waits",
          "mch_new_sale",
          "mch_old_sale",
          "mch_never_new",
          "mch_never_old",
        ]);
      });

      it("reads on past a merchant's place and back to the merchants nearest before it, in the same order", async () => {
        const under = await open();
        const { store, merchants } = under;
        await merchant(store, "mch_old_sale", 1_000, SELLS);
        await merchant(store, "mch_new_sale", 2_000, SELLS);
        await merchant(store, "mch_never", 3_000, SELLS);
        await storeAcceptedOrder(store, sale("ord_old", "mch_old_sale", AT - 40 * DAY, "1.00"));
        await storeAcceptedOrder(store, sale("ord_new", "mch_new_sale", AT - DAY, "1.00"));
        const ids = (list: MerchantList) => list.rows.map((row) => row.id);
        const nowhere = { waiting: false, lastSaleAt: null, createdAt: 0, id: "" };

        const first = await merchants.list({ ...LIVE, limit: 2 });
        expect(ids(first)).toStrictEqual(["mch_new_sale", "mch_old_sale"]);
        expect(first).toMatchObject({ total: 3, newer: 0, previous: null });
        expect(first.next).toMatchObject({ waiting: false, createdAt: 1_000, id: "mch_old_sale" });
        const second = await merchants.list({
          ...LIVE,
          limit: 2,
          from: { after: first.next ?? nowhere },
        });
        expect(ids(second)).toStrictEqual(["mch_never"]);
        expect(second).toMatchObject({ total: 3, newer: 2, next: null });
        expect(second.previous).toStrictEqual({
          waiting: false,
          lastSaleAt: null,
          createdAt: 3_000,
          id: "mch_never",
        });
        const back = await merchants.list({
          ...LIVE,
          limit: 2,
          from: { before: second.previous ?? nowhere },
        });
        expect(ids(back)).toStrictEqual(ids(first));
        expect(back).toMatchObject({ newer: 0, previous: null, next: first.next });
      });

      it("places a cursor naming a merchant who is not listed where what they were sorted by falls", async () => {
        const under = await open();
        const { store, merchants } = under;
        await merchant(store, "mch_old_sale", 1_000, SELLS);
        await merchant(store, "mch_never_old", 2_000, SELLS);
        await merchant(store, "mch_never_new", 4_000, SELLS);
        await storeAcceptedOrder(store, sale("ord_old", "mch_old_sale", AT - 40 * DAY, "1.00"));
        const ids = (list: MerchantList) => list.rows.map((row) => row.id);
        const gone = { waiting: false, lastSaleAt: null, createdAt: 3_000, id: "mch_gone" };

        const older = await merchants.list({ ...LIVE, limit: 50, from: { after: gone } });
        const newer = await merchants.list({ ...LIVE, limit: 50, from: { before: gone } });

        expect(ids(older)).toStrictEqual(["mch_never_old"]);
        expect(older).toMatchObject({ total: 3, newer: 2, next: null });
        expect(ids(newer)).toStrictEqual(["mch_old_sale", "mch_never_new"]);
        expect(newer).toMatchObject({ newer: 0, previous: null });
        expect(newer.next).toMatchObject({ id: "mch_never_new" });
      });

      it("finds a merchant by seller name, site or identifier ignoring case, and by identifiers the caller found", async () => {
        const under = await open();
        const { store, merchants } = under;
        await merchant(store, "mch_coffee", 1_000, { name: "Coffee Roasters" });
        await merchant(store, "mch_tours", 2_000, { site: "https://tours.example" });
        await merchant(store, "mch_unnamed", 3_000);
        const found = async (search: string, alsoIds?: readonly string[]) =>
          (
            await merchants.list({ ...LIVE, search, limit: 50, ...(alsoIds ? { alsoIds } : {}) })
          ).rows
            .map((row) => row.id)
            .sort();

        expect(await found("coffee")).toStrictEqual(["mch_coffee"]);
        expect(await found("  TOURS.EX ")).toStrictEqual(["mch_tours"]);
        expect(await found("mch_unn")).toStrictEqual(["mch_unnamed"]);
        expect(await found("coffee", ["mch_unnamed"])).toStrictEqual(["mch_coffee", "mch_unnamed"]);
        expect(await found("   ")).toStrictEqual(["mch_coffee", "mch_tours", "mch_unnamed"]);
        expect(await found("50%_")).toStrictEqual([]);
      });

      it("answers a search that finds nobody with zeros, not a failure", async () => {
        const under = await open();
        await merchant(under.store, "mch_coffee", 1_000, { name: "Coffee Roasters" });

        const list = await under.merchants.list({ ...LIVE, search: "nobody", limit: 50 });

        expect(list).toStrictEqual({
          rows: [],
          total: 0,
          newer: 0,
          previous: null,
          next: null,
          segments: { all: 0, waiting: 0, selling: 0, paused: 0, setting_up: 0 },
        });
      });

      it("answers an empty channel with zeros", async () => {
        const { merchants } = await open();

        expect(await merchants.list({ ...LIVE, limit: 50 })).toStrictEqual({
          rows: [],
          total: 0,
          newer: 0,
          previous: null,
          next: null,
          segments: { all: 0, waiting: 0, selling: 0, paused: 0, setting_up: 0 },
        });
      });

      it("draws each row's keys, contact, cards and thirty days from that merchant's records alone", async () => {
        const under = await open();
        const { store, merchants } = under;
        const [first] = await merchant(store, "mch_a", 1_000, { ...SELLS, cards: 3 });
        await store.setCardPaused("mch_a", first ?? "", true);
        await merchant(store, "mch_b", 2_000, SELLS);
        // mch_b tried a shop, whose connector polled for it, and came back to
        // code that never ran.
        await store.switchIntegration("mch_b", "woocommerce");
        await store.noteContact("mch_b", AT - 20_000, "woocommerce");
        await store.switchIntegration("mch_b", "api");
        await store.addKey({ id: "mk_1", merchantId: "mch_a", label: "one", digest: "d1" }, 1_000);
        await store.addKey({ id: "mk_2", merchantId: "mch_a", label: "two", digest: "d2" }, 1_000);
        await store.addKey({ id: "mk_b", merchantId: "mch_b", label: "b", digest: "d3" }, 1_000);
        await store.disableKeyOf("mch_a", "mk_2", 1_500);
        await store.noteContact("mch_a", AT - 20_000, "api");
        await storeAcceptedOrder(
          store,
          order("ord_in", "mch_a", FROM, "delivered_unpaid", { payment: "settle_failed" }),
        );
        await storeAcceptedOrder(store, order("ord_before", "mch_a", FROM - 1, "delivered"));
        await storeAcceptedOrder(store, order("ord_expired", "mch_a", AT - DAY, "expired"));
        await storeAcceptedOrder(
          store,
          order("ord_b", "mch_b", AT - DAY, "delivered_unpaid", { payment: "settle_failed" }),
        );
        await storeAcceptedOrder(store, sale("ord_s1", "mch_a", AT - DAY, "8.00"));
        await storeAcceptedOrder(store, sale("ord_s2", "mch_a", FROM, "2.5"));
        // Settled whatever became of the goods: unfulfilled, or closed by the merchant.
        await storeAcceptedOrder(
          store,
          sale("ord_s3", "mch_a", AT - 2 * DAY, "0.000001", { state: "unfulfilled" }),
        );
        await storeAcceptedOrder(
          store,
          sale("ord_s4", "mch_a", AT - 3 * DAY, "3.00", { state: "fulfillment_closed" }),
        );
        await storeAcceptedOrder(store, sale("ord_s5", "mch_a", FROM - 1, "100.00"));
        await storeAcceptedOrder(store, sale("ord_s6", "mch_a", null, "50.00"));
        await store.putReceipt("mch_a", receiptAlone("ord_in", AT));
        await storeAcceptedOrder(store, sale("ord_sb", "mch_b", AT, "9.00"));

        const list = await merchants.list({ ...LIVE, limit: 50 });
        const a = list.rows.find((row) => row.id === "mch_a");

        expect(a).toStrictEqual({
          id: "mch_a",
          serviceName: "A seller",
          sellerSite: null,
          createdAt: 1_000,
          integration: "api",
          segment: "selling",
          missing: [],
          keys: { issued: 2, working: 1 },
          lastContactAt: AT - 20_000,
          cards: { onSale: 2, published: 3 },
          thirtyDays: {
            from: FROM,
            orders: 2,
            settled: { amount: "13.500001", count: 4 },
          },
          lastSaleAt: AT - DAY,
        });
        const b = list.rows.find((row) => row.id === "mch_b");
        expect(b?.keys).toStrictEqual({ issued: 1, working: 1 });
        expect(b?.lastContactAt).toBeNull();
        expect(b?.thirtyDays.settled).toStrictEqual({ amount: "9.00", count: 1 });
      });

      it("fails a read rather than adding a settled order that carries no price", async () => {
        const under = await open();
        const { store, merchants } = under;
        await merchant(store, "mch_a", 1_000, SELLS);
        const priceless = sale("ord_priceless", "mch_a", AT - DAY, "1.00");
        await storeAcceptedOrder(store, {
          ...priceless,
          order: { ...priceless.order, price: null },
        });

        await expect(merchants.list({ ...LIVE, limit: 50 })).rejects.toThrow();
        await expect(merchants.merchant("mch_a", LIVE)).rejects.toThrow();
      });

      it("reads a merchant who sold nothing as zero sales, not as missing figures", async () => {
        const under = await open();
        await merchant(under.store, "mch_new", 1_000);

        const [row] = (await under.merchants.list({ ...LIVE, limit: 50 })).rows;

        expect(row?.thirtyDays).toStrictEqual({
          from: FROM,
          orders: 0,
          settled: NO_SALES,
        });
        expect(row?.lastSaleAt).toBeNull();
        expect(row?.keys).toStrictEqual({ issued: 0, working: 0 });
        expect(row?.cards).toStrictEqual({ onSale: 0, published: 0 });
      });
    });

    describe("one merchant", () => {
      it("is null for a merchant that is not there, an identifier nobody could have included", async () => {
        const { merchants } = await open();

        expect(await merchants.merchant("mch_nobody", LIVE)).toBeNull();
        expect(await merchants.merchant("not an identifier; at all", LIVE)).toBeNull();
      });

      it("holds the head facts, the wallet and its split, every key and every card", async () => {
        const under = await open();
        const { store, merchants } = under;
        const published = await merchant(store, "mch_a", 1_000, {
          ...SELLS,
          site: "https://shop.example",
          cards: 2,
        });
        await store.setCardPaused("mch_a", published[1] ?? "", true);
        await store.addKey(
          { id: "mk_old", merchantId: "mch_a", label: "old", digest: "d1" },
          1_000,
        );
        await store.addKey(
          { id: "mk_new", merchantId: "mch_a", label: "new", digest: "d2" },
          2_000,
        );
        await store.noteKeyUse("mk_new", 3_000, "agentify-sdk/0.9.0");
        await store.disableKeyOf("mch_a", "mk_old", 2_500);
        await store.noteContact("mch_a", 3_000, "api");

        const record = (await merchants.merchant("mch_a", LIVE)) as MerchantRecord;

        expect(record).toMatchObject({
          id: "mch_a",
          serviceName: "A seller",
          sellerSite: "https://shop.example",
          createdAt: 1_000,
          integration: "api",
          selling: "open",
          segment: "selling",
          missing: [],
          liveApprovedAt: 1_000,
          lastContactAt: 3_000,
          lastSaleAt: null,
          wallet: {
            address: W1,
            split: payoutSplitFor(NETWORK, "mch_a", W1).address,
            pending: null,
          },
        });
        expect(record.keys).toStrictEqual({
          rows: [
            { id: "mk_new", label: "new", createdAt: 2_000, lastUsedAt: 3_000, disabledAt: null },
            { id: "mk_old", label: "old", createdAt: 1_000, lastUsedAt: null, disabledAt: 2_500 },
          ],
          total: 2,
          working: 1,
        });
        expect(record.cards.total).toBe(2);
        expect(record.cards.onSale).toBe(1);
        expect(
          record.cards.rows.map((one) => [one.card.merchant_item_id, one.paused, one.onSale]),
        ).toStrictEqual([
          ["sku-1", false, true],
          ["sku-2", true, false],
        ]);
        expect(record.cards.rows[0]).toMatchObject({
          id: published[0],
          card: { title: "Card 1", price: { amount: "5.00", currency: "USD" } },
          publishedAt: 1_000,
          integration: "api",
        });
      });

      it("says a wallet change waits and when it lands, and never its wallet or split", async () => {
        const under = await open();
        const { store, merchants } = under;
        await merchant(store, "mch_a", 1_000, SELLS);
        const before = await store.merchantById("mch_a");
        const landsAt = AT + 2 * DAY;
        const next = payoutSplitFor(NETWORK, "mch_a", W2);
        const written = await store.setPayoutWallet(
          "mch_a",
          before?.payoutWallet ?? NO_WALLET,
          {
            address: W1,
            split: payoutSplitFor(NETWORK, "mch_a", W1),
            pending: { address: W2, takesEffectAt: landsAt, split: next },
          },
          2_000,
        );
        expect(typeof written).toBe("object");

        const waiting = await merchants.merchant("mch_a", LIVE);
        const landed = await merchants.merchant("mch_a", { ...LIVE, at: landsAt });
        const listed = await merchants.list({ ...LIVE, limit: 50 });

        expect(waiting?.wallet).toStrictEqual({
          address: W1,
          split: payoutSplitFor(NETWORK, "mch_a", W1).address,
          pending: { landsAt },
        });
        for (const answer of [waiting, listed]) {
          const said = JSON.stringify(answer).toLowerCase();
          expect(said).not.toContain(next.address.toLowerCase());
          expect(said).not.toContain(W2.toLowerCase());
        }
        expect(landed?.wallet).toStrictEqual({ address: W2, split: next.address, pending: null });
      });

      it("counts selling by UTC day over thirty days, every day drawn, today's partial one last", async () => {
        const under = await open();
        const { store, merchants } = under;
        await merchant(store, "mch_a", 1_000, SELLS);
        await storeAcceptedOrder(store, sale("ord_1", "mch_a", FROM, "1.00"));
        await storeAcceptedOrder(store, sale("ord_2", "mch_a", FROM + DAY - 1, "2.00"));
        // Dated by the block's time where the chain was seen, not by when it was paid.
        await storeAcceptedOrder(
          store,
          sale("ord_3", "mch_a", FROM - 1, "0.10", { executedAt: AT }),
        );
        await storeAcceptedOrder(store, sale("ord_4", "mch_a", AT - 60_000, "0.20"));
        await storeAcceptedOrder(store, sale("ord_5", "mch_a", FROM - 1, "50.00"));
        await storeAcceptedOrder(store, sale("ord_6", "mch_a", null, "60.00"));

        const record = await merchants.merchant("mch_a", LIVE);
        const days = record?.thirtyDays.days ?? [];

        expect(days).toHaveLength(30);
        expect(days[0]).toStrictEqual({ day: "2026-09-24", amount: "3.00", count: 2 });
        expect(days[1]).toStrictEqual({ day: "2026-09-25", ...NO_SALES });
        expect(days[29]).toStrictEqual({ day: "2026-10-23", amount: "0.30", count: 2 });
        expect(days.reduce((sum, day) => sum + day.count, 0)).toBe(4);
        expect(record?.thirtyDays.settled).toStrictEqual({ amount: "3.30", count: 4 });
        expect(record?.lastSaleAt).toBe(AT);
      });

      it("names the orders worth a look, newest first, and no other merchant's", async () => {
        const under = await open();
        const { store, merchants } = under;
        const [itemId] = await merchant(store, "mch_a", 1_000, SELLS);
        await merchant(store, "mch_b", 1_000, SELLS);
        const priced = { amount: "8.00", currency: "USD", asOf: 0 };
        await storeAcceptedOrder(
          store,
          order(
            "ord_unknown",
            "mch_a",
            AT - 1_000,
            "paid",
            { payment: "outcome_unknown" },
            {
              itemId: itemId ?? "",
            },
          ),
        );
        await storeAcceptedOrder(
          store,
          order("ord_settling", "mch_a", AT - 2_000, "paid", {
            payment: "settling",
            price: priced,
          }),
        );
        await storeAcceptedOrder(
          store,
          order("ord_unfulfilled", "mch_a", AT - 3_000, "unfulfilled"),
        );
        await storeAcceptedOrder(
          store,
          order("ord_unpaid", "mch_a", AT - 4_000, "delivered_unpaid"),
        );
        await storeAcceptedOrder(store, order("ord_delivered", "mch_a", AT - 5_000, "delivered"));
        await storeAcceptedOrder(store, order("ord_open", "mch_a", AT - 6_000, "paid"));
        await storeAcceptedOrder(store, order("ord_b", "mch_b", AT - 500, "unfulfilled"));

        const look = (await merchants.merchant("mch_a", LIVE))?.worthALook;

        expect(look?.total).toBe(4);
        expect(look?.rows.map((one) => one.id)).toStrictEqual([
          "ord_unknown",
          "ord_settling",
          "ord_unfulfilled",
          "ord_unpaid",
        ]);
        expect(look?.rows[0]).toStrictEqual({
          id: "ord_unknown",
          status: "payment_unresolved",
          price: { amount: "5.00", currency: "USD" },
          createdAt: AT - 1_000,
          itemId,
          title: "Card 1",
        });
        expect(look?.rows[1]?.price).toStrictEqual({ amount: "8.00", currency: "USD" });
        expect(look?.rows[1]?.title).toBeNull();
        expect(look?.rows.map((one) => one.status).slice(2)).toStrictEqual([
          "unfulfilled",
          "delivered_unpaid",
        ]);
      });

      it("cuts the orders worth a look and says how many there are", async () => {
        const under = await open();
        const { store, merchants } = under;
        await merchant(store, "mch_a", 1_000, SELLS);
        for (let n = 0; n < 21; n += 1) {
          await storeAcceptedOrder(
            store,
            order(`ord_${n}`, "mch_a", AT - n * 1_000, "unfulfilled"),
          );
        }

        const look = (await merchants.merchant("mch_a", LIVE))?.worthALook;

        expect(look?.total).toBe(21);
        expect(look?.rows).toHaveLength(20);
        expect(look?.rows[0]?.id).toBe("ord_0");
      });

      it("reads a merchant with nothing yet as empty lists and zeros", async () => {
        const under = await open();
        await merchant(under.store, "mch_new", 1_000);

        const record = await under.merchants.merchant("mch_new", LIVE);

        expect(record).toMatchObject({
          serviceName: null,
          wallet: null,
          liveApprovedAt: null,
          segment: "setting_up",
          missing: ["no_seller_name", "no_payout_wallet", "no_operator_approval"],
          keys: { rows: [], total: 0, working: 0 },
          cards: { rows: [], total: 0, onSale: 0 },
          worthALook: { rows: [], total: 0 },
          lastContactAt: null,
          lastSaleAt: null,
        });
        expect(record?.thirtyDays.orders).toBe(0);
        expect(record?.thirtyDays.settled).toStrictEqual(NO_SALES);
        expect(record?.thirtyDays.days).toStrictEqual(
          Array.from({ length: 30 }, (_, day) => ({
            day: new Date(Date.UTC(2026, 8, 24 + day)).toISOString().slice(0, 10),
            amount: "0.00",
            count: 0,
          })),
        );
      });
    });
  });
}

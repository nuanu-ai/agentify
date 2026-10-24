/**
 * What the operator's reads of merchants promise, run against the memory
 * reader in `pnpm test` and against the Postgres one as a database test, over
 * the same rows written through the store, so the two cannot drift apart: the
 * list's segments, counts, order, search and cut; one merchant's page; and the
 * gateway's half of the three actions on a merchant, each leaving its row.
 *
 * Every zero asserted here comes from a read that succeeded and found nothing.
 */

import type { Order, SurfaceMode } from "@agentify/core";
import type { Card, Receipt } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import type { JournalRow } from "../ports/journal.js";
import type { MerchantRecord, OperatorMerchants } from "../ports/operator/merchants.js";
import {
  admitMerchant,
  disableMerchantKey,
  withdrawAdmission,
} from "../ports/operator/merchants-actions.js";
import type { Store, StoredOrder } from "../ports/store.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "../split/networks.js";
import { payoutSplitFor } from "../split/parameters.js";
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

const OPERATOR = "acc_operator";

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
  return { ...made, ...rest, order: { ...made.order, ...change } };
};

/** A receipt: money moved for `orderId` at `paidAt`, priced `amount` in `currency`. */
const receipt = (orderId: string, paidAt: number, amount: string, currency = "USD"): Receipt => ({
  id: `rcp_${orderId}`,
  order_id: orderId,
  item_id: "item_1",
  price: {
    amount,
    currency,
    at: new Date(paidAt).toISOString(),
    as_of: new Date(paidAt).toISOString(),
  },
  paid_at: new Date(paidAt).toISOString(),
  outcome: "delivered",
  test: true,
});

const LIVE = { at: AT, surface: "live" } as const satisfies { at: number; surface: SurfaceMode };

const rowsAbout = async (store: Store, merchantId: string): Promise<readonly JournalRow[]> =>
  (await store.journal({ about: { merchant: merchantId }, limit: 50 })).rows;

/** A row as a case compares it: everything it holds but its place in the journal. */
const held = ({ sequence: _sequence, ...entry }: JournalRow) => entry;

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
        await store.putReceipt("mch_old_sale", receipt("ord_old", AT - 40 * DAY, "1.00"));
        await store.putReceipt("mch_new_sale", receipt("ord_new", AT - DAY, "1.00"));

        const list = await merchants.list({ ...LIVE, limit: 50 });

        expect(list.rows.map((row) => row.id)).toStrictEqual([
          "mch_waits",
          "mch_new_sale",
          "mch_old_sale",
          "mch_never_new",
          "mch_never_old",
        ]);
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
          segments: { all: 0, waiting: 0, selling: 0, paused: 0, setting_up: 0 },
        });
      });

      it("answers an empty channel with zeros", async () => {
        const { merchants } = await open();

        expect(await merchants.list({ ...LIVE, limit: 50 })).toStrictEqual({
          rows: [],
          total: 0,
          segments: { all: 0, waiting: 0, selling: 0, paused: 0, setting_up: 0 },
        });
      });

      it("draws each row's keys, contact, cards and thirty days from that merchant's records alone", async () => {
        const under = await open();
        const { store, merchants } = under;
        const [first] = await merchant(store, "mch_a", 1_000, { ...SELLS, cards: 3 });
        await store.setCardPaused("mch_a", first ?? "", true);
        await merchant(store, "mch_b", 2_000, SELLS);
        await store.addKey({ id: "mk_1", merchantId: "mch_a", label: "one", digest: "d1" }, 1_000);
        await store.addKey({ id: "mk_2", merchantId: "mch_a", label: "two", digest: "d2" }, 1_000);
        await store.addKey({ id: "mk_b", merchantId: "mch_b", label: "b", digest: "d3" }, 1_000);
        await store.disableKeyOf("mch_a", "mk_2", 1_500);
        await store.noteContact("mch_a", AT - 20_000);
        await store.addOrder(order("ord_in", "mch_a", FROM, "delivered"));
        await store.addOrder(order("ord_before", "mch_a", FROM - 1, "delivered"));
        await store.addOrder(order("ord_lapsed", "mch_a", AT - DAY, "expired"));
        await store.addOrder(order("ord_b", "mch_b", AT - DAY, "delivered"));
        await store.putReceipt("mch_a", receipt("ord_in", AT - DAY, "8.00"));
        await store.putReceipt("mch_a", receipt("ord_2", FROM, "2.5"));
        await store.putReceipt("mch_a", receipt("ord_3", AT - 2 * DAY, "0.000000000000000001"));
        await store.putReceipt("mch_a", receipt("ord_4", AT - 3 * DAY, "3.00", "EUR"));
        await store.putReceipt("mch_a", receipt("ord_old", FROM - 1, "100.00"));
        await store.putReceipt("mch_b", receipt("ord_b", AT, "9.00"));

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
            orders: 1,
            settled: {
              count: 4,
              sums: [
                { amount: "3.00", currency: "EUR" },
                { amount: "10.500000000000000001", currency: "USD" },
              ],
            },
          },
          lastSaleAt: AT - DAY,
        });
        const b = list.rows.find((row) => row.id === "mch_b");
        expect(b?.keys).toStrictEqual({ issued: 1, working: 1 });
        expect(b?.lastContactAt).toBeNull();
        expect(b?.thirtyDays.settled).toStrictEqual({
          count: 1,
          sums: [{ amount: "9.00", currency: "USD" }],
        });
      });

      it("reads a merchant who sold nothing as zero sales, not as missing figures", async () => {
        const under = await open();
        await merchant(under.store, "mch_new", 1_000);

        const [row] = (await under.merchants.list({ ...LIVE, limit: 50 })).rows;

        expect(row?.thirtyDays).toStrictEqual({
          from: FROM,
          orders: 0,
          settled: { count: 0, sums: [] },
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
        await store.noteContact("mch_a", 3_000);

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
        await store.putReceipt("mch_a", receipt("ord_1", FROM, "1.00"));
        await store.putReceipt("mch_a", receipt("ord_2", FROM + DAY - 1, "2.00"));
        await store.putReceipt("mch_a", receipt("ord_3", AT, "0.10"));
        await store.putReceipt("mch_a", receipt("ord_4", AT - 60_000, "0.20"));
        await store.putReceipt("mch_a", receipt("ord_5", FROM - 1, "50.00"));

        const days = (await merchants.merchant("mch_a", LIVE))?.thirtyDays.days ?? [];

        expect(days).toHaveLength(30);
        expect(days[0]).toStrictEqual({
          day: "2026-09-24",
          count: 2,
          sums: [{ amount: "3.00", currency: "USD" }],
        });
        expect(days[1]).toStrictEqual({ day: "2026-09-25", count: 0, sums: [] });
        expect(days[29]).toStrictEqual({
          day: "2026-10-23",
          count: 2,
          sums: [{ amount: "0.30", currency: "USD" }],
        });
        expect(days.reduce((sum, day) => sum + day.count, 0)).toBe(4);
      });

      it("names the orders worth a look, newest first, and no other merchant's", async () => {
        const under = await open();
        const { store, merchants } = under;
        const [itemId] = await merchant(store, "mch_a", 1_000, SELLS);
        await merchant(store, "mch_b", 1_000, SELLS);
        const priced = { amount: "8.00", currency: "USD", asOf: 0 };
        await store.addOrder(
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
        await store.addOrder(
          order("ord_settling", "mch_a", AT - 2_000, "paid", {
            payment: "settling",
            price: priced,
          }),
        );
        await store.addOrder(order("ord_unfulfilled", "mch_a", AT - 3_000, "unfulfilled"));
        await store.addOrder(order("ord_unpaid", "mch_a", AT - 4_000, "delivered_unpaid"));
        await store.addOrder(order("ord_delivered", "mch_a", AT - 5_000, "delivered"));
        await store.addOrder(order("ord_open", "mch_a", AT - 6_000, "created"));
        await store.addOrder(order("ord_b", "mch_b", AT - 500, "unfulfilled"));

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
          state: "paid",
          payment: "outcome_unknown",
          price: { amount: "5.00", currency: "USD" },
          createdAt: AT - 1_000,
          itemId,
          title: "Card 1",
        });
        expect(look?.rows[1]?.price).toStrictEqual({ amount: "8.00", currency: "USD" });
        expect(look?.rows[1]?.title).toBeNull();
      });

      it("cuts the orders worth a look and says how many there are", async () => {
        const under = await open();
        const { store, merchants } = under;
        await merchant(store, "mch_a", 1_000, SELLS);
        for (let n = 0; n < 21; n += 1) {
          await store.addOrder(order(`ord_${n}`, "mch_a", AT - n * 1_000, "unfulfilled"));
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
          keys: { rows: [], total: 0 },
          cards: { rows: [], total: 0, onSale: 0 },
          worthALook: { rows: [], total: 0 },
          lastContactAt: null,
          lastSaleAt: null,
        });
        expect(record?.thirtyDays.orders).toBe(0);
        expect(record?.thirtyDays.settled).toStrictEqual({ count: 0, sums: [] });
        expect(record?.thirtyDays.days.every((day) => day.count === 0)).toBe(true);
      });
    });

    describe("the operator's actions on a merchant", () => {
      const press = { operator: OPERATOR, at: AT };
      const actor = { kind: "account", id: OPERATOR } as const;

      it("admits a merchant with a row of its own, and a repeat as unchanged keeping the first instant", async () => {
        const { store } = await open();
        await merchant(store, "mch_a", 1_000, { name: "A", wallet: W1 });

        const first = await admitMerchant(store, "live", "mch_a", press);
        const again = await admitMerchant(store, "live", "mch_a", { ...press, at: AT + 1 });

        expect([first, again]).toStrictEqual([{ kind: "done" }, { kind: "unchanged" }]);
        expect((await store.merchantById("mch_a"))?.liveApprovedAt).toBe(AT);
        expect((await rowsAbout(store, "mch_a")).map(held)).toStrictEqual([
          {
            at: AT + 1,
            actor,
            action: "admit",
            subject: { kind: "merchant", id: "mch_a" },
            reason: null,
            outcome: { kind: "unchanged" },
          },
          {
            at: AT,
            actor,
            action: "admit",
            subject: { kind: "merchant", id: "mch_a" },
            reason: null,
            outcome: { kind: "done" },
          },
        ]);
      });

      it("refuses to admit or withdraw off the live channel, writing the refusal and nothing else", async () => {
        const { store } = await open();
        await merchant(store, "mch_a", 1_000, { name: "A", wallet: W1 });

        expect(await admitMerchant(store, "test", "mch_a", press)).toStrictEqual({
          kind: "refused",
          code: "not_live_channel",
        });
        expect(
          await withdrawAdmission(store, "test", "mch_a", { ...press, reason: "a reason" }),
        ).toStrictEqual({ kind: "refused", code: "not_live_channel" });

        expect((await store.merchantById("mch_a"))?.liveApprovedAt).toBeNull();
        expect(
          (await rowsAbout(store, "mch_a")).map((row) => [row.action, row.outcome]),
        ).toStrictEqual([
          ["withdraw", { kind: "refused", code: "not_live_channel" }],
          ["admit", { kind: "refused", code: "not_live_channel" }],
        ]);
      });

      it("refuses a merchant that is not there with a row, and an identifier nobody could have without one", async () => {
        const { store } = await open();

        expect(await admitMerchant(store, "live", "mch_gone", press)).toStrictEqual({
          kind: "refused",
          code: "no_such_merchant",
        });
        expect(
          await withdrawAdmission(store, "live", "no such; id", { ...press, reason: "r" }),
        ).toStrictEqual({ kind: "refused", code: "no_such_merchant" });

        expect((await store.journal({ limit: 50 })).rows.map(held)).toStrictEqual([
          {
            at: AT,
            actor,
            action: "admit",
            subject: { kind: "merchant", id: "mch_gone" },
            reason: null,
            outcome: { kind: "refused", code: "no_such_merchant" },
          },
        ]);
      });

      it("withdraws an admission with its note, taking every card off sale, and a repeat as unchanged", async () => {
        const { store, merchants } = await open();
        await merchant(store, "mch_a", 1_000, SELLS);
        const reason = "sells under a name that is not theirs";

        const first = await withdrawAdmission(store, "live", "mch_a", { ...press, reason });
        const again = await withdrawAdmission(store, "live", "mch_a", { ...press, reason });

        expect([first, again]).toStrictEqual([{ kind: "done" }, { kind: "unchanged" }]);
        const record = await merchants.merchant("mch_a", LIVE);
        expect(record?.liveApprovedAt).toBeNull();
        expect(record?.missing).toStrictEqual(["no_operator_approval"]);
        expect(record?.cards).toMatchObject({ total: 1, onSale: 0 });
        expect(
          (await rowsAbout(store, "mch_a")).map((row) => [row.reason, row.outcome.kind]),
        ).toStrictEqual([
          [reason, "unchanged"],
          [reason, "done"],
        ]);
      });

      it("refuses an intervention without a reason, or with one the journal cannot keep, and changes nothing", async () => {
        const { store } = await open();
        await merchant(store, "mch_a", 1_000, SELLS);
        await store.addKey({ id: "mk_a", merchantId: "mch_a", label: "a", digest: "d1" }, 1_000);

        expect(
          await withdrawAdmission(store, "live", "mch_a", { ...press, reason: "  " }),
        ).toStrictEqual({ kind: "refused", code: "no_reason" });
        expect(
          await disableMerchantKey(store, "mch_a", "mk_a", { ...press, reason: "<b>leaked</b>" }),
        ).toStrictEqual({ kind: "refused", code: "reason_refused" });

        expect((await store.merchantById("mch_a"))?.liveApprovedAt).toBe(1_000);
        expect((await store.keysOf("mch_a"))[0]?.disabledAt).toBeNull();
        expect(
          (await rowsAbout(store, "mch_a")).map((row) => [row.action, row.reason, row.outcome]),
        ).toStrictEqual([
          ["disable_key", null, { kind: "refused", code: "reason_refused" }],
          ["withdraw", null, { kind: "refused", code: "no_reason" }],
        ]);
      });

      it("disables one key with its reason, touches no other, and refuses another merchant's", async () => {
        const { store } = await open();
        await merchant(store, "mch_a", 1_000, SELLS);
        await merchant(store, "mch_b", 1_000, SELLS);
        await store.addKey({ id: "mk_a1", merchantId: "mch_a", label: "a1", digest: "d1" }, 1_000);
        await store.addKey({ id: "mk_a2", merchantId: "mch_a", label: "a2", digest: "d2" }, 1_000);
        await store.addKey({ id: "mk_b", merchantId: "mch_b", label: "b", digest: "d3" }, 1_000);
        const reason = "the merchant reported it leaked";

        const first = await disableMerchantKey(store, "mch_a", "mk_a1", { ...press, reason });
        const again = await disableMerchantKey(store, "mch_a", "mk_a1", {
          ...press,
          at: AT + 1,
          reason,
        });
        const foreign = await disableMerchantKey(store, "mch_a", "mk_b", { ...press, reason });

        expect([first, again, foreign]).toStrictEqual([
          { kind: "done" },
          { kind: "unchanged" },
          { kind: "refused", code: "no_such_key" },
        ]);
        expect(
          (await store.keysOf("mch_a")).map((key) => [key.id, key.disabledAt]).sort(),
        ).toStrictEqual([
          ["mk_a1", AT],
          ["mk_a2", null],
        ]);
        expect((await store.keysOf("mch_b"))[0]?.disabledAt).toBeNull();
        expect(
          (await rowsAbout(store, "mch_a")).map((row) => [row.subject, row.outcome]),
        ).toStrictEqual([
          [
            { kind: "key", id: "mk_b", merchantId: "mch_a" },
            { kind: "refused", code: "no_such_key" },
          ],
          [{ kind: "key", id: "mk_a1", merchantId: "mch_a" }, { kind: "unchanged" }],
          [{ kind: "key", id: "mk_a1", merchantId: "mch_a" }, { kind: "done" }],
        ]);
      });
    });
  });
}

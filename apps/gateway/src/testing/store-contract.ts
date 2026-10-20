/**
 * The store port's promises, run against memory under `pnpm test` and against
 * Postgres under `pnpm test:db`, so the two adapters cannot drift apart.
 *
 * Only the port's promises belong here; what pins one adapter's machinery
 * (frozen objects in memory; driver errors, pool listeners, advisory locks and
 * migrations in Postgres) stays in that adapter's own test file. No assertion
 * turns on elapsed time: an instant a case needs is passed in, except when a
 * payment was claimed, which each adapter stamps with its own clock.
 *
 * `openOrders`, `deliveredWithoutReceipt`, `runAlone`, `merchants` and the
 * envelopes written alongside an order have no case here. `runAlone` is checked
 * only on Postgres, across two pools; the envelopes in each adapter's own file.
 */

import type { Order } from "@agentify/core";
import type { Card, Receipt } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import type {
  PayoutWalletWrite,
  RecordedPayoutSplit,
  Store,
  StoredOrder,
  StoredPayoutWallet,
} from "../ports/store.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "../split/networks.js";
import { type PayoutSplit, payoutSplitFor } from "../split/parameters.js";

/** The merchant almost everything here belongs to, because a card needs one. */
const A = "mch_a";
/** A second one, for the cases whose subject is that the two cannot see each other. */
const B = "mch_b";

/** A merchant paid nowhere, with nothing waiting: where every merchant starts. */
const NO_WALLET = { address: null, split: null, pending: null } as const;

/** The two networks a registry row can name here: the test chain, and Base under a fixture's wallet. */
const BASE_SEPOLIA = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532");
const BASE = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:8453");

/** Wallets with letters in them, in the checksummed spelling the caller hands the store. */
const W1 = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const W2 = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const W3 = "0xde3F8C4422A7F8C94bce9Cc2Ec118665108148EF";

/** One merchant's split of one wallet, every parameter as the gateway computes it. */
const splitOf = (merchantId: string, wallet: string, network = BASE_SEPOLIA): PayoutSplit =>
  payoutSplitFor(network, merchantId, wallet);

/** A wallet write with nothing waiting: the address and its split. */
const paidAt = (merchantId: string, wallet: string, network = BASE_SEPOLIA): PayoutWalletWrite => ({
  address: wallet,
  split: splitOf(merchantId, wallet, network),
  pending: null,
});

/** A wallet write with a replacement waiting until `takesEffectAt`, both with their splits. */
const waitingFor = (
  merchantId: string,
  now: string,
  next: string,
  takesEffectAt: number,
): PayoutWalletWrite => ({
  address: now,
  split: splitOf(merchantId, now),
  pending: { address: next, takesEffectAt, split: splitOf(merchantId, next) },
});

/** A split as the registry hands it back: as given, and when it was first recorded. */
const recorded = (split: PayoutSplit, recordedAt: number): RecordedPayoutSplit => ({
  ...split,
  recordedAt,
});

/** What a merchant's wallet reads back as, once `write` landed and its splits were first recorded at the instants given. */
const readBack = (
  write: PayoutWalletWrite,
  at: { readonly address: number; readonly pending?: number },
): StoredPayoutWallet => ({
  address: write.address,
  split: recorded(write.split, at.address),
  pending:
    write.pending === null
      ? null
      : {
          address: write.pending.address,
          takesEffectAt: write.pending.takesEffectAt,
          split: recorded(write.pending.split, at.pending ?? at.address),
        },
});

/** The addresses of a list of splits, in the order the store gave them. */
const addressesOf = async (splits: Promise<readonly RecordedPayoutSplit[]>): Promise<string[]> =>
  (await splits).map((split) => split.address);

const card = (merchantItemId: string, title: string): Card => ({
  merchant_item_id: merchantItemId,
  title,
  description: "a product",
  price: { amount: "5.00", currency: "USD" },
  result: { access_url: { type: "string" } },
  fulfillment: "sync",
});

/**
 * The smallest order the store accepts. Give orders listed together distinct
 * `createdAt` values: Postgres sorts a merchant's list by it, and ties come back
 * in whatever order the planner picks, which makes a suite flicker.
 */
export const anOrder = (
  id: string,
  state: Order["state"],
  at: {
    readonly merchantId?: string;
    readonly createdAt?: number;
    readonly paymentRef?: string;
  } = {},
): StoredOrder => ({
  order: {
    id,
    state,
    mode: { needsConfirmation: false, settle: "after_fulfillment" },
    policy: {
      deadlines: {
        quoteResponseMs: 1,
        quoteTtlMs: 1,
        settleResponseMs: 1,
        syncResponseMs: 1,
        paymentAfterConfirmationMs: 1,
        confirmationResponseMs: 1,
        asyncFulfillmentMs: 1,
      },
      redelivery: { baseDelayMs: 1, factor: 1, maxDelayMs: 1, maxAttempts: 1 },
    },
    payment: "none",
    cardPrice: { amount: "5.00", currency: "USD", asOf: 0 },
    price: null,
    quoteSource: null,
    dispatch: { attempts: 0, accepted: false },
    heldFulfillment: false,
    closure: null,
    test: true,
    timestamps: {
      createdAt: at.createdAt ?? 1_000,
      quotedAt: null,
      confirmationRequestedAt: null,
      confirmedAt: null,
      settleStartedAt: null,
      paidAt: null,
      dispatchedAt: null,
    },
  },
  merchantId: at.merchantId ?? A,
  itemId: "item_1",
  merchantItemId: "sku-1",
  paymentRef: at.paymentRef ?? `pay_for_${id}`,
  params: {},
  priceId: null,
  delivery: null,
  payment: null,
  payTo: null,
  paidBy: null,
  settlement: null,
  paymentWords: [],
  paymentWordsDropped: 0,
  openDeliveryId: null,
});

const aReceipt = (id: string, orderId: string, outcome: Receipt["outcome"]): Receipt => ({
  id,
  order_id: orderId,
  item_id: "item_1",
  price: {
    amount: "5.00",
    currency: "USD",
    at: "2026-08-26T00:00:00.000Z",
    as_of: "2026-08-26T00:00:00.000Z",
  },
  paid_at: "2026-08-26T00:00:00.000Z",
  outcome,
  test: true,
});

/**
 * What the work answered, or "still waiting" after `ms`, so a lock that never
 * releases fails as an assertion rather than as a runner timeout.
 */
async function answeredWithin<T>(ms: number, work: Promise<T>): Promise<T | "still waiting"> {
  let bell: ReturnType<typeof setTimeout> | undefined;
  const rang = new Promise<"still waiting">((resolve) => {
    bell = setTimeout(() => resolve("still waiting"), ms);
  });
  try {
    return await Promise.race([work, rang]);
  } finally {
    clearTimeout(bell);
  }
}

/**
 * The identifiers of a list of orders, sorted: the port promises no order for a
 * merchant's orders, and the two adapters arrive at different ones.
 */
async function idsOf(orders: Promise<readonly StoredOrder[]>): Promise<string[]> {
  return (await orders).map((held) => held.order.id).sort((one, other) => one.localeCompare(other));
}

/**
 * What a call was refused with. Throws if the call succeeded, so a store that
 * quietly accepted the write is reported as that.
 */
async function refusalOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (thrown) {
    return thrown;
  }
  throw new Error("nothing was refused, and being refused is what this is about");
}

/**
 * That a call was refused with an error whose words say `why`. An error and
 * not just a rejection: `rejects.toThrow` passes on a rejection with nothing
 * in it, which is what a refusal built by a function that returns nothing
 * comes to.
 */
async function refusedWith(work: Promise<unknown>, why: RegExp): Promise<void> {
  const thrown = await refusalOf(work);
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(why);
}

/**
 * Everything `console.error` would print for a thrown value, causes included:
 * a secret carried in a cause would pass a test that read only the top message.
 */
function asLogged(thrown: unknown): string {
  const said: string[] = [];
  let at: unknown = thrown;
  for (let deep = 0; deep < 8 && at !== null && at !== undefined; deep += 1) {
    said.push(String(at), JSON.stringify(at) ?? "");
    at = typeof at === "object" && "cause" in at ? (at as { cause: unknown }).cause : null;
  }
  return said.join(" ");
}

/**
 * Runs the whole contract against the stores `open` returns. Each must be
 * empty, opened for Base Sepolia, and must allow two decisions in flight at
 * once: on a pool of one connection the second would wait for the connection
 * rather than the lock and be reported as a locking defect.
 */
export function describeStore(name: string, open: () => Promise<Store>): void {
  describe(name, () => {
    /** An empty store, for cases about a store with nothing in it. */
    const fresh = open;

    const twoMerchants = async (): Promise<Store> => {
      const store = await open();
      await store.addMerchant({ id: A, name: "Merchant A" }, 1_000);
      await store.addMerchant({ id: B, name: "Merchant B" }, 2_000);
      return store;
    };

    describe("a card", () => {
      it("is changed by being published again, and keeps its catalog identifier", async () => {
        // The portal tells a merchant to change a card by publishing it again; a
        // second card would leave agents holding the address of the stale one.
        const store = await twoMerchants();

        const first = await store.publishCard(A, card("sku-1", "A room"), 10_000);
        const again = await store.publishCard(A, card("sku-1", "A room, corrected"), 20_000);

        expect(again.id).toBe(first.id);
        expect(again.asOf).toBe(20_000);
        expect(await store.cards(A)).toHaveLength(1);
        expect((await store.cardById(first.id))?.card.title).toBe("A room, corrected");
      });

      it("gets its own identifier when it is a different product", async () => {
        const store = await twoMerchants();

        const room = await store.publishCard(A, card("sku-1", "A room"), 10_000);
        const esim = await store.publishCard(A, card("sku-2", "An eSIM"), 20_000);

        expect(esim.id).not.toBe(room.id);
        expect(await store.cards(A)).toHaveLength(2);
      });

      it("is one merchant's even where two merchants use one identifier", async () => {
        // Held unique across the gateway, a second merchant publishing "sku-1"
        // would edit the first merchant's card instead of publishing their own.
        const store = await twoMerchants();

        const mine = await store.publishCard(A, card("sku-1", "A's room"), 10_000);
        const theirs = await store.publishCard(B, card("sku-1", "B's room"), 20_000);

        expect(theirs.id).not.toBe(mine.id);
        expect((await store.cards(A)).map((held) => held.card.title)).toStrictEqual(["A's room"]);
        expect((await store.cards(B)).map((held) => held.card.title)).toStrictEqual(["B's room"]);
      });

      it("is nothing at all when nobody published it", async () => {
        expect(await (await twoMerchants()).cardById("item_nope")).toBeNull();
      });

      it("is published selling, and stays off sale across the next publish", async () => {
        // Editing a price must not silently put a product the merchant took off
        // sale back in front of agents.
        const store = await twoMerchants();
        const first = await store.publishCard(A, card("sku-1", "A room"), 10_000);
        expect(first.paused).toBe(false);

        await store.setCardPaused(A, first.id, true);
        const again = await store.publishCard(A, card("sku-1", "A room, dearer"), 20_000);

        expect(again.paused).toBe(true);
        expect(again.card.title).toBe("A room, dearer");
        expect((await store.cardById(first.id))?.paused).toBe(true);
        expect((await store.cards(A)).find((held) => held.id === first.id)?.paused).toBe(true);
      });

      it("goes off sale and back on, and says so about one that is not there", async () => {
        const store = await twoMerchants();
        const stored = await store.publishCard(A, card("sku-1", "A room"), 10_000);

        expect((await store.setCardPaused(A, stored.id, true))?.paused).toBe(true);
        expect((await store.cardById(stored.id))?.paused).toBe(true);
        expect((await store.setCardPaused(A, stored.id, false))?.paused).toBe(false);
        expect(await store.setCardPaused(A, "item_nope", true)).toBeNull();
      });

      it("is another merchant's exactly as loudly as it is nobody's", async () => {
        // Told apart, the two answers would let a merchant probe what a stranger
        // sells.
        const store = await twoMerchants();
        const theirs = await store.publishCard(B, card("sku-1", "B's room"), 10_000);

        expect(await store.setCardPaused(A, theirs.id, true)).toBeNull();
        expect(await store.setCardPaused(A, "item_nope", true)).toBeNull();
        expect((await store.cardById(theirs.id))?.paused).toBe(false);
      });
    });

    describe("the catalog", () => {
      it("carries every card with its own merchant's word beside it", async () => {
        const store = await twoMerchants();
        await store.publishCard(A, card("sku-1", "A's room"), 10_000);
        await store.publishCard(B, card("sku-1", "B's room"), 20_000);
        await store.setSelling(A, "paused");

        const entries = await store.catalogEntries();

        expect(entries).toHaveLength(2);
        expect(entries.find((entry) => entry.card.merchantId === A)?.merchant).toBe("paused");
        expect(entries.find((entry) => entry.card.merchantId === B)?.merchant).toBe("open");
      });

      it("carries where each card's merchant is paid, with its splits, and nothing where none is set", async () => {
        // Whether a card may be offered turns on this: a catalog read that lost
        // the address or its split would list cards no live purchase can
        // complete.
        const store = await twoMerchants();
        await store.publishCard(A, card("sku-1", "A's room"), 10_000);
        await store.publishCard(B, card("sku-1", "B's room"), 20_000);
        // Once its moment passes, a waiting change is the address a sale is
        // paid at, so it travels too, with the split it is paid through.
        const paid = waitingFor(
          A,
          "0x0000000000000000000000000000000000000009",
          "0x0000000000000000000000000000000000000008",
          90_000,
        );
        await store.setPayoutWallet(A, NO_WALLET, paid, 30_000);

        const entries = await store.catalogEntries();

        expect(entries.find((entry) => entry.card.merchantId === A)?.payoutWallet).toStrictEqual(
          readBack(paid, { address: 30_000 }),
        );
        expect(entries.find((entry) => entry.card.merchantId === B)?.payoutWallet).toStrictEqual(
          NO_WALLET,
        );
      });

      it("carries what each card's merchant is listed as, and nothing where nobody named one", async () => {
        // A payment request names the seller, so a catalog read that lost the
        // name would list cards whose payment request could name nobody.
        const store = await twoMerchants();
        await store.publishCard(A, card("sku-1", "A's room"), 10_000);
        await store.publishCard(B, card("sku-1", "B's room"), 20_000);
        await store.setServiceName(A, "A's own shop", 30_000);

        const entries = await store.catalogEntries();

        expect(entries.find((entry) => entry.card.merchantId === A)?.serviceName).toBe(
          "A's own shop",
        );
        expect(entries.find((entry) => entry.card.merchantId === B)?.serviceName).toBeNull();
      });

      it("carries each card's merchant's site, and nothing where nobody gave one", async () => {
        const store = await twoMerchants();
        await store.publishCard(A, card("sku-1", "A's room"), 10_000);
        await store.publishCard(B, card("sku-1", "B's room"), 20_000);
        await store.setSellerSite(A, "https://a.example", 30_000);

        const entries = await store.catalogEntries();

        expect(entries.find((entry) => entry.card.merchantId === A)?.sellerSite).toBe(
          "https://a.example",
        );
        expect(entries.find((entry) => entry.card.merchantId === B)?.sellerSite).toBeNull();
      });
    });

    describe("whether a merchant is selling", () => {
      it("is open until somebody says otherwise, and is remembered when they do", async () => {
        // Never "unknown": a merchant the store holds is either open or paused.
        const store = await twoMerchants();

        expect(await store.selling(A)).toBe("open");

        await store.setSelling(A, "paused");
        expect(await store.selling(A)).toBe("paused");
        expect(await store.selling(B)).toBe("open");

        await store.setSelling(A, "open");
        expect(await store.selling(A)).toBe("open");
      });

      it("is refused for a merchant the store does not hold, in either direction", async () => {
        // "open" here would sell on behalf of somebody who does not exist. The
        // refusal names the merchant, which is what an operator reading it needs.
        const store = await twoMerchants();

        await expect(store.selling("mch_nobody")).rejects.toThrow(/mch_nobody/);
        await expect(store.setSelling("mch_nobody", "paused")).rejects.toThrow(/mch_nobody/);
      });
    });

    describe("the integration a merchant sells through", () => {
      // A card is off sale while its integration is not the one its merchant
      // sells through. What the store owes that rule: every card says what
      // published it, a switch never strands an order that still waits on the
      // integration being left, and no order is born for a card in the moment
      // it goes off sale.

      it("starts on the merchant's code, with each card on whatever published it", async () => {
        const store = await twoMerchants();

        const coded = await store.publishCard(A, card("sku-1", "A room"), 10_000);
        const imported = await store.publishCard(A, card("woo-1", "A mug"), 20_000, "woocommerce");

        expect((await store.merchantById(A))?.integration).toBe("api");
        expect(coded.integration).toBe("api");
        expect(imported.integration).toBe("woocommerce");
        expect((await store.cardById(imported.id))?.integration).toBe("woocommerce");
        expect((await store.catalogEntries()).map((entry) => entry.integration)).toStrictEqual([
          "api",
          "api",
        ]);
      });

      it("keeps a card with the integration that first published it", async () => {
        // A publish through the other integration under the same identifier
        // would otherwise take over a product whose orders the first one fills.
        const store = await twoMerchants();
        const first = await store.publishCard(A, card("sku-1", "A room"), 10_000);

        const other = await store.publishCard(
          A,
          card("sku-1", "A room from the shop"),
          20_000,
          "woocommerce",
        );

        expect(other.id).toBe(first.id);
        expect(other.integration).toBe("api");
        expect((await store.cards(A)).map((held) => held.card.title)).toStrictEqual(["A room"]);
        const again = await store.publishCard(A, card("sku-1", "A room, dearer"), 30_000, "api");
        expect(again.card.title).toBe("A room, dearer");
      });

      it("moves to the other one and back, for the merchant asked and nobody else", async () => {
        const store = await twoMerchants();

        expect(await store.switchIntegration(A, "woocommerce")).toStrictEqual({
          switched: true,
          sellingPaused: false,
        });
        expect((await store.merchantById(A))?.integration).toBe("woocommerce");
        expect((await store.merchantById(B))?.integration).toBe("api");
        // Asking for the one already in use changes nothing and is no refusal.
        expect(await store.switchIntegration(A, "woocommerce")).toStrictEqual({
          switched: true,
          sellingPaused: false,
        });

        await store.switchIntegration(A, "api");
        expect((await store.merchantById(A))?.integration).toBe("api");
      });

      it("stays where it is while an order waits on it, and names the order", async () => {
        // Nothing of the integration being left draws the stream once the
        // switch is made, so an order still waiting on it — to be paid at a
        // price it was quoted, or answered, or delivered — would wait for good.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_quoted", "quoted", { merchantId: A, createdAt: 1 }));
        await store.addOrder(anOrder("ord_paid", "paid", { merchantId: A, createdAt: 2 }));
        await store.addOrder(anOrder("ord_owed", "unfulfilled", { merchantId: A, createdAt: 3 }));
        await store.addOrder(anOrder("ord_done", "delivered", { merchantId: A, createdAt: 4 }));
        await store.addOrder(anOrder("ord_theirs", "paid", { merchantId: B, createdAt: 5 }));

        expect(await store.switchIntegration(A, "woocommerce")).toStrictEqual({
          switched: false,
          waiting: ["ord_quoted", "ord_paid"],
        });
        expect((await store.merchantById(A))?.integration).toBe("api");
      });

      it("is not held by an order that owes nothing but money", async () => {
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_owed", "unfulfilled", { merchantId: A }));
        await store.addOrder(anOrder("ord_unpaid", "delivered_unpaid", { merchantId: A }));

        expect((await store.switchIntegration(A, "woocommerce")).switched).toBe(true);
      });

      it("stops selling on the way back to the code where its cards would come back on sale", async () => {
        // An order of the code's asynchronous card is paid before the code
        // answers, and the code may not have run since the shop took over.
        const store = await twoMerchants();
        await store.publishCard(A, card("sku-1", "A room"), 10_000);
        await store.switchIntegration(A, "woocommerce");

        expect(await store.switchIntegration(A, "api")).toStrictEqual({
          switched: true,
          sellingPaused: true,
        });
        expect(await store.selling(A)).toBe("paused");
      });

      it("leaves selling alone on the way back where none of the code's cards would sell", async () => {
        const store = await twoMerchants();
        const paused = await store.publishCard(A, card("sku-1", "A room"), 10_000);
        await store.setCardPaused(A, paused.id, true);
        await store.publishCard(A, card("woo-1", "A mug"), 20_000, "woocommerce");
        await store.switchIntegration(A, "woocommerce");

        expect(await store.switchIntegration(A, "api")).toStrictEqual({
          switched: true,
          sellingPaused: false,
        });
        expect(await store.selling(A)).toBe("open");
      });

      it("writes no order sold through an integration its merchant has left", async () => {
        // The birth of an order and a switch wait for each other on the
        // merchant, so an order read as on sale a moment before the switch is
        // not written after it.
        const store = await twoMerchants();
        await store.switchIntegration(A, "woocommerce");

        expect(await store.addOrder(anOrder("ord_1", "quoted", { merchantId: A }), "api")).toBe(
          false,
        );
        expect(await store.orderById("ord_1")).toBeNull();
        expect(
          await store.addOrder(anOrder("ord_2", "quoted", { merchantId: A }), "woocommerce"),
        ).toBe(true);
        expect(await store.orderById("ord_2")).not.toBeNull();
      });

      it("is refused for a merchant the store does not hold", async () => {
        const store = await twoMerchants();

        await expect(store.switchIntegration("mch_nobody", "api")).rejects.toThrow(/mch_nobody/);
      });
    });

    describe("a merchant", () => {
      it("is written down once, and is not written over by a second attempt", async () => {
        // The sandbox seed runs at every start and finds its merchant already
        // there from the second start on.
        const store = await fresh();

        expect(await store.addMerchant({ id: A, name: "Merchant A" }, 1_000)).toMatchObject({
          id: A,
          name: "Merchant A",
          selling: "open",
        });
        expect(await store.addMerchant({ id: A, name: "Somebody else" }, 2_000)).toBeNull();
        expect((await store.merchantById(A))?.name).toBe("Merchant A");
      });

      it("starts without a live approval and grants it once", async () => {
        const store = await twoMerchants();

        expect((await store.merchantById(A))?.liveApprovedAt).toBeNull();
        expect((await store.merchantById(B))?.liveApprovedAt).toBeNull();

        const first = await store.grantLiveApproval(A, 3_000);
        expect(first).toMatchObject({ changed: true, merchant: { id: A, liveApprovedAt: 3_000 } });

        const repeated = await store.grantLiveApproval(A, 9_000);
        expect(repeated).toMatchObject({
          changed: false,
          merchant: { id: A, liveApprovedAt: 3_000 },
        });
        expect((await store.merchantById(B))?.liveApprovedAt).toBeNull();
        expect(await store.grantLiveApproval("mch_nobody", 4_000)).toBeNull();
      });

      it("lets exactly one concurrent grant choose the immutable first instant", async () => {
        const store = await twoMerchants();

        const grants = await Promise.all([
          store.grantLiveApproval(A, 3_000),
          store.grantLiveApproval(A, 4_000),
        ]);

        expect(grants.filter((grant) => grant?.changed === true)).toHaveLength(1);
        expect(grants.filter((grant) => grant?.changed === false)).toHaveLength(1);
        const approvedAt = grants[0]?.merchant.liveApprovedAt;
        expect([3_000, 4_000]).toContain(approvedAt);
        expect(grants[1]?.merchant.liveApprovedAt).toBe(approvedAt);
        expect((await store.merchantById(A))?.liveApprovedAt).toBe(approvedAt);
      });

      it("is listed under a name for a catalog only where somebody set one", async () => {
        const store = await twoMerchants();

        const made = await store.merchantById(A);
        expect(made?.name).toBe("Merchant A");
        // Never filled in from `name`.
        expect(made?.serviceName).toBeNull();

        expect((await store.setServiceName(A, "Freeland", 3_000))?.serviceName).toBe("Freeland");
        expect((await store.merchantById(A))?.serviceName).toBe("Freeland");

        expect((await store.setServiceName(A, null, 4_000))?.serviceName).toBeNull();
        expect((await store.merchantById(A))?.serviceName).toBeNull();
        expect((await store.merchantById(B))?.serviceName).toBeNull();

        expect(await store.setServiceName("mch_nobody", "Freeland", 5_000)).toBeNull();
      });

      it("has a shop's site only where somebody gave one, and their own", async () => {
        // Agents are sent here with questions the order cannot answer, so a site
        // answered for a merchant who gave none sends them to somebody else's shop.
        const store = await twoMerchants();

        expect((await store.merchantById(A))?.sellerSite).toBeNull();

        expect((await store.setSellerSite(A, "https://freeland.example", 3_000))?.sellerSite).toBe(
          "https://freeland.example",
        );
        expect((await store.merchantById(A))?.sellerSite).toBe("https://freeland.example");
        // Setting the site leaves the listing name alone.
        expect((await store.merchantById(A))?.serviceName).toBeNull();
        expect((await store.merchantById(B))?.sellerSite).toBeNull();

        expect(
          await store.setSellerSite("mch_nobody", "https://freeland.example", 4_000),
        ).toBeNull();
      });

      it("is paid at a wallet only where somebody set one, and at their own, with its split recorded in the same write", async () => {
        // A wrong address here shows up first on a chain, in a payment that
        // cannot be called back. From the moment a wallet is saved a payment
        // may be asked for at its split, whose parameters exist nowhere else
        // until its first payout.
        const store = await twoMerchants();

        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(NO_WALLET);

        // Checksummed, as the caller hands it over: the store normalizes nothing.
        const wallet = paidAt(A, W1);
        const written = await store.setPayoutWallet(A, NO_WALLET, wallet, 3_000);
        expect(
          written === null || written === "moved" ? written : written.merchant.payoutWallet,
        ).toStrictEqual(readBack(wallet, { address: 3_000 }));
        expect(written === null || written === "moved" ? written : written.recorded).toStrictEqual([
          recorded(wallet.split, 3_000),
        ]);
        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(
          readBack(wallet, { address: 3_000 }),
        );
        expect((await store.merchantById(B))?.payoutWallet).toStrictEqual(NO_WALLET);
        // Every address of the row in its checksummed spelling, the one the
        // lookup by wallet is made with.
        const row = await store.payoutSplitAt(wallet.split.address);
        expect(row).toStrictEqual(recorded(wallet.split, 3_000));
        for (const address of [row?.address, row?.merchantWallet, row?.commissionWallet]) {
          expect(address).toMatch(/[A-F]/);
        }

        expect(
          await store.setPayoutWallet("mch_nobody", NO_WALLET, paidAt("mch_nobody", W2), 5_000),
        ).toBeNull();
        expect(await store.payoutSplitAt(splitOf("mch_nobody", W2).address)).toBeNull();
      });

      it("refuses a second first address written over one that landed after it was read, and records neither its split", async () => {
        // Nothing waits on either row, so only comparing the address itself
        // tells them apart. A split recorded by a write that lost its race is
        // one nobody was told of, and every payout would carry it.
        const store = await twoMerchants();
        const first = paidAt(A, W1);
        const second = paidAt(A, W2);
        await store.setPayoutWallet(A, NO_WALLET, first, 3_000);

        expect(await store.setPayoutWallet(A, NO_WALLET, second, 4_000)).toBe("moved");
        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(
          readBack(first, { address: 3_000 }),
        );
        expect(await store.payoutSplitAt(second.split.address)).toBeNull();
      });

      it("keeps a waiting change beside the wallet paid now, with the moment it takes effect and its split recorded already", async () => {
        // Until the waiting change takes effect, sales are paid to the current
        // address. Dropping either half, or moving the instant by a millisecond,
        // would pay the new address early or show the merchant the wrong moment.
        // Nothing writes again when the moment comes, so the split that becomes
        // the payment address then is recorded now, beside the one paid today.
        const store = await twoMerchants();
        const now = paidAt(A, W1);
        await store.setPayoutWallet(A, NO_WALLET, now, 3_000);

        const waiting = waitingFor(A, W1, W2, Date.parse("2026-09-26T12:00:00.123Z"));
        const written = await store.setPayoutWallet(A, now, waiting, 4_000);

        expect(written === null || written === "moved" ? written : written.recorded).toStrictEqual([
          recorded(splitOf(A, W2), 4_000),
        ]);
        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(
          readBack(waiting, { address: 3_000, pending: 4_000 }),
        );
        // Cleared again, as a cancel writes it, and the waiting split stays
        // recorded: a cancel changes which split a payment names, never what
        // is recorded.
        await store.setPayoutWallet(A, waiting, now, 5_000);
        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(
          readBack(now, { address: 3_000 }),
        );
        expect(await store.payoutSplitAt(splitOf(A, W2).address)).toStrictEqual(
          recorded(splitOf(A, W2), 4_000),
        );
      });

      it("writes nothing where the wallet moved after it was read, and says so", async () => {
        // This compare-and-set serializes one merchant's wallet changes: a change
        // recorded between another's read and write must not be overwritten, or
        // the merchant would be shown a different change from the one announced.
        const store = await twoMerchants();
        const now = paidAt(A, W1);
        await store.setPayoutWallet(A, NO_WALLET, now, 3_000);
        const first = waitingFor(A, W1, W2, 90_000);
        const second = waitingFor(A, W1, W3, 95_000);
        await store.setPayoutWallet(A, now, first, 4_000);

        // Both were read as `now`; the first has already been written.
        expect(await store.setPayoutWallet(A, now, second, 5_000)).toBe("moved");
        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(
          readBack(first, { address: 3_000, pending: 4_000 }),
        );
        // And the change that lost recorded no split.
        expect(await store.payoutSplitAt(splitOf(A, W3).address)).toBeNull();

        // The same address with another moment is another row: a restarted
        // clock is a change this write never read.
        const restarted = {
          address: W1,
          pending: { address: W2, takesEffectAt: 99_000 },
        };
        expect(await store.setPayoutWallet(A, restarted, now, 6_000)).toBe("moved");
        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(
          readBack(first, { address: 3_000, pending: 4_000 }),
        );
      });
    });

    describe("a payout split", () => {
      it("is recorded once for a merchant and a wallet, at the instant first written, however often the wallet returns", async () => {
        // No ordinal in the salt, so W1 → W2 → W1 names the first split again:
        // its parameters are already recorded and stay as recorded, and a
        // retried write of the same change records nothing a second time.
        const store = await twoMerchants();
        await store.setPayoutWallet(A, NO_WALLET, paidAt(A, W1), 3_000);
        await store.setPayoutWallet(A, paidAt(A, W1), paidAt(A, W2), 4_000);
        const back = await store.setPayoutWallet(A, paidAt(A, W2), paidAt(A, W1), 5_000);

        expect(back === null || back === "moved" ? back : back.recorded).toStrictEqual([]);
        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(
          readBack(paidAt(A, W1), { address: 3_000 }),
        );
        expect(
          await addressesOf(store.splitsToPayOutFor(BASE_SEPOLIA.network, A, 6_000)),
        ).toStrictEqual([splitOf(A, W1).address]);
        expect(await store.payoutSplitAt(splitOf(A, W2).address)).toStrictEqual(
          recorded(splitOf(A, W2), 4_000),
        );
      });

      it("reads as a wallet's split only the one recorded on the store's own network", async () => {
        // The factory sits at one address on both chains, so a stray row of
        // the other network for the same merchant and wallet is a real
        // contract there; read as the split in force here, it would be the
        // address a buyer is told to pay, on a chain where it means nothing.
        const store = await twoMerchants();
        await store.recordPayoutSplits([splitOf(A, W1, BASE), splitOf(A, W2, BASE)], 2_000);

        const waiting = waitingFor(A, W1, W2, 90_000);
        await store.setPayoutWallet(A, NO_WALLET, waiting, 3_000);

        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(
          readBack(waiting, { address: 3_000 }),
        );
        await store.publishCard(A, card("sku-1", "A's room"), 4_000);
        expect((await store.catalogEntries())[0]?.payoutWallet).toStrictEqual(
          readBack(waiting, { address: 3_000 }),
        );
      });

      it("refuses a wallet written with another network's split, and writes nothing", async () => {
        // A wallet whose split is not this network's would be read as one with
        // no split at all, and its merchant could not sell.
        const store = await twoMerchants();

        await refusedWith(
          store.setPayoutWallet(A, NO_WALLET, paidAt(A, W1, BASE), 3_000),
          /network/,
        );
        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(NO_WALLET);
        expect(await store.networksWithPayoutSplits()).toStrictEqual([]);
      });

      it("keeps two merchants with one wallet on two splits", async () => {
        // One merchant's screen and payout must not show or move another
        // merchant's sales.
        const store = await twoMerchants();
        await store.setPayoutWallet(A, NO_WALLET, paidAt(A, W1), 3_000);
        await store.setPayoutWallet(B, NO_WALLET, paidAt(B, W1), 4_000);

        const theirs = (await store.merchantById(A))?.payoutWallet.split?.address;
        const others = (await store.merchantById(B))?.payoutWallet.split?.address;
        expect(theirs).toBe(splitOf(A, W1).address);
        expect(others).toBe(splitOf(B, W1).address);
        expect(theirs).not.toBe(others);
      });

      it("is found at its address in either spelling, whoever's it is, and nothing is found where none was recorded", async () => {
        // A merchant pasting any merchant's split as their wallet is refused by
        // this lookup, and an agent's client may have written it in lower case.
        const store = await twoMerchants();
        await store.setPayoutWallet(B, NO_WALLET, paidAt(B, W1), 4_000);
        const split = splitOf(B, W1);

        expect(await store.payoutSplitAt(split.address.toLowerCase())).toStrictEqual(
          recorded(split, 4_000),
        );
        expect(await store.payoutSplitAt(splitOf(A, W1).address)).toBeNull();
      });

      it("refuses a wallet given another wallet's or another merchant's split, and writes nothing", async () => {
        // The registry says which wallet each split pays; a wallet written with
        // a split that pays somebody else would send a payment where the
        // merchant was never told.
        const store = await twoMerchants();

        for (const split of [splitOf(A, W2), splitOf(B, W1)]) {
          await refusedWith(
            store.setPayoutWallet(A, NO_WALLET, { address: W1, split, pending: null }, 3_000),
            /split/,
          );
          expect(await store.payoutSplitAt(split.address)).toBeNull();
        }
        await refusedWith(
          store.setPayoutWallet(
            A,
            NO_WALLET,
            {
              address: W1,
              split: splitOf(A, W1),
              pending: { address: W2, takesEffectAt: 90_000, split: splitOf(A, W3) },
            },
            3_000,
          ),
          /split/,
        );
        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(NO_WALLET);
        expect(await store.payoutSplitAt(splitOf(A, W1).address)).toBeNull();
      });

      it("refuses a wallet whose split is already recorded under other parameters, and writes nothing", async () => {
        // The announcement names the split the gateway computed; a write that
        // kept a different recorded one would leave the merchant told of one
        // address while buyers pay another.
        const store = await twoMerchants();
        await store.setPayoutWallet(A, NO_WALLET, paidAt(A, W1), 3_000);
        await store.setPayoutWallet(A, paidAt(A, W1), paidAt(A, W2), 4_000);
        const elsewhere = { ...BASE_SEPOLIA, commissionWallet: W3 };

        await refusedWith(
          store.setPayoutWallet(
            A,
            paidAt(A, W2),
            { address: W1, split: payoutSplitFor(elsewhere, A, W1), pending: null },
            5_000,
          ),
          /recorded/,
        );
        expect((await store.merchantById(A))?.payoutWallet.address).toBe(W2);
        expect(await store.payoutSplitAt(payoutSplitFor(elsewhere, A, W1).address)).toBeNull();
      });

      it("records only the splits not recorded before, and says which", async () => {
        // The start gives a split to every wallet found without one, and a
        // restart, or a second gateway starting beside it, must record each
        // one once and keep its first instant.
        const store = await twoMerchants();
        await store.setPayoutWallet(A, NO_WALLET, paidAt(A, W1), 3_000);

        const first = await store.recordPayoutSplits([splitOf(A, W1), splitOf(B, W2)], 4_000);
        const again = await store.recordPayoutSplits([splitOf(A, W1), splitOf(B, W2)], 5_000);

        expect(first).toStrictEqual([recorded(splitOf(B, W2), 4_000)]);
        expect(again).toStrictEqual([]);
        expect(await store.payoutSplitAt(splitOf(A, W1).address)).toStrictEqual(
          recorded(splitOf(A, W1), 3_000),
        );
        await refusedWith(
          store.recordPayoutSplits(
            [payoutSplitFor({ ...BASE_SEPOLIA, commissionWallet: W3 }, B, W2)],
            6_000,
          ),
          /recorded/,
        );
      });

      it("records a merchant's wallet's split on each network apart", async () => {
        // The chain id is in the salt, so one merchant and wallet have two
        // splits on two networks, and recording one is no reason to refuse
        // the other.
        const store = await twoMerchants();

        const written = await store.recordPayoutSplits(
          [splitOf(A, W1), splitOf(A, W1, BASE)],
          3_000,
        );

        expect(written).toStrictEqual([
          recorded(splitOf(A, W1), 3_000),
          recorded(splitOf(A, W1, BASE), 3_000),
        ]);
      });

      it("refuses a split at an address recorded for another merchant or wallet, in either spelling, and writes nothing", async () => {
        // An address names one contract; recorded twice, it would be two sets
        // of parameters for money only one of them can pay out.
        const store = await twoMerchants();
        const held = splitOf(A, W1);
        await store.recordPayoutSplits([held], 3_000);

        for (const forged of [
          { ...splitOf(B, W2), address: held.address },
          { ...splitOf(B, W1), address: held.address },
          { ...splitOf(A, W2), address: held.address },
          { ...splitOf(B, W2), address: held.address.toLowerCase() },
        ]) {
          await refusedWith(store.recordPayoutSplits([forged], 4_000), /recorded/);
        }
        expect(await store.payoutSplitAt(held.address)).toStrictEqual(recorded(held, 3_000));
        expect(await store.payoutSplitAt(splitOf(B, W2).address)).toBeNull();
        expect(await store.payoutSplitsOn(BASE_SEPOLIA.network)).toStrictEqual([
          recorded(held, 3_000),
        ]);
      });

      it("names every network it holds splits of, and none it does not", async () => {
        // A database moved from the test channel to the live one would name
        // Base Sepolia's splits as Base's payment addresses; the start refuses
        // it on this answer.
        const store = await twoMerchants();
        expect(await store.networksWithPayoutSplits()).toStrictEqual([]);

        await store.recordPayoutSplits([splitOf(A, W1)], 3_000);
        expect(await store.networksWithPayoutSplits()).toStrictEqual([BASE_SEPOLIA.network]);

        await store.recordPayoutSplits([splitOf(B, W1, BASE)], 4_000);
        expect([...(await store.networksWithPayoutSplits())].sort()).toStrictEqual(
          [BASE_SEPOLIA.network, BASE.network].sort(),
        );
      });

      describe("of a wallet stored in another spelling than its row", () => {
        // A wallet may be stored in lower case while its split's row names it
        // in the checksummed spelling the rule makes.
        // One address in two spellings is one wallet: its merchant sells at
        // its split, and it never gets a second one.
        const lower = (wallet: string): string => wallet.toLowerCase();

        it("is that wallet's split, in force and waiting, wherever the merchant is read", async () => {
          const store = await twoMerchants();
          const write: PayoutWalletWrite = {
            address: lower(W1),
            split: splitOf(A, W1),
            pending: { address: lower(W2), takesEffectAt: 90_000, split: splitOf(A, W2) },
          };

          await store.setPayoutWallet(A, NO_WALLET, write, 3_000);
          await store.publishCard(A, card("sku-1", "A's room"), 4_000);

          const asWritten = readBack(write, { address: 3_000 });
          expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(asWritten);
          expect((await store.catalogEntries())[0]?.payoutWallet).toStrictEqual(asWritten);
          expect(
            await addressesOf(store.splitsToPayOutFor(BASE_SEPOLIA.network, A, 89_999)),
          ).toStrictEqual([splitOf(A, W1).address]);
          expect(
            await addressesOf(store.splitsToPayOutFor(BASE_SEPOLIA.network, A, 90_000)),
          ).toStrictEqual([splitOf(A, W2).address]);
        });

        it("is found again by a return to that wallet written in another spelling, and recorded once", async () => {
          const store = await twoMerchants();
          await store.setPayoutWallet(A, NO_WALLET, paidAt(A, W1), 3_000);
          await store.setPayoutWallet(A, paidAt(A, W1), paidAt(A, W2), 4_000);

          const back = await store.setPayoutWallet(
            A,
            paidAt(A, W2),
            { address: lower(W1), split: splitOf(A, W1), pending: null },
            5_000,
          );

          expect(back === null || back === "moved" ? back : back.recorded).toStrictEqual([]);
          expect((await store.merchantById(A))?.payoutWallet.split).toStrictEqual(
            recorded(splitOf(A, W1), 3_000),
          );
        });

        it("is the same split when given again with the wallet in another spelling, and nothing new is recorded", async () => {
          const store = await twoMerchants();
          await store.recordPayoutSplits([splitOf(A, W1)], 3_000);

          const again = await store.recordPayoutSplits(
            [{ ...splitOf(A, W1), merchantWallet: lower(W1) }],
            4_000,
          );

          expect(again).toStrictEqual([]);
          expect(await store.payoutSplitAt(splitOf(A, W1).address)).toStrictEqual(
            recorded(splitOf(A, W1), 3_000),
          );
        });

        it("refuses a split of that wallet in another spelling at another address, and writes nothing", async () => {
          // Two rows for one wallet would let the payment address and the
          // payout instruction name two different contracts.
          const store = await twoMerchants();
          await store.recordPayoutSplits([splitOf(A, W1)], 3_000);
          const second = { ...splitOf(A, W2), merchantWallet: lower(W1) };

          await refusedWith(store.recordPayoutSplits([second], 4_000), /recorded/);
          await refusedWith(
            store.setPayoutWallet(
              A,
              NO_WALLET,
              { address: lower(W1), split: second, pending: null },
              4_000,
            ),
            /recorded/,
          );
          expect(await store.payoutSplitAt(second.address)).toBeNull();
          expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(NO_WALLET);
        });
      });

      describe("that can hold money", () => {
        /**
         * Merchant A: S1 of W1, which was in force and has an order paid to it;
         * S2 of W2, which waited and never took effect, with no order; S3 of
         * W3, in force now; and an order from before splits, paid to the
         * wallet W0 itself. Merchant B: S4 of W1, in force, with an order.
         * Merchant C sells on Base and has nothing on Base Sepolia.
         */
        const W0 = "0x0000000000000000000000000000000000000009";
        const C = "mch_c";
        const paidOrder = (id: string, merchantId: string, payTo: string, createdAt: number) => ({
          ...anOrder(id, "delivered", { merchantId, createdAt }),
          payTo,
        });
        const theRegistry = async (): Promise<Store> => {
          const store = await twoMerchants();
          await store.addMerchant({ id: C, name: "Merchant C" }, 2_500);
          await store.setPayoutWallet(A, NO_WALLET, paidAt(A, W1), 3_000);
          // In the spelling an agent's client may have written it back in.
          await store.addOrder(paidOrder("ord_s1", A, splitOf(A, W1).address.toLowerCase(), 3_100));
          await store.addOrder(paidOrder("ord_w0", A, W0, 3_200));
          await store.setPayoutWallet(A, paidAt(A, W1), waitingFor(A, W1, W2, 90_000), 4_000);
          await store.setPayoutWallet(A, waitingFor(A, W1, W2, 90_000), paidAt(A, W3), 5_000);
          await store.setPayoutWallet(B, NO_WALLET, paidAt(B, W1), 6_000);
          await store.addOrder(paidOrder("ord_s4", B, splitOf(B, W1).address, 6_100));
          // Merchant C sold on Base, as a database moved from one channel to
          // the other holds it: the split is another network's, and an order
          // was paid to it.
          await store.recordPayoutSplits([splitOf(C, W2, BASE)], 7_000);
          await store.addOrder(paidOrder("ord_c", C, splitOf(C, W2, BASE).address, 7_050));
          // An order nobody has paid for yet, which names no address at all.
          await store.addOrder(
            anOrder("ord_unpaid", "quoted", { merchantId: A, createdAt: 7_100 }),
          );
          // A split whose merchant is gone, as one forgotten on the test
          // channel leaves it: nothing of theirs is in force, nothing was
          // paid to it.
          await store.recordPayoutSplits([splitOf("mch_gone", W1)], 7_200);
          return store;
        };

        it("are, for a merchant, the split in force and every one an order of theirs was paid to, and nobody else's", async () => {
          // A merchant who left W1 still has money in S1 from a late
          // settlement; the split that only waited holds nothing and is
          // created by nobody's payout; an order paid to the wallet itself
          // went to no split at all.
          const store = await theRegistry();

          expect(
            await addressesOf(store.splitsToPayOutFor(BASE_SEPOLIA.network, A, 8_000)),
          ).toStrictEqual([splitOf(A, W1).address, splitOf(A, W3).address]);
          expect(
            await addressesOf(store.splitsToPayOutFor(BASE_SEPOLIA.network, B, 8_000)),
          ).toStrictEqual([splitOf(B, W1).address]);
          expect(
            await store.splitsToPayOutFor(BASE_SEPOLIA.network, "mch_nobody", 8_000),
          ).toStrictEqual([]);
          expect(await store.splitsToPayOutFor(BASE.network, A, 8_000)).toStrictEqual([]);
        });

        it("are, for the operator, every split recorded on a network, in the order recorded, and none of another network", async () => {
          // A split no wallet is in force for and no order names may still
          // hold money: one a restore carried over, or one a stray transfer
          // reached. The operator's payout must see it.
          const store = await theRegistry();

          const all = await store.payoutSplitsOn(BASE_SEPOLIA.network);
          expect(all).toStrictEqual([
            recorded(splitOf(A, W1), 3_000),
            recorded(splitOf(A, W2), 4_000),
            recorded(splitOf(A, W3), 5_000),
            recorded(splitOf(B, W1), 6_000),
            recorded(splitOf("mch_gone", W1), 7_200),
          ]);
          expect(await store.payoutSplitsOn(BASE_SEPOLIA.network)).toStrictEqual(all);
          expect(await addressesOf(store.payoutSplitsOn(BASE.network))).toStrictEqual([
            splitOf(C, W2, BASE).address,
          ]);
        });

        it("are in the order they were recorded however they were written, the address settling a tie", async () => {
          // An operator's payout is built in parts of twenty in this order, so
          // two reads of one registry must give the same parts.
          const store = await twoMerchants();
          const tied = ["mch_c", "mch_d", "mch_e"];
          for (const [index, merchantId] of tied.entries()) {
            await store.addMerchant({ id: merchantId, name: merchantId }, 2_500 + index);
          }
          const byAddress = tied
            .map((merchantId) => splitOf(merchantId, W1))
            .sort((one, other) => (one.address < other.address ? -1 : 1));
          const [lowest, middle, highest] = byAddress;
          if (lowest === undefined || middle === undefined || highest === undefined) {
            throw new Error("three splits tie");
          }
          await store.setPayoutWallet(A, NO_WALLET, paidAt(A, W1), 5_000);
          await store.setPayoutWallet(B, NO_WALLET, paidAt(B, W1), 4_000);
          // Three at one instant, written neither in their order nor against it.
          for (const split of [middle, highest, lowest]) {
            await store.setPayoutWallet(
              split.merchantId,
              NO_WALLET,
              paidAt(split.merchantId, W1),
              6_000,
            );
          }

          expect(await addressesOf(store.payoutSplitsOn(BASE_SEPOLIA.network))).toStrictEqual([
            splitOf(B, W1).address,
            splitOf(A, W1).address,
            lowest.address,
            middle.address,
            highest.address,
          ]);
        });

        it("include a waiting split once its moment has passed, and not before", async () => {
          // At its moment the waiting wallet is the one in force with no write
          // in between, and buyers pay its split from then on.
          const store = await twoMerchants();
          await store.setPayoutWallet(A, NO_WALLET, paidAt(A, W1), 3_000);
          await store.setPayoutWallet(A, paidAt(A, W1), waitingFor(A, W1, W2, 90_000), 4_000);

          expect(
            await addressesOf(store.splitsToPayOutFor(BASE_SEPOLIA.network, A, 89_999)),
          ).toStrictEqual([splitOf(A, W1).address]);
          expect(
            await addressesOf(store.splitsToPayOutFor(BASE_SEPOLIA.network, A, 90_000)),
          ).toStrictEqual([splitOf(A, W2).address]);
        });
      });
    });

    describe("a key", () => {
      it("names itself at the door as well as the merchant it belongs to", async () => {
        // A merchant may not disable the key their own call was made with, and
        // only the door knows which key that was.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_a", merchantId: A, label: "A's", digest: "digest-a" }, 1_000);
        await store.addKey({ id: "mk_b", merchantId: B, label: "B's", digest: "digest-b" }, 2_000);

        expect(await store.workingKey("digest-a")).toMatchObject({
          id: "mk_a",
          merchantId: A,
          label: "A's",
          disabledAt: null,
        });
        expect((await store.workingKey("digest-b"))?.merchantId).toBe(B);
      });

      it("is refused once disabled, exactly as a key nobody was issued is", async () => {
        // Told apart, the two would confirm which guesses had once been real keys.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_a", merchantId: A, label: "A's", digest: "digest-a" }, 1_000);

        await store.disableKey("mk_a", 2_000);

        expect(await store.workingKey("digest-a")).toBeNull();
        expect(await store.workingKey("a-digest-nobody-was-issued")).toBeNull();
      });

      it("leaves its merchant's other keys working when it is disabled", async () => {
        const store = await twoMerchants();
        await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);
        await store.addKey({ id: "mk_2", merchantId: A, label: "two", digest: "digest-2" }, 2_000);

        await store.disableKey("mk_1", 3_000);

        expect(await store.workingKey("digest-1")).toBeNull();
        expect((await store.workingKey("digest-2"))?.merchantId).toBe(A);
      });

      it("keeps the instant it was first revoked at when it is revoked again", async () => {
        // A retry after a dropped connection must not move the instant an
        // incident is reconstructed from.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);

        expect((await store.disableKey("mk_1", 2_000))?.disabledAt).toBe(2_000);
        expect((await store.disableKey("mk_1", 9_000))?.disabledAt).toBe(2_000);
      });

      it("is said not to be there rather than disabled quietly", async () => {
        expect(await (await twoMerchants()).disableKey("mk_nope", 1_000)).toBeNull();
      });

      it("is in its own merchant's list, revoked or not, and in nobody else's", async () => {
        const store = await twoMerchants();
        await store.addKey(
          {
            id: "mk_a1",
            merchantId: A,
            label: "one",
            digest: "digest-1",
          },
          1_000,
        );
        await store.addKey(
          {
            id: "mk_a2",
            merchantId: A,
            label: "two",
            digest: "digest-2",
          },
          2_000,
        );
        await store.addKey(
          {
            id: "mk_b1",
            merchantId: B,
            label: "theirs",
            digest: "digest-3",
          },
          3_000,
        );
        await store.disableKey("mk_a2", 4_000);

        expect((await store.keysOf(A)).map((key) => key.id)).toStrictEqual(["mk_a1", "mk_a2"]);
        expect((await store.keysOf(B)).map((key) => key.id)).toStrictEqual(["mk_b1"]);
      });

      it("is listed oldest first, with the identifier settling a tie", async () => {
        // The one list here whose order the port promises, because a merchant
        // reads it on a screen. Two keys issued in one sitting often share a
        // millisecond, and the keys go in an order that is neither answer.
        const store = await twoMerchants();
        await store.addKey(
          {
            id: "mk_z",
            merchantId: A,
            label: "written first",
            digest: "d1",
          },
          1_000,
        );
        await store.addKey(
          {
            id: "mk_a",
            merchantId: A,
            label: "written second",
            digest: "d2",
          },
          1_000,
        );
        await store.addKey(
          {
            id: "mk_older",
            merchantId: A,
            label: "made earlier",
            digest: "d3",
          },
          500,
        );

        expect((await store.keysOf(A)).map((key) => key.id)).toStrictEqual([
          "mk_older",
          "mk_a",
          "mk_z",
        ]);
      });

      it("is disabled by the merchant it belongs to and by nobody else", async () => {
        // What the dashboard calls. "Not yours" and "not there" are one answer,
        // or a merchant walking identifiers would learn which keys are real.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_a", merchantId: A, label: "A's", digest: "digest-a" }, 1_000);
        await store.addKey({ id: "mk_b", merchantId: B, label: "B's", digest: "digest-b" }, 1_000);

        expect(await store.disableKeyOf(A, "mk_a", 2_000)).toMatchObject({ disabledAt: 2_000 });
        expect(await store.disableKeyOf(A, "mk_b", 2_000)).toBeNull();
        expect(await store.disableKeyOf(A, "mk_nobody_was_issued", 2_000)).toBeNull();

        expect((await store.workingKey("digest-b"))?.id).toBe("mk_b");
        // A retry keeps the first revocation's instant here too.
        expect(await store.disableKeyOf(A, "mk_a", 9_000)).toMatchObject({ disabledAt: 2_000 });
      });

      it("is found by its digest whatever state it is in, which the door is not", async () => {
        // The seed asks this, and would otherwise reissue a taken digest every
        // time it ran after somebody disabled its key.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);
        await store.disableKey("mk_1", 2_000);

        expect((await store.keyByDigest("digest-1"))?.id).toBe("mk_1");
        expect(await store.keyByDigest("a-digest-nobody-was-issued")).toBeNull();
      });

      it("is refused for a merchant that is not there", async () => {
        // The wording is not asserted: the driver's message carries every bound
        // parameter, so matching the merchant's name would pass on a leak.
        const store = await twoMerchants();

        await expect(
          store.addKey(
            {
              id: "mk_1",
              merchantId: "mch_nobody",
              label: "one",
              digest: "d",
            },
            1_000,
          ),
        ).rejects.toThrow();
        expect(await store.workingKey("d")).toBeNull();
      });

      it("is refused under an identifier another key already has", async () => {
        // A clash is our defect, never a merchant's, but it must not silently
        // replace a key that is still in somebody's configuration.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);

        await expect(
          store.addKey(
            {
              id: "mk_1",
              merchantId: B,
              label: "theirs",
              digest: "digest-2",
            },
            2_000,
          ),
        ).rejects.toThrow(/the key mk_1 is already written down/);

        expect((await store.workingKey("digest-1"))?.id).toBe("mk_1");
        expect(await store.workingKey("digest-2")).toBeNull();
      });

      it("is refused under a digest another key already has", async () => {
        // The door resolves a request by digest alone, so one digest on two keys
        // is one secret opening two merchants' doors. The issuing command checks
        // `keyByDigest` first; this is what holds when two issues race.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);

        await expect(
          store.addKey(
            {
              id: "mk_2",
              merchantId: B,
              label: "theirs",
              digest: "digest-1",
            },
            2_000,
          ),
        ).rejects.toThrow(/a key with that digest is already written down/);

        expect((await store.workingKey("digest-1"))?.id).toBe("mk_1");
        expect((await store.keysOf(B)).map((key) => key.id)).toStrictEqual([]);
      });

      it("is refused without ever saying the digest out loud", async () => {
        // The driver's refusal carries the digest in its bound parameters and its
        // detail line, so a store that passed that error along, even as a cause,
        // would log a stored secret. Both refusals are read: the insert carries
        // the digest whichever rule turned it away.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);

        const forTheIdentifier = await refusalOf(
          store.addKey(
            {
              id: "mk_1",
              merchantId: B,
              label: "theirs",
              digest: "digest-2",
            },
            2_000,
          ),
        );
        const forTheDigest = await refusalOf(
          store.addKey(
            {
              id: "mk_2",
              merchantId: B,
              label: "theirs",
              digest: "digest-1",
            },
            3_000,
          ),
        );

        expect(asLogged(forTheIdentifier)).not.toContain("digest-2");
        expect(asLogged(forTheDigest)).not.toContain("digest-1");
      });

      it("is made with no call recorded against it", async () => {
        // Null means no call was recorded, not that none was made.
        const store = await twoMerchants();

        const made = await store.addKey(
          { id: "mk_1", merchantId: A, label: "one", digest: "digest-1" },
          1_000,
        );

        expect(made.lastUsedAt).toBeNull();
      });

      it("carries the instant of the last call made with it, and no other key's", async () => {
        // A merchant reads this to decide which key can be revoked, so one key's
        // use must not mark another.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);
        await store.addKey({ id: "mk_2", merchantId: A, label: "two", digest: "digest-2" }, 2_000);

        await store.noteKeyUse("mk_1", 5_000);

        expect((await store.workingKey("digest-1"))?.lastUsedAt).toBe(5_000);
        expect((await store.workingKey("digest-2"))?.lastUsedAt).toBeNull();
      });

      it("keeps the later call when two of them are written down out of order", async () => {
        // Several gateway processes write this from their own clocks without
        // serialising, so an older instant can arrive after a newer one.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);

        await store.noteKeyUse("mk_1", 9_000);
        await store.noteKeyUse("mk_1", 5_000);

        expect((await store.workingKey("digest-1"))?.lastUsedAt).toBe(9_000);
      });

      it("keeps the call it last carried when it is revoked", async () => {
        // The revoked key stays listed, and the mark is the evidence the
        // revocation was decided on.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);
        await store.noteKeyUse("mk_1", 5_000);

        expect((await store.disableKey("mk_1", 7_000))?.lastUsedAt).toBe(5_000);
        expect((await store.keysOf(A))[0]?.lastUsedAt).toBe(5_000);
      });
    });

    describe("an order", () => {
      it("is written once under one identifier, and a second attempt is refused", async () => {
        // A second write would replace the order an agent holds an identifier
        // for. Both adapters must refuse in their own words, not a driver's.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "created"));

        await expect(store.addOrder(anOrder("ord_1", "quoted"))).rejects.toThrow(
          /already written down/,
        );
        expect((await store.orderById("ord_1"))?.order.state).toBe("created");
      });

      it("is said not to be there rather than thrown about", async () => {
        const store = await twoMerchants();

        expect(await store.withOrder("ord_nope", () => ({ result: 1 }))).toStrictEqual({
          found: false,
        });
      });

      it("is held still, so two decisions cannot both write over the same read", async () => {
        // Two events about one order (a payment and a deadline, an answer and a
        // redelivery) arrive at once all the time, and a lost update here is a
        // double charge. The pause stands in for a real transaction's length; the
        // results are sorted because the port promises no overlap, not an order.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "created"));

        const bump = () =>
          store.withOrder("ord_1", async (found) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            const attempts = found.order.dispatch.attempts + 1;
            return {
              save: {
                ...found,
                order: { ...found.order, dispatch: { attempts, accepted: false } },
              },
              result: attempts,
            };
          });

        const decided = await Promise.all([bump(), bump(), bump()]);

        // A numeric comparator: the default sort compares as text, which goes
        // wrong past nine.
        expect(
          decided
            .map((lookup) => (lookup.found ? lookup.result : null))
            .sort((one, other) => Number(one) - Number(other)),
        ).toStrictEqual([1, 2, 3]);
        expect((await store.orderById("ord_1"))?.order.dispatch.attempts).toBe(3);
      });

      it("does not make one order wait on another", async () => {
        // On Postgres a `for update` whose predicate matches more than one row
        // locks them all, and every decision would queue behind the slowest
        // order. The first decision is held open and the second gets two seconds.
        //
        // Both are released and awaited in `finally`: a transaction left holding
        // a row would stall the next test's truncate, and the failure would land
        // there instead of here.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "created", { createdAt: 1_000 }));
        await store.addOrder(anOrder("ord_2", "created", { createdAt: 2_000 }));

        let releaseFirst: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });

        const first = store.withOrder("ord_1", async () => {
          await held;
          return { result: "first" };
        });
        const second = store.withOrder("ord_2", () => ({ result: "second" }));

        try {
          expect(await answeredWithin(2_000, second)).toStrictEqual({
            found: true,
            result: "second",
          });
        } finally {
          releaseFirst();
          await Promise.allSettled([first, second]);
        }

        expect(await first).toStrictEqual({ found: true, result: "first" });
        expect(await second).toStrictEqual({ found: true, result: "second" });
      });

      it("is still there to decide about after a decision about it failed", async () => {
        // Otherwise the order is stuck for good: no deadline closes it and
        // nobody is told. Memory must catch its promise chain, and Postgres must
        // release the row lock on rollback.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "created"));

        const broken = store.withOrder("ord_1", () => {
          throw new Error("the decision blew up");
        });
        await expect(broken).rejects.toThrow("the decision blew up");

        expect(await store.withOrder("ord_1", () => ({ result: "still here" }))).toStrictEqual({
          found: true,
          result: "still here",
        });
        expect((await store.orderById("ord_1"))?.order.state).toBe("created");
      });

      it("is not written when the decision asked for nothing to be written", async () => {
        // A store that wrote back what the decision held, rather than what it
        // asked to save, would let a read overwrite whatever landed meanwhile.
        // The order is read back both plainly and through a second decision
        // because each adapter reaches them by different routes. A byte-identical
        // write-back is invisible here; the database file checks the row itself.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "created"));

        await store.withOrder("ord_1", (found) => ({
          result: { ...found, order: { ...found.order, state: "cancelled" as const } },
        }));

        expect((await store.orderById("ord_1"))?.order.state).toBe("created");
        expect(
          await store.withOrder("ord_1", (found) => ({ result: found.order.state })),
        ).toStrictEqual({ found: true, result: "created" });
      });

      it("is not found by another merchant, and is not written by one either", async () => {
        // Ownership is read under the same lock as the order, and the answer is
        // an unknown identifier's, so trying one found in a log reveals nothing.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "created", { merchantId: B }));

        const asA = await store.withOrder(
          "ord_1",
          (found) => ({
            save: { ...found, order: { ...found.order, state: "cancelled" as const } },
            result: "moved it",
          }),
          { merchantId: A },
        );

        expect(asA).toStrictEqual({ found: false });
        expect((await store.orderById("ord_1"))?.order.state).toBe("created");
      });

      it("does not change hands because a decision about it said so", async () => {
        // Postgres leaves the merchant column out of its update, so a save
        // carrying another merchant would split the document from the column:
        // an order in one merchant's list whose envelopes go on another's stream.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "created"));

        await store.withOrder("ord_1", (found) => ({
          save: { ...found, merchantId: B, order: { ...found.order, state: "quoted" as const } },
          result: null,
        }));

        expect((await store.orderById("ord_1"))?.merchantId).toBe(A);
        expect(await idsOf(store.orders(A))).toStrictEqual(["ord_1"]);
        expect(await store.orders(B)).toStrictEqual([]);
        expect((await store.merchantOrder(A, "ord_1"))?.order.id).toBe("ord_1");
        expect(await store.merchantOrder(B, "ord_1")).toBeNull();
        // The rest of the save did land.
        expect((await store.orderById("ord_1"))?.order.state).toBe("quoted");
      });

      it("is its own merchant's to read, and the buying surface's whoever asks", async () => {
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_mine", "created", { createdAt: 1_000 }));
        await store.addOrder(anOrder("ord_theirs", "created", { merchantId: B, createdAt: 2_000 }));

        expect((await store.merchantOrder(A, "ord_mine"))?.order.id).toBe("ord_mine");
        expect(await store.merchantOrder(A, "ord_theirs")).toBeNull();
        // Unscoped on purpose: the buying route takes no key, and the payment
        // presented stands in for one.
        expect((await store.orderById("ord_theirs"))?.order.id).toBe("ord_theirs");
      });

      it("is found by its payment reference, whoever's it is, and by nothing else", async () => {
        // The payment route finds the order a payment is for by the reference
        // its challenge carried, and takes no key. The order's own identifier
        // is not a reference, so a payment naming it is bound to nothing.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "quoted", { paymentRef: "pay_1", createdAt: 1_000 }));
        await store.addOrder(
          anOrder("ord_2", "quoted", { merchantId: B, paymentRef: "pay_2", createdAt: 2_000 }),
        );

        expect((await store.orderByPaymentRef("pay_1"))?.order.id).toBe("ord_1");
        expect((await store.orderByPaymentRef("pay_2"))?.order.id).toBe("ord_2");
        expect(await store.orderByPaymentRef("ord_2")).toBeNull();
        expect(await store.orderByPaymentRef("pay_3")).toBeNull();

        // A decision about the order rewrites its document and keeps the reference.
        await store.withOrder("ord_2", (found) => ({
          save: { ...found, order: { ...found.order, state: "paid" as const } },
          result: null,
        }));
        expect((await store.orderByPaymentRef("pay_2"))?.order.state).toBe("paid");
      });

      it("refuses a second order under a payment reference another order has", async () => {
        // Otherwise one payment could be bound to either of two orders.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "quoted", { paymentRef: "pay_1" }));

        await expect(
          store.addOrder(anOrder("ord_2", "quoted", { paymentRef: "pay_1" })),
        ).rejects.toThrow(/payment reference/);
        expect(await store.orderById("ord_2")).toBeNull();
        expect((await store.orderByPaymentRef("pay_1"))?.order.id).toBe("ord_1");
      });

      it("keeps orders written without a payment reference apart, and finds none of them by one", async () => {
        // An order written before references were issued has none until the
        // migration gives it one, and two of them do not share one.
        const store = await twoMerchants();
        const withoutAReference = (id: string, createdAt: number) => {
          const { paymentRef: _none, ...written } = anOrder(id, "delivered", { createdAt });
          return written as StoredOrder;
        };
        await store.addOrder(withoutAReference("ord_1", 1_000));
        await store.addOrder(withoutAReference("ord_2", 2_000));

        expect(await idsOf(store.orders(A))).toStrictEqual(["ord_1", "ord_2"]);
        expect(await store.orderByPaymentRef("undefined")).toBeNull();
      });

      it("is listed among the ones still owed something, or apart from them", async () => {
        // Open includes a debt and goods delivered unpaid. Postgres answers from
        // a column written on save and memory from the state, so this catches a
        // column that fell behind the document.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_open", "dispatched", { createdAt: 1_000 }));
        await store.addOrder(anOrder("ord_debt", "unfulfilled", { createdAt: 2_000 }));
        await store.addOrder(anOrder("ord_unpaid", "delivered_unpaid", { createdAt: 3_000 }));
        await store.addOrder(anOrder("ord_done", "delivered", { createdAt: 4_000 }));
        // Another merchant's open order, which must be in neither of A's lists.
        await store.addOrder(
          anOrder("ord_theirs", "dispatched", { merchantId: B, createdAt: 5_000 }),
        );

        expect(await idsOf(store.orders(A, { open: true }))).toStrictEqual([
          "ord_debt",
          "ord_open",
          "ord_unpaid",
        ]);
        expect(await store.orders(A)).toHaveLength(4);
        expect(await idsOf(store.orders(B))).toStrictEqual(["ord_theirs"]);

        // Every order above was inserted in its final state, so only closing one
        // through a decision catches a store that decides "open" at insert alone.
        await store.withOrder("ord_open", (found) => ({
          save: { ...found, order: { ...found.order, state: "expired" as const } },
          result: null,
        }));

        expect(await idsOf(store.orders(A, { open: true }))).toStrictEqual([
          "ord_debt",
          "ord_unpaid",
        ]);
        // Closed is not deleted.
        expect(await store.orders(A)).toHaveLength(4);
      });
      it("is listed while its payment completed after the merchant closed it, until they close it again", async () => {
        // The merchant is told by an event that is sent at most once, so the
        // open list is where such an order is found again. It holds no switch
        // of integration: nothing of it waits on a handler.
        const store = await twoMerchants();
        const closed = anOrder("ord_closed_paid_later", "fulfillment_closed");
        await store.addOrder({
          ...closed,
          order: {
            ...closed.order,
            payment: "settled",
            merchantClosure: { at: 1_000, paymentCompletedAt: 2_000 },
          },
        });
        await store.addOrder(anOrder("ord_closed", "fulfillment_closed", { createdAt: 2_000 }));

        expect(await idsOf(store.orders(A, { open: true }))).toStrictEqual([
          "ord_closed_paid_later",
        ]);
        expect((await store.switchIntegration(A, "woocommerce")).switched).toBe(true);
        await store.switchIntegration(A, "api");

        await store.withOrder("ord_closed_paid_later", (found) => ({
          save: { ...found, order: { ...found.order, merchantClosure: { at: 3_000 } } },
          result: null,
        }));
        expect(await idsOf(store.orders(A, { open: true }))).toStrictEqual([]);
      });
    });

    describe("a payment", () => {
      it("rolls claim retention back when another write in the order transaction fails", async () => {
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "quoted"));
        await store.claimPayment("fp-rollback", "ord_1");
        await expect(
          store.withOrder("ord_1", (found) => ({
            save: { ...found, order: { ...found.order, state: "delivered" } },
            alongside: [
              { kind: "retain_payment", fingerprint: "fp-rollback", orderId: "ord_1" },
              { kind: "retain_payment", fingerprint: "fp-missing", orderId: "ord_1" },
            ],
            result: null,
          })),
        ).rejects.toThrow("claim");
        await store.releaseClaim("fp-rollback", "ord_1");
        expect(await store.claimPayment("fp-rollback", "ord_2")).toEqual({ claimed: true });
        expect((await store.orderById("ord_1"))?.order.state).toBe("quoted");
      });

      it("refuses acceptance if another order obtained the claim before its transaction retained it", async () => {
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "quoted"));
        await store.claimPayment("fp-racing", "ord_1");
        let release: () => void = () => undefined;
        let entered: () => void = () => undefined;
        const waiting = new Promise<void>((resolve) => {
          release = resolve;
        });
        const read = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const accepting = store.withOrder("ord_1", async (found) => {
          entered();
          await waiting;
          return {
            save: { ...found, order: { ...found.order, state: "delivered" as const } },
            alongside: [
              { kind: "retain_payment" as const, fingerprint: "fp-racing", orderId: "ord_1" },
            ],
            result: null,
          };
        });
        await read;
        await store.releaseClaim("fp-racing", "ord_1");
        expect(await store.claimPayment("fp-racing", "ord_2")).toEqual({ claimed: true });
        release();
        await expect(accepting).rejects.toThrow("claim");
        expect((await store.orderById("ord_1"))?.order.state).toBe("quoted");
      });

      it("keeps an accepted authorization bound to its order after pruning and release", async () => {
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "quoted"));
        await store.claimPayment("fp-retained", "ord_1");
        await store.withOrder("ord_1", (found) => ({
          save: found,
          alongside: [{ kind: "retain_payment", fingerprint: "fp-retained", orderId: "ord_1" }],
          result: null,
        }));
        await store.releaseClaim("fp-retained", "ord_1");
        await store.forgetClaimsBefore(Date.now() + 60_000);
        expect(await store.claimPayment("fp-retained", "ord_2")).toEqual({
          claimed: false,
          heldBy: "ord_1",
        });
      });

      it("does not write an order whose payment claim no longer belongs to it", async () => {
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "quoted"));
        await store.claimPayment("fp-other", "ord_2");
        await expect(
          store.withOrder("ord_1", (found) => ({
            save: { ...found, order: { ...found.order, state: "delivered" } },
            alongside: [{ kind: "retain_payment", fingerprint: "fp-other", orderId: "ord_1" }],
            result: null,
          })),
        ).rejects.toThrow("claim");
        expect((await store.orderById("ord_1"))?.order.state).toBe("quoted");
      });

      it("finds unanswered charges in bounded order including purchases closed on silence", async () => {
        const store = await twoMerchants();
        for (const [id, state, payment] of [
          ["ord_a", "rejected", "outcome_unknown"],
          ["ord_b", "quoted", "settling"],
          ["ord_c", "delivered", "settled"],
        ] as const) {
          const record = anOrder(id, state);
          await store.addOrder({
            ...record,
            payment: "SAVED",
            order: { ...record.order, payment },
          });
        }
        expect((await store.unresolvedPayments("", 1)).map((record) => record.order.id)).toEqual([
          "ord_a",
        ]);
        expect(
          (await store.unresolvedPayments("ord_a", 1)).map((record) => record.order.id),
        ).toEqual(["ord_b"]);
        expect(await store.unresolvedPayments("ord_b", 1)).toEqual([]);
        expect((await store.paymentOrders("ord_b", 1)).map((record) => record.order.id)).toEqual([
          "ord_c",
        ]);
      });

      it("belongs to the first order that presented it, and to no other", async () => {
        // The replay guard: a signed payment does not name its purchase, so
        // without this one signature pays for two orders at the same price.
        const store = await twoMerchants();

        expect(await store.claimPayment("fp-1", "ord_1")).toStrictEqual({ claimed: true });
        expect(await store.claimPayment("fp-1", "ord_2")).toStrictEqual({
          claimed: false,
          heldBy: "ord_1",
        });
        // The refusal moved nothing: the order that holds it still presents it.
        expect(await store.claimPayment("fp-1", "ord_1")).toStrictEqual({ claimed: true });
        expect(await store.claimPayment("fp-2", "ord_2")).toStrictEqual({ claimed: true });
      });

      it("is presented again by its own order without complaint", async () => {
        // A retry after a dropped connection is ordinary, and the portal promises
        // that repeating a call is safe.
        const store = await twoMerchants();
        await store.claimPayment("fp-1", "ord_1");

        expect(await store.claimPayment("fp-1", "ord_1")).toStrictEqual({ claimed: true });
      });

      it("is let go by the order holding it and by nobody else", async () => {
        // The claim is taken before the ownership decision, so a presentation
        // the decision turns away must give it back. Only the holder may, or one
        // buyer could free another buyer's signature.
        const store = await twoMerchants();
        expect(await store.claimPayment("fp-1", "ord_1")).toStrictEqual({ claimed: true });

        await store.releaseClaim("fp-1", "ord_2");
        expect(await store.claimPayment("fp-1", "ord_2")).toStrictEqual({
          claimed: false,
          heldBy: "ord_1",
        });

        await store.releaseClaim("fp-1", "ord_1");
        expect(await store.claimPayment("fp-1", "ord_2")).toStrictEqual({ claimed: true });
      });

      it("is forgotten once it is older than the instant asked about", async () => {
        // Claims come through a keyless route, so kept forever they fill the
        // table; swept early, the replay guard is off for a payment still being
        // charged. Each adapter stamps a claim with its own clock, so the two sit
        // real time either side of an instant, and the sweep is asked about that
        // instant: the extremes alone would pass a sweep that ignored it.
        const store = await twoMerchants();

        await store.claimPayment("fp-old", "ord_1");
        await new Promise((resolve) => setTimeout(resolve, 25));
        const between = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 25));
        await store.claimPayment("fp-fresh", "ord_2");

        expect(await store.forgetClaimsBefore(Date.now() - 60_000)).toBe(0);

        expect(await store.forgetClaimsBefore(between)).toBe(1);
        expect(await store.claimPayment("fp-old", "ord_3")).toStrictEqual({ claimed: true });
        expect(await store.claimPayment("fp-fresh", "ord_3")).toStrictEqual({
          claimed: false,
          heldBy: "ord_2",
        });

        // Two, because the older fingerprint was claimed again above.
        expect(await store.forgetClaimsBefore(Date.now() + 60_000)).toBe(2);
        expect(await store.claimPayment("fp-fresh", "ord_3")).toStrictEqual({ claimed: true });
      });
    });

    describe("a receipt", () => {
      it("is one per order and is found by the order", async () => {
        const store = await twoMerchants();
        const receipt = aReceipt("rcp_1", "ord_1", "delivered");

        await store.putReceipt(A, receipt);

        expect(await store.receiptForOrder("ord_1")).toStrictEqual(receipt);
        expect(await store.receiptForOrder("ord_2")).toBeNull();
        expect(await store.receipts(A)).toHaveLength(1);
      });

      it("is in its own merchant's list and in nobody else's", async () => {
        const store = await twoMerchants();

        await store.putReceipt(A, aReceipt("rcp_1", "ord_1", "delivered"));
        await store.putReceipt(B, aReceipt("rcp_2", "ord_2", "delivered"));

        expect((await store.receipts(A)).map((held) => held.id)).toStrictEqual(["rcp_1"]);
        expect((await store.receipts(B)).map((held) => held.id)).toStrictEqual(["rcp_2"]);
        // Unscoped on purpose: the agent reads its receipt without a key.
        expect((await store.receiptForOrder("ord_2"))?.id).toBe("rcp_2");
      });

      it("does not change hands when it is written again", async () => {
        // A receipt is written again as its order moves on. Both adapters keep
        // the first merchant by omission (Postgres leaves it out of its upsert),
        // which nothing else would catch.
        const store = await twoMerchants();
        await store.putReceipt(A, aReceipt("rcp_1", "ord_1", "delivered"));

        // Written again, and named for the wrong merchant.
        await store.putReceipt(B, aReceipt("rcp_1", "ord_1", "unfulfilled"));

        expect((await store.receipts(A)).map((held) => held.outcome)).toStrictEqual([
          "unfulfilled",
        ]);
        expect(await store.receipts(B)).toStrictEqual([]);
      });
    });
  });
}

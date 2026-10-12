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
import type { Store, StoredOrder } from "../ports/store.js";

/** The merchant almost everything here belongs to, because a card needs one. */
const A = "mch_a";
/** A second one, for the cases whose subject is that the two cannot see each other. */
const B = "mch_b";

/** A merchant paid nowhere, with nothing waiting: where every merchant starts. */
const NO_WALLET = { address: null, pending: null } as const;

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
const anOrder = (
  id: string,
  state: Order["state"],
  at: { readonly merchantId?: string; readonly createdAt?: number } = {},
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
 * empty, and must allow two decisions in flight at once: on a pool of one
 * connection the second would wait for the connection rather than the lock and
 * be reported as a locking defect.
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

      it("carries where each card's merchant is paid, and nothing where none is set", async () => {
        // Whether a card may be offered turns on this: a catalog read that lost
        // the address would list cards no live purchase can complete.
        const store = await twoMerchants();
        await store.publishCard(A, card("sku-1", "A's room"), 10_000);
        await store.publishCard(B, card("sku-1", "B's room"), 20_000);
        const paid = {
          address: "0x0000000000000000000000000000000000000009",
          // Once its moment passes, a waiting change is the address a sale is
          // paid at, so it travels too.
          pending: { address: "0x0000000000000000000000000000000000000008", takesEffectAt: 90_000 },
        };
        await store.setPayoutWallet(A, NO_WALLET, paid, 30_000);

        const entries = await store.catalogEntries();

        expect(entries.find((entry) => entry.card.merchantId === A)?.payoutWallet).toStrictEqual(
          paid,
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

      it("is paid at a wallet only where somebody set one, and at their own", async () => {
        // A wrong address here shows up first on a chain, in a payment that
        // cannot be called back.
        const store = await twoMerchants();

        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(NO_WALLET);

        // Checksummed, as the caller hands it over: the store normalizes nothing.
        const wallet = { address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", pending: null };
        const written = await store.setPayoutWallet(A, NO_WALLET, wallet, 3_000);
        expect(
          written === null || written === "moved" ? written : written.payoutWallet,
        ).toStrictEqual(wallet);
        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(wallet);
        expect((await store.merchantById(B))?.payoutWallet).toStrictEqual(NO_WALLET);

        expect(await store.setPayoutWallet("mch_nobody", NO_WALLET, wallet, 5_000)).toBeNull();
      });

      it("refuses a second first address written over one that landed after it was read", async () => {
        // Nothing waits on either row, so only comparing the address itself
        // tells them apart.
        const store = await twoMerchants();
        const first = { address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", pending: null };
        const second = { address: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", pending: null };
        await store.setPayoutWallet(A, NO_WALLET, first, 3_000);

        expect(await store.setPayoutWallet(A, NO_WALLET, second, 4_000)).toBe("moved");
        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(first);
      });

      it("keeps a waiting change beside the wallet paid now, with the moment it takes effect", async () => {
        // Until the waiting change takes effect, sales are paid to the current
        // address. Dropping either half, or moving the instant by a millisecond,
        // would pay the new address early or show the merchant the wrong moment.
        const store = await twoMerchants();
        const now = { address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", pending: null };
        await store.setPayoutWallet(A, NO_WALLET, now, 3_000);

        const waiting = {
          address: now.address,
          pending: {
            address: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
            takesEffectAt: Date.parse("2026-09-26T12:00:00.123Z"),
          },
        };
        await store.setPayoutWallet(A, now, waiting, 4_000);

        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(waiting);
        // Cleared again, as a cancel writes it.
        await store.setPayoutWallet(A, waiting, now, 5_000);
        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(now);
      });

      it("writes nothing where the wallet moved after it was read, and says so", async () => {
        // This compare-and-set serializes one merchant's wallet changes: a change
        // recorded between another's read and write must not be overwritten, or
        // the merchant would be shown a different change from the one announced.
        const store = await twoMerchants();
        const now = { address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", pending: null };
        await store.setPayoutWallet(A, NO_WALLET, now, 3_000);
        const first = {
          address: now.address,
          pending: { address: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", takesEffectAt: 90_000 },
        };
        const second = {
          address: now.address,
          pending: { address: "0x0000000000000000000000000000000000000007", takesEffectAt: 95_000 },
        };
        await store.setPayoutWallet(A, now, first, 4_000);

        // Both were read as `now`; the first has already been written.
        expect(await store.setPayoutWallet(A, now, second, 5_000)).toBe("moved");
        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(first);

        // The same address with another moment is another row: a restarted
        // clock is a change this write never read.
        const restarted = { ...first, pending: { ...first.pending, takesEffectAt: 99_000 } };
        expect(await store.setPayoutWallet(A, restarted, now, 6_000)).toBe("moved");
        expect((await store.merchantById(A))?.payoutWallet).toStrictEqual(first);
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

      it("is listed among the ones still owed something, or apart from them", async () => {
        // Open includes a debt and goods delivered unpaid. Postgres answers from
        // a column written on save and memory from the state, so this catches a
        // column that fell behind the document.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_open", "dispatched", { createdAt: 1_000 }));
        await store.addOrder(anOrder("ord_debt", "refund_due", { createdAt: 2_000 }));
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
    });

    describe("a payment", () => {
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
        await store.putReceipt(B, aReceipt("rcp_1", "ord_1", "refund_due"));

        expect((await store.receipts(A)).map((held) => held.outcome)).toStrictEqual(["refund_due"]);
        expect(await store.receipts(B)).toStrictEqual([]);
      });
    });
  });
}

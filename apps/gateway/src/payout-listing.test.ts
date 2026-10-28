/**
 * The operator's payout, as Money lists it: Agentify is paid only when
 * somebody sends it, and nothing here signs or sends, so what it lists must be
 * exactly the transactions the builder makes from the splits as recorded, and
 * nothing where the gateway would refuse those splits.
 *
 * Each case builds its gateway over a store prepared first, and never starts
 * it: the listing is built beside a gateway and takes no work off its queue.
 */

import { deadlines } from "@agentify/core";
import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingAnnouncer } from "./adapters/memory/announcer.js";
import { ScriptedFacilitator } from "./adapters/memory/facilitator.js";
import { MemoryQueue } from "./adapters/memory/queue.js";
import { MemoryStore } from "./adapters/memory/store.js";
import { Gateway } from "./app/gateway.js";
import { setServiceName } from "./app/merchants.js";
import { loadConfig } from "./config.js";
import { widestChallengeOn } from "./http/x402.js";
import { type PayoutListing, payoutListing } from "./payout-listing.js";
import { DISTRIBUTOR } from "./split/fixture.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "./split/networks.js";
import { payoutSplitFor } from "./split/parameters.js";
import { operatorPayouts } from "./split/payout.js";
import { countedIds } from "./testing/harness.js";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");

const T1 = PAYOUT_SPLIT_NETWORKS;
const T1_TEST = payoutSplitNetworkOf(T1, "eip155:84532");

/** Goods that arrive after the purchase, so the payment is taken before anything is delivered. */
const lateGoods: Card = {
  merchant_item_id: "esim-7d",
  title: "A seven day eSIM",
  description: "Seven days of data",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
};

let running: Gateway | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
});

/** An empty store and its queue, opened for the network a gateway over it takes payments on. */
const aDatabase = (network = T1_TEST.network) => {
  const queue = new MemoryQueue();
  const store = new MemoryStore(network, countedIds(), () => NOW, queue.envelopes());
  return { store, queue };
};

/** A gateway over that database, made and never started, as a command makes one. */
const aGatewayOver = (
  database: ReturnType<typeof aDatabase>,
  environment: Record<string, string> = {},
): Gateway => {
  const config = loadConfig({
    PRICE_STAMP_KEY: "test-only-price-stamp-key-at-least-32-bytes",
    DATABASE_URL: "postgres://agentify@localhost:5432/agentify",
    ...environment,
  });
  running = new Gateway({
    config,
    store: database.store,
    queue: database.queue,
    facilitator: new ScriptedFacilitator(),
    clock: () => NOW,
    ids: countedIds(),
    announcer: new RecordingAnnouncer(),
    widestChallenge: widestChallengeOn(config),
  });
  return running;
};

/**
 * A merchant paid at `wallet`, with its split recorded under the table, as a
 * wallet write records it, and a worker that has just polled.
 */
const aMerchantPaidAt = async (
  database: ReturnType<typeof aDatabase>,
  id: string,
  wallet: string,
): Promise<string> => {
  await database.store.addMerchant({ id, name: id }, NOW);
  await setServiceName(database.store, id, `Shop ${id}`, NOW);
  await database.store.setSellerSite(id, "https://shop.example.com", NOW);
  await database.store.noteContact(id, NOW, "api");
  await database.store.setPayoutWallet(
    id,
    { address: null, pending: null },
    {
      address: wallet,
      split: payoutSplitFor(T1_TEST, id, wallet),
      pending: null,
    },
    NOW - 60_000,
  );
  return id;
};

/** A wallet of the right shape, one per number, all digits so it is its own checksum. */
const walletNumber = (n: number): string => `0x${n.toString().padStart(40, "0")}`;

/** The parts listed, or none where the listing lists none. */
const partsIn = (listing: PayoutListing) => (listing.kind === "listed" ? listing.parts : []);

/** Why nothing was listed, where something was refused. */
const whyIn = (listing: PayoutListing) => (listing.kind === "refused" ? listing.why : "");

describe("the operator's payout, listed", () => {
  it("lists the transaction that pays out every split recorded, whole, for a person to send", async () => {
    const database = aDatabase();
    await aMerchantPaidAt(database, "mch_a", walletNumber(1));
    await aMerchantPaidAt(database, "mch_b", walletNumber(2));
    const gateway = aGatewayOver(database);
    const { splits } = await gateway.splitsToPayOut();

    const listing = await payoutListing(gateway);

    expect(splits).toHaveLength(2);
    expect(listing).toMatchObject({
      kind: "listed",
      chain: { id: "eip155:84532", name: "Base Sepolia" },
    });
    expect(
      partsIn(listing).map(({ to, value, data, splits: paid }) => ({ to, value, data, paid })),
    ).toStrictEqual(
      operatorPayouts(T1_TEST, splits, T1).map((part) => ({
        to: part.to,
        value: 0n,
        data: part.data,
        paid: part.splits,
      })),
    );
    expect(partsIn(listing)[0]?.to).toBe(T1_TEST.multicall3);
    // The commission wallet the part withdraws last.
    expect(partsIn(listing)[0]?.commissionWallets).toStrictEqual([T1_TEST.commissionWallet]);
  });

  it("pays out every split recorded on the network, one a restore carried over with no order and no wallet in force included, while a merchant's own payout keeps to theirs that can hold money", async () => {
    // Nothing may hold money where no payout reaches it, and a split the
    // operator's payout skipped would be one only a person building the call
    // by hand could empty. The price is gas for splits that hold nothing.
    const database = aDatabase();
    const merchant = await aMerchantPaidAt(database, "mch_a", walletNumber(1));
    const carried = payoutSplitFor(T1_TEST, merchant, walletNumber(2));
    await database.store.recordPayoutSplits([carried], NOW);
    const gateway = aGatewayOver(database);

    const listing = await payoutListing(gateway);

    expect(partsIn(listing).flatMap((part) => part.splits.map((split) => split.address))).toContain(
      carried.address,
    );
    expect(
      (await gateway.payoutSplitsOf(merchant)).toPayOut.map((split) => split.address),
    ).toStrictEqual([payoutSplitFor(T1_TEST, merchant, walletNumber(1)).address]);
  });

  it("leaves out a split waiting behind a wallet change not yet in force, and counts it, since it holds nothing yet and its address is the merchant's new wallet", async () => {
    const database = aDatabase();
    const merchant = await aMerchantPaidAt(database, "mch_a", walletNumber(1));
    const waiting = payoutSplitFor(T1_TEST, merchant, walletNumber(2));
    await database.store.setPayoutWallet(
      merchant,
      { address: walletNumber(1), pending: null },
      {
        address: walletNumber(1),
        split: payoutSplitFor(T1_TEST, merchant, walletNumber(1)),
        pending: { address: walletNumber(2), takesEffectAt: NOW + 3_600_000, split: waiting },
      },
      NOW,
    );
    const gateway = aGatewayOver(database);

    const listing = await payoutListing(gateway);

    const paid = partsIn(listing).flatMap((part) => part.splits);
    expect(paid.map((split) => split.address)).toStrictEqual([
      payoutSplitFor(T1_TEST, merchant, walletNumber(1)).address,
    ]);
    expect(paid.map((split) => split.merchantWallet)).not.toContain(walletNumber(2));
    expect(listing.kind === "listed" && listing.waiting).toBe(1);
  });

  it("still lists a split a wallet change waits to return to, where a sale was paid into it before", async () => {
    // The merchant was paid at the first wallet, moved to a second, and asked
    // to go back: the first wallet's split holds that sale's money.
    const database = aDatabase();
    const merchant = await aMerchantPaidAt(database, "mch_a", walletNumber(1));
    const gateway = aGatewayOver(database);
    const stored = await database.store.publishCard(merchant, lateGoods, NOW);
    await gateway.poll(merchant, 0);
    const offered = await gateway.beginPurchase(stored.id, {});
    if (offered.step !== "pay") throw new Error(`no price was offered: ${offered.step}`);
    await gateway.payPurchase(offered.order.priceOffer.stamp, "PAYMENT", "PAYMENT", undefined, {
      itemId: offered.order.itemId,
      params: offered.order.params,
    });
    const first = payoutSplitFor(T1_TEST, merchant, walletNumber(1));
    await database.store.setPayoutWallet(
      merchant,
      { address: walletNumber(1), pending: null },
      {
        address: walletNumber(2),
        split: payoutSplitFor(T1_TEST, merchant, walletNumber(2)),
        pending: { address: walletNumber(1), takesEffectAt: NOW + 3_600_000, split: first },
      },
      NOW,
    );

    const listing = await payoutListing(gateway);

    expect(partsIn(listing).flatMap((part) => part.splits.map((split) => split.address))).toContain(
      first.address,
    );
    expect(listing.kind === "listed" && listing.waiting).toBe(0);
  });

  it("lists a payout too large for one transaction as several, each whole and each in its turn", async () => {
    const database = aDatabase();
    for (let n = 1; n <= 21; n += 1) {
      await aMerchantPaidAt(database, `mch_${n}`, walletNumber(n));
    }
    const gateway = aGatewayOver(database);

    const listing = await payoutListing(gateway);

    const built = operatorPayouts(T1_TEST, (await gateway.splitsToPayOut()).splits, T1);
    expect(built).toHaveLength(2);
    expect(partsIn(listing).map((part) => part.data)).toStrictEqual(built.map((part) => part.data));
    expect(listing.kind === "listed" && listing.splits).toBe(21);
  });

  it("says there is nothing to pay out where no split is recorded, and lists no transaction", async () => {
    const database = aDatabase();
    const gateway = aGatewayOver(database);

    expect(await payoutListing(gateway)).toStrictEqual({
      kind: "nothing_recorded",
      chain: { id: "eip155:84532", name: "Base Sepolia" },
      waiting: 0,
    });
  });

  it("refuses in the sandbox, where nothing settles and no split is ever deployed", async () => {
    const database = aDatabase();
    await aMerchantPaidAt(database, "mch_a", walletNumber(1));
    const gateway = aGatewayOver(database, { FACILITATOR_URL: "sandbox:scripted" });

    expect(await payoutListing(gateway)).toStrictEqual({ kind: "sandbox" });
  });

  it("takes no work off the queue, since a gateway beside it does that work", async () => {
    const database = aDatabase();
    const merchant = await aMerchantPaidAt(database, "mch_a", walletNumber(1));
    const gateway = aGatewayOver(database);
    const stored = await database.store.publishCard(merchant, lateGoods, NOW);
    const offered = await gateway.beginPurchase(stored.id, {});
    if (offered.step !== "pay") throw new Error(`no price was offered: ${offered.step}`);
    await gateway.payPurchase(offered.order.priceOffer.stamp, "PAYMENT", "PAYMENT", undefined, {
      itemId: offered.order.itemId,
      params: offered.order.params,
    });
    const record = await database.store.orderById(offered.order.order.id);
    if (record === null) throw new Error("the paid purchase wrote no order");
    const due = deadlines(record.order).find((deadline) => deadline.kind === "async_fulfillment");
    if (due === undefined) throw new Error("the paid order has no fulfillment deadline");
    const before = record.order.state;

    vi.useFakeTimers();
    try {
      await payoutListing(gateway);
      await database.queue.remind(
        { kind: "deadline", deadline: due.kind, at: due.at, orderId: offered.order.order.id },
        0,
      );
      await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60 * 1_000);

      expect((await database.store.orderById(offered.order.order.id))?.order.state).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the chain it names", () => {
  // The person sending what it prints chooses a network in a wallet by its
  // name, and the same transaction on another chain pays nothing out.

  it("is Base in words on Base", async () => {
    const gateway = aGatewayOver(aDatabase("eip155:8453"), {
      PAYMENT_NETWORK: "eip155:8453",
      FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
      CDP_API_KEY_ID: "key-id",
      CDP_API_KEY_SECRET: "key-secret",
    });

    const listing = await payoutListing(gateway);

    expect("chain" in listing ? listing.chain : null).toStrictEqual({
      id: "eip155:8453",
      name: "Base",
    });
  });
});

describe("a payout over a split that would hand a share to an address no wallet may be", () => {
  it("is not listed, and the refusal names the split's wallet", async () => {
    // A sale was paid into the split of a wallet that no rule held when it was
    // saved, and the merchant has moved on since: that split still holds the
    // money, and a withdrawal of its share to Multicall3 goes to whoever calls
    // Multicall3 next.
    const database = aDatabase();
    const merchant = await aMerchantPaidAt(database, "mch_a", T1_TEST.multicall3);
    const gateway = aGatewayOver(database);
    const stored = await database.store.publishCard(merchant, lateGoods, NOW);
    // Its goods come later and it is charged first, which only a seller whose
    // process has just polled is sold.
    await gateway.poll(merchant, 0);
    const offered = await gateway.beginPurchase(stored.id, {});
    if (offered.step !== "pay") throw new Error(`no price was offered: ${offered.step}`);
    await gateway.payPurchase(offered.order.priceOffer.stamp, "PAYMENT", "PAYMENT", undefined, {
      itemId: offered.order.itemId,
      params: offered.order.params,
    });
    const moved = await database.store.setPayoutWallet(
      merchant,
      { address: T1_TEST.multicall3, pending: null },
      {
        address: walletNumber(1),
        split: payoutSplitFor(T1_TEST, merchant, walletNumber(1)),
        pending: null,
      },
      NOW,
    );
    expect(moved, "the wallet moved on").not.toBe("moved");
    expect((await gateway.splitsToPayOut()).splits.map((split) => split.merchantWallet)).toContain(
      T1_TEST.multicall3,
    );

    const listing = await payoutListing(gateway);

    expect(partsIn(listing)).toStrictEqual([]);
    expect(listing.kind).toBe("refused");
    expect(whyIn(listing)).toContain(T1_TEST.multicall3);
    expect(whyIn(listing)).toContain(merchant);
  });
});

describe("a payout the gateway would refuse to start with", () => {
  it("is not listed where a recorded split is no longer what the code makes, and the start's refusal says why", async () => {
    // A bundle built from splits the code disagrees with is a transaction
    // somebody pays for that may pay out another contract.
    const database = aDatabase();
    await database.store.addMerchant({ id: "mch_a", name: "merchant" }, NOW);
    const historical = payoutSplitFor(
      { ...T1_TEST, commissionWallet: DISTRIBUTOR },
      "mch_a",
      walletNumber(1),
    );
    await database.store.setPayoutWallet(
      "mch_a",
      { address: null, pending: null },
      { address: walletNumber(1), split: historical, pending: null },
      NOW,
    );
    const gateway = aGatewayOver(database);

    const listing = await payoutListing(gateway);

    expect(partsIn(listing)).toStrictEqual([]);
    expect(listing.kind).toBe("refused");
    expect(whyIn(listing)).toContain(historical.address);
  });

  it("is not listed on a database whose splits belong to another network", async () => {
    // A gateway pointed at the wrong chain would otherwise print nothing to
    // pay out, or another chain's splits as this one's.
    const database = aDatabase();
    await database.store.addMerchant({ id: "mch_a", name: "mch_a" }, NOW);
    await database.store.recordPayoutSplits(
      [payoutSplitFor(payoutSplitNetworkOf(T1, "eip155:8453"), "mch_a", walletNumber(1))],
      NOW,
    );
    const gateway = aGatewayOver(database);

    const listing = await payoutListing(gateway);

    expect(partsIn(listing)).toStrictEqual([]);
    expect(listing.kind).toBe("refused");
    expect(whyIn(listing)).toContain("eip155:8453");
  });
});

describe("a registry it could not read", () => {
  it("is not called a refusal, so the page says the payout could not be read", async () => {
    // Worded as the start's refusal, a database that did not answer would
    // read as splits that disagree with the code.
    const database = aDatabase();
    database.store.networksWithPayoutSplits = async () => {
      throw new Error("the database did not answer");
    };
    const gateway = aGatewayOver(database);

    await expect(payoutListing(gateway)).rejects.toThrow("the database did not answer");
  });
});

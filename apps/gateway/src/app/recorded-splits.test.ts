/**
 * What a gateway does with the registry of payout splits when it starts, and
 * where it takes a payment address from afterwards.
 *
 * A start first checks the registry against the network's payout split in the
 * code and refuses, in words, where they disagree, before it writes anything
 * or takes any work from the queue: until a change of rate is designed, a
 * constant edited in code must not quietly name new splits beside the old
 * ones. Then it records the split of every wallet set before splits existed,
 * so existing merchants keep selling. A payment address is always the one
 * recorded, never one recomputed from today's constants.
 *
 * Each case builds its own gateway over a store prepared first, because the
 * harness starts its gateway before it seeds anybody.
 */

import { deadlines } from "@agentify/core";
import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RecordingAnnouncer } from "../adapters/memory/announcer.js";
import { ScriptedFacilitator } from "../adapters/memory/facilitator.js";
import { MemoryQueue } from "../adapters/memory/queue.js";
import { MemoryStore } from "../adapters/memory/store.js";
import { loadConfig } from "../config.js";
import type { PayoutWalletRead } from "../ports/store.js";
import { splitAddress } from "../split/address.js";
import { DISTRIBUTOR } from "../split/fixture.js";
import { type PayoutSplitNetworks, payoutSplitNetworkOf } from "../split/networks.js";
import { type PayoutSplit, payoutSplitFor, splitParametersOf } from "../split/parameters.js";
import { countedIds, loggedWhile, SPLIT_NETWORKS_WITH_A_FIXTURE_BASE } from "../testing/harness.js";
import { Gateway } from "./gateway.js";
import { setServiceName } from "./merchants.js";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");

/** The table every row here is first written under. */
const T1 = SPLIT_NETWORKS_WITH_A_FIXTURE_BASE;
const T1_TEST = payoutSplitNetworkOf(T1, "eip155:84532");

/** A table whose test chain differs from T1's by one term, as an edit to a constant would. */
const editedTo = (change: Partial<typeof T1_TEST>): PayoutSplitNetworks => ({
  ...T1,
  "eip155:84532": { ...T1_TEST, ...change },
});

const W = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const P = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const OTHER = "0xde3F8C4422A7F8C94bce9Cc2Ec118665108148EF";

const LIVE = {
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  CDP_API_KEY_ID: "key-id",
  CDP_API_KEY_SECRET: "key-secret",
};

const card: Card = {
  merchant_item_id: "a-room",
  title: "A room",
  description: "A room sold by the merchant who published this card",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

let running: Gateway | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
});

/** A store and its queue, empty, as a database is before a gateway starts on it. */
const aDatabase = () => {
  const queue = new MemoryQueue();
  const store = new MemoryStore(countedIds(), () => NOW, queue.envelopes());
  return { store, queue };
};

/** A gateway over that database under this table, made and not started. */
const aGatewayOver = (
  database: ReturnType<typeof aDatabase>,
  table: PayoutSplitNetworks = T1,
  environment: Record<string, string> = {},
) => {
  const config = loadConfig(
    { DATABASE_URL: "postgres://agentify@localhost:5432/agentify", ...environment },
    table,
  );
  const facilitator = new ScriptedFacilitator();
  const gateway = new Gateway({
    config,
    store: database.store,
    queue: database.queue,
    facilitator,
    clock: () => NOW,
    ids: countedIds(),
    announcer: new RecordingAnnouncer(),
  });
  running = gateway;
  return { gateway, facilitator, config };
};

/** A merchant with a name, ready to sell but for where they are paid. */
const aMerchant = async (database: ReturnType<typeof aDatabase>, id: string): Promise<string> => {
  await database.store.addMerchant({ id, name: id }, NOW);
  await setServiceName(database.store, id, `Shop ${id}`, NOW);
  return id;
};

/** A wallet written with its split under this table, as this release writes one. */
const paidUnder = async (
  database: ReturnType<typeof aDatabase>,
  merchantId: string,
  wallet: string,
  table: PayoutSplitNetworks = T1,
  network = "eip155:84532",
): Promise<PayoutSplit> => {
  const split = payoutSplitFor(payoutSplitNetworkOf(table, network), merchantId, wallet);
  await database.store.setPayoutWallet(
    merchantId,
    { address: null, pending: null },
    { address: wallet, split, pending: null },
    NOW - 60_000,
  );
  return split;
};

/** A wallet as the release before splits wrote it: the merchant's columns and no row. */
const paidBeforeSplits = (
  database: ReturnType<typeof aDatabase>,
  merchantId: string,
  wallet: PayoutWalletRead,
) => database.store.writeWalletAsBeforeSplits(merchantId, wallet);

/** Why the start was refused, or a failure saying it started. */
const refusalOf = async (gateway: Gateway): Promise<string> => {
  try {
    await gateway.start();
  } catch (thrown) {
    return thrown instanceof Error ? thrown.message : String(thrown);
  }
  throw new Error("the gateway started, and refusing to start is what this is about");
};

/**
 * An order waiting on a deadline, and a reminder for it put on the queue now.
 * Whether the order is still waiting afterwards says whether anything took the
 * reminder off the queue.
 */
const aReminderWaiting = async (
  database: ReturnType<typeof aDatabase>,
  gateway: Gateway,
  merchantId: string,
) => {
  const stored = await database.store.publishCard(merchantId, card, NOW);
  const offered = await gateway.beginPurchase(stored.id, {});
  if (offered.step !== "pay") throw new Error(`no price was offered: ${offered.step}`);
  const orderId = offered.order.order.id;
  const due = deadlines(offered.order.order).find((deadline) => deadline.kind === "quote_expiry");
  if (due === undefined) throw new Error("the order waits on no price that can lapse");
  return {
    remind: () =>
      database.queue.remind({ kind: "deadline", deadline: due.kind, at: due.at, orderId }, 0),
    stateNow: async () => (await database.store.orderById(orderId))?.order.state,
  };
};

const aTick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("a start on a registry that agrees with the code", () => {
  it("starts on an empty registry", async () => {
    const database = aDatabase();
    await aMerchant(database, "mch_unpaid");

    await expect(aGatewayOver(database).gateway.start()).resolves.toBeUndefined();
  });

  it("starts where every split of a wallet in force or waiting is the one the code makes", async () => {
    const database = aDatabase();
    await aMerchant(database, "mch_one");
    await paidUnder(database, "mch_one", W);

    await expect(aGatewayOver(database).gateway.start()).resolves.toBeUndefined();
  });
});

describe("a start where the code's payout split changed since the registry was written", () => {
  it.each([
    ["the commission wallet", editedTo({ commissionWallet: DISTRIBUTOR })],
    ["the rate", editedTo({ commissionAllocation: 2_000 })],
    ["the factory", editedTo({ factory: OTHER })],
  ])(
    "refuses where %s changed, says why, and writes nothing and takes no work first",
    async (_what, table) => {
      // Recomputed from today's constants, every merchant's payment address
      // would move to a split nobody was told of, beside the old one still
      // holding money. The refusal is what makes such an edit loud.
      const database = aDatabase();
      await aMerchant(database, "mch_one");
      await paidUnder(database, "mch_one", W);
      // A wallet the backfill would give a split, which must not be written
      // under constants the start is about to refuse.
      await aMerchant(database, "mch_two");
      await paidBeforeSplits(database, "mch_two", { address: P, pending: null });
      const { gateway } = aGatewayOver(database, table);
      const waiting = await aReminderWaiting(database, gateway, "mch_one");

      const refused = await refusalOf(gateway);
      waiting.remind();
      await aTick();

      expect(refused).toMatch(/commission wallet or the rate/);
      expect(refused).toMatch(/no way yet to move/);
      expect(refused).toContain("eip155:84532");
      expect(refused).toMatch(/\b1 recorded split\b/);
      expect(await database.store.networksWithPayoutSplits()).toStrictEqual(["eip155:84532"]);
      expect(
        await database.store.payoutSplitAt(
          payoutSplitFor(payoutSplitNetworkOf(table, "eip155:84532"), "mch_one", W).address,
        ),
      ).toBeNull();
      expect((await database.store.merchantById("mch_two"))?.payoutWallet.split).toBeNull();
      expect(await waiting.stateNow()).toBe("quoted");
    },
  );

  it("refuses where the code's new commission wallet is a merchant's own wallet, for which it can make no split", async () => {
    // The split of a wallet that is the commission wallet would pay one
    // wallet twice, so the code makes none, and the recorded one is not what
    // it makes.
    const database = aDatabase();
    // The distributor's address, in the spelling a wallet is written in.
    const theirs = payoutSplitNetworkOf(T1, "eip155:8453").commissionWallet;
    expect(theirs.toLowerCase()).toBe(DISTRIBUTOR.toLowerCase());
    await aMerchant(database, "mch_one");
    await paidUnder(database, "mch_one", theirs);

    expect(
      await refusalOf(aGatewayOver(database, editedTo({ commissionWallet: theirs })).gateway),
    ).toMatch(/commission wallet or the rate/);
  });

  it("refuses where a waiting wallet's split disagrees, too", async () => {
    // At its moment the waiting split becomes the payment address with no
    // write in between.
    const database = aDatabase();
    await aMerchant(database, "mch_one");
    const edited = editedTo({ commissionWallet: DISTRIBUTOR });
    await database.store.setPayoutWallet(
      "mch_one",
      { address: null, pending: null },
      {
        address: W,
        split: payoutSplitFor(payoutSplitNetworkOf(edited, "eip155:84532"), "mch_one", W),
        pending: {
          address: P,
          takesEffectAt: NOW + 60_000,
          split: payoutSplitFor(T1_TEST, "mch_one", P),
        },
      },
      NOW,
    );

    expect(await refusalOf(aGatewayOver(database, edited).gateway)).toMatch(
      /commission wallet or the rate/,
    );
  });
});

describe("a start where the code no longer derives a recorded split from its own parameters", () => {
  it("refuses a split whose address its own parameters do not give, naming it", async () => {
    // A change to the encoder would give new merchants addresses computed
    // another way; checked at start, it is a refusal rather than a fork.
    const database = aDatabase();
    await aMerchant(database, "mch_one");
    const real = payoutSplitFor(T1_TEST, "mch_one", W);
    const forged = { ...real, address: payoutSplitFor(T1_TEST, "mch_one", OTHER).address };
    await database.store.setPayoutWallet(
      "mch_one",
      { address: null, pending: null },
      { address: W, split: forged, pending: null },
      NOW,
    );

    const refused = await refusalOf(aGatewayOver(database).gateway);

    expect(refused).toContain(forged.address);
    expect(refused).toMatch(/no longer/);
  });

  it("refuses a split whose salt is not the one the merchant and the network give, naming it", async () => {
    const database = aDatabase();
    await aMerchant(database, "mch_one");
    const real = payoutSplitFor(T1_TEST, "mch_one", W);
    const salt = payoutSplitFor(T1_TEST, "mch_other", W).salt;
    const resalted = {
      ...real,
      salt,
      address: splitAddress({
        ...splitParametersOf({ ...real, salt }),
        factory: T1_TEST.factory,
        implementation: T1_TEST.implementation,
      }),
    };
    await database.store.setPayoutWallet(
      "mch_one",
      { address: null, pending: null },
      { address: W, split: resalted, pending: null },
      NOW,
    );

    const refused = await refusalOf(aGatewayOver(database).gateway);

    expect(refused).toContain(resalted.address);
    expect(refused).toMatch(/no longer/);
  });
});

describe("a start on a database whose splits belong to another network", () => {
  it("refuses, naming both networks", async () => {
    // Moved from the test channel to the live one, the database would name
    // Base Sepolia's splits, with a test commission wallet inside, as payment
    // addresses on Base, where the same formula gives the same addresses.
    const database = aDatabase();
    await aMerchant(database, "mch_one");
    await paidUnder(database, "mch_one", W);

    const refused = await refusalOf(aGatewayOver(database, T1, LIVE).gateway);

    expect(refused).toContain("eip155:84532");
    expect(refused).toMatch(/eip155:8453\b/);
  });

  it("refuses even where no merchant's wallet in force names the foreign split", async () => {
    // A guard that looked only at the wallets in force on its own network
    // would never see the rows it is there to refuse.
    const database = aDatabase();
    await aMerchant(database, "mch_one");
    await database.store.recordPayoutSplits([payoutSplitFor(T1_TEST, "mch_one", OTHER)], NOW);

    expect(await refusalOf(aGatewayOver(database, T1, LIVE).gateway)).toContain("eip155:84532");
  });
});

describe("a start that finds wallets set before splits were", () => {
  /** Merchant 1 with no wallet, 2 with W, 3 with W and P waiting, all as before splits. */
  const asBeforeSplits = async () => {
    const database = aDatabase();
    await aMerchant(database, "mch_1");
    await aMerchant(database, "mch_2");
    await aMerchant(database, "mch_3");
    await paidBeforeSplits(database, "mch_2", { address: W, pending: null });
    await paidBeforeSplits(database, "mch_3", {
      address: W,
      pending: { address: P, takesEffectAt: NOW + 3_600_000 },
    });
    return database;
  };

  it("records the split of every wallet in force and every wallet waiting, and nobody else's", async () => {
    // The release moves existing wallets to splits without mail. A merchant
    // left without a row cannot sell, and one whose waiting wallet has none
    // stops selling at its moment.
    const database = await asBeforeSplits();
    const before = await database.store.merchants();

    const logged = await loggedWhile(() => aGatewayOver(database).gateway.start());

    const expected = [
      payoutSplitFor(T1_TEST, "mch_2", W),
      payoutSplitFor(T1_TEST, "mch_3", W),
      payoutSplitFor(T1_TEST, "mch_3", P),
    ];
    for (const split of expected) {
      expect(await database.store.payoutSplitAt(split.address)).toStrictEqual({
        ...split,
        recordedAt: NOW,
      });
    }
    expect((await database.store.merchantById("mch_1"))?.payoutWallet).toStrictEqual({
      address: null,
      split: null,
      pending: null,
    });
    expect(
      (await database.store.merchants()).map((merchant) => ({
        id: merchant.id,
        address: merchant.payoutWallet.address,
        pending: merchant.payoutWallet.pending?.address ?? null,
        at: merchant.payoutWallet.pending?.takesEffectAt ?? null,
      })),
    ).toStrictEqual(
      before.map((merchant) => ({
        id: merchant.id,
        address: merchant.payoutWallet.address,
        pending: merchant.payoutWallet.pending?.address ?? null,
        at: merchant.payoutWallet.pending?.takesEffectAt ?? null,
      })),
    );
    expect(logged).toMatch(/recorded 3 payout splits/);
    // One line per row, with every parameter needed to enter it again after a
    // restore from a copy older than the row.
    const lines = [...logged.matchAll(/payout split recorded: (\{.*\})/g)].map((line) =>
      JSON.parse(line[1] ?? ""),
    );
    expect(lines).toStrictEqual(expected.map((split) => ({ ...split, recordedAt: NOW })));
  });

  it("refuses to start on a wallet no split can be made for, naming its merchant, and records nothing", async () => {
    // A wallet set before splits that is the network's commission wallet
    // would make a split paying one wallet twice, which no factory creates.
    const database = await asBeforeSplits();
    await aMerchant(database, "mch_paid_to_us");
    await paidBeforeSplits(database, "mch_paid_to_us", {
      address: T1_TEST.commissionWallet,
      pending: null,
    });

    const refused = await refusalOf(aGatewayOver(database).gateway);

    expect(refused).toContain("mch_paid_to_us");
    expect(refused).toContain(T1_TEST.commissionWallet);
    expect(await database.store.networksWithPayoutSplits()).toStrictEqual([]);
  });

  it("records nothing on a second start, and writes nothing to the journal", async () => {
    const database = await asBeforeSplits();
    await aGatewayOver(database).gateway.start();
    await running?.stop();

    const logged = await loggedWhile(() => aGatewayOver(database).gateway.start());

    expect(logged).not.toMatch(/payout split/);
  });

  it("names, from then on, the split it recorded, and checks a payment against it", async () => {
    // An existing merchant's next challenge is their split, from the registry.
    const database = await asBeforeSplits();
    const { gateway, facilitator } = aGatewayOver(database);
    const stored = await database.store.publishCard("mch_2", card, NOW);

    await gateway.start();

    const split = payoutSplitFor(T1_TEST, "mch_2", W).address;
    expect((await gateway.paidResource(stored.id))?.payTo).toBe(split);
    const offered = await gateway.beginPurchase(stored.id, {});
    if (offered.step !== "pay") throw new Error(`no price was offered: ${offered.step}`);
    await gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
    expect(facilitator.verifies.at(-1)?.payTo).toBe(split);
  });
});

describe("the address a payment is asked for", () => {
  it("is the recorded split even where today's constants would compute another", async () => {
    // Recomputed here after a constant changed, the address would be one with
    // no recorded parameters, and money paid to it could never be paid out.
    const database = aDatabase();
    await aMerchant(database, "mch_one");
    const recorded = await paidUnder(database, "mch_one", W);
    const edited = editedTo({ commissionWallet: DISTRIBUTOR });
    // Not started: the start would refuse this registry, and the edge must
    // hold on its own.
    const { gateway, facilitator } = aGatewayOver(database, edited);
    const stored = await database.store.publishCard("mch_one", card, NOW);

    expect((await gateway.paidResource(stored.id))?.payTo).toBe(recorded.address);
    expect(
      payoutSplitFor(payoutSplitNetworkOf(edited, "eip155:84532"), "mch_one", W).address,
    ).not.toBe(recorded.address);
    const offered = await gateway.beginPurchase(stored.id, {});
    if (offered.step !== "pay") throw new Error(`no price was offered: ${offered.step}`);
    await gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
    expect(facilitator.verifies.at(-1)?.payTo).toBe(recorded.address);
  });
});

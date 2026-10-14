/**
 * Where a gateway takes a payment address from: the split recorded for the
 * merchant's wallet, never one recomputed from today's constants.
 *
 * Each case builds its own gateway over a store prepared first, because the
 * harness starts its gateway before it seeds anybody.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RecordingAnnouncer } from "../adapters/memory/announcer.js";
import { ScriptedFacilitator } from "../adapters/memory/facilitator.js";
import { MemoryQueue } from "../adapters/memory/queue.js";
import { MemoryStore } from "../adapters/memory/store.js";
import { loadConfig } from "../config.js";
import { DISTRIBUTOR } from "../split/fixture.js";
import { type PayoutSplitNetworks, payoutSplitNetworkOf } from "../split/networks.js";
import { type PayoutSplit, payoutSplitFor } from "../split/parameters.js";
import { countedIds, SPLIT_NETWORKS_WITH_A_FIXTURE_BASE } from "../testing/harness.js";
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

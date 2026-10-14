/**
 * The operator's payout: Agentify is paid only when somebody sends it, and
 * the command that prints it holds no key and sends nothing, so what it
 * prints must be exactly the transactions the builder makes from the splits
 * as recorded, and nothing where the gateway would refuse those splits.
 *
 * Each case builds its gateway over a store prepared first, and never starts
 * it: a command run beside a gateway takes no work off the queue.
 */

import { deadlines } from "@agentify/core";
import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RecordingAnnouncer } from "./adapters/memory/announcer.js";
import { ScriptedFacilitator } from "./adapters/memory/facilitator.js";
import { MemoryQueue } from "./adapters/memory/queue.js";
import { MemoryStore } from "./adapters/memory/store.js";
import { Gateway } from "./app/gateway.js";
import { setServiceName } from "./app/merchants.js";
import { loadConfig } from "./config.js";
import { runPayout } from "./payout-command.js";
import { DISTRIBUTOR } from "./split/fixture.js";
import { type PayoutSplitNetworks, payoutSplitNetworkOf } from "./split/networks.js";
import { payoutSplitFor } from "./split/parameters.js";
import { operatorPayouts } from "./split/payout.js";
import { countedIds, SPLIT_NETWORKS_WITH_A_FIXTURE_BASE } from "./testing/harness.js";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");

const T1 = SPLIT_NETWORKS_WITH_A_FIXTURE_BASE;
const T1_TEST = payoutSplitNetworkOf(T1, "eip155:84532");

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

const aDatabase = () => {
  const queue = new MemoryQueue();
  const store = new MemoryStore(T1_TEST.network, countedIds(), () => NOW, queue.envelopes());
  return { store, queue };
};

/** A gateway over that database, made and never started, as a command makes one. */
const aGatewayOver = (
  database: ReturnType<typeof aDatabase>,
  table: PayoutSplitNetworks = T1,
  environment: Record<string, string> = {},
): Gateway => {
  const config = loadConfig(
    { DATABASE_URL: "postgres://agentify@localhost:5432/agentify", ...environment },
    table,
  );
  running = new Gateway({
    config,
    store: database.store,
    queue: database.queue,
    facilitator: new ScriptedFacilitator(),
    clock: () => NOW,
    ids: countedIds(),
    announcer: new RecordingAnnouncer(),
  });
  return running;
};

/** A merchant paid at `wallet`, with its split recorded under the table, as a wallet write records it. */
const aMerchantPaidAt = async (
  database: ReturnType<typeof aDatabase>,
  id: string,
  wallet: string,
): Promise<string> => {
  await database.store.addMerchant({ id, name: id }, NOW);
  await setServiceName(database.store, id, `Shop ${id}`, NOW);
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

const printedBy = async (
  gateway: Gateway,
  argv: readonly string[] = [],
): Promise<{ code: number; lines: string[] }> => {
  const lines: string[] = [];
  const code = await runPayout(argv, gateway, (line) => {
    lines.push(...line.split("\n"));
  });
  return { code, lines };
};

/** Every part as printed: the values after `To:`, `Amount:` and `Data:`, in order. */
const partsIn = (lines: readonly string[]) => {
  const valuesOf = (label: string) =>
    lines
      .filter((line) => line.startsWith(`${label}: `))
      .map((line) => line.slice(label.length + 2));
  const to = valuesOf("To");
  const amount = valuesOf("Amount");
  return valuesOf("Data").map((data, at) => ({ to: to[at], amount: amount[at], data }));
};

describe("the operator's payout, printed", () => {
  it("prints the transaction that pays out every split that can hold money, whole, for a person to send", async () => {
    const database = aDatabase();
    await aMerchantPaidAt(database, "mch_a", walletNumber(1));
    await aMerchantPaidAt(database, "mch_b", walletNumber(2));
    const gateway = aGatewayOver(database);
    const splits = await gateway.splitsToPayOut();

    const { code, lines } = await printedBy(gateway);

    expect(code).toBe(0);
    expect(splits).toHaveLength(2);
    expect(partsIn(lines)).toStrictEqual(
      operatorPayouts(T1_TEST, splits).map((part) => ({
        to: part.to,
        amount: "0",
        data: part.data,
      })),
    );
    expect(partsIn(lines)[0]?.to).toBe(T1_TEST.multicall3);
    // Each split beside its merchant and the wallet it pays, and the
    // commission wallet the part withdraws last.
    for (const split of splits) {
      expect(
        lines.some((line) => line.includes(split.address) && line.includes(split.merchantWallet)),
      ).toBe(true);
    }
    expect(lines.some((line) => line.includes(T1_TEST.commissionWallet))).toBe(true);
    expect(lines.join("\n")).toMatch(/sends nothing and holds no key/);
  });

  it("prints a payout too large for one transaction as several, each whole and each in its turn", async () => {
    const database = aDatabase();
    for (let n = 1; n <= 21; n += 1) {
      await aMerchantPaidAt(database, `mch_${n}`, walletNumber(n));
    }
    const gateway = aGatewayOver(database);

    const { code, lines } = await printedBy(gateway);

    expect(code).toBe(0);
    const built = operatorPayouts(T1_TEST, await gateway.splitsToPayOut());
    expect(built).toHaveLength(2);
    expect(partsIn(lines).map((part) => part.data)).toStrictEqual(built.map((part) => part.data));
    expect(lines).toContain("Payout 1 of 2");
    expect(lines).toContain("Payout 2 of 2");
  });

  it("says there is nothing to pay out where no split can hold money, and prints no transaction", async () => {
    const database = aDatabase();
    const gateway = aGatewayOver(database);

    const { code, lines } = await printedBy(gateway);

    expect(code).toBe(0);
    expect(partsIn(lines)).toStrictEqual([]);
    expect(lines.join("\n")).toMatch(/nothing to pay out/);
  });

  it("refuses in the sandbox, where nothing settles and no split is ever deployed", async () => {
    const database = aDatabase();
    await aMerchantPaidAt(database, "mch_a", walletNumber(1));
    const gateway = aGatewayOver(database, T1, { FACILITATOR_URL: "sandbox:scripted" });

    const { code, lines } = await printedBy(gateway);

    expect(code).toBe(1);
    expect(partsIn(lines)).toStrictEqual([]);
    expect(lines.join("\n")).toMatch(/sandbox/);
  });

  it("takes no work off the queue, since a gateway beside it does that work", async () => {
    const database = aDatabase();
    const merchant = await aMerchantPaidAt(database, "mch_a", walletNumber(1));
    const gateway = aGatewayOver(database);
    const stored = await database.store.publishCard(merchant, card, NOW);
    const offered = await gateway.beginPurchase(stored.id, {});
    if (offered.step !== "pay") throw new Error(`no price was offered: ${offered.step}`);
    const due = deadlines(offered.order.order).find((deadline) => deadline.kind === "quote_expiry");
    if (due === undefined) throw new Error("the order waits on no price that can lapse");
    const before = (await database.store.orderById(offered.order.order.id))?.order.state;

    await printedBy(gateway);
    await database.queue.remind(
      { kind: "deadline", deadline: due.kind, at: due.at, orderId: offered.order.order.id },
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await database.store.orderById(offered.order.order.id))?.order.state).toBe(before);
  });
});

describe("a payout the gateway would refuse to start with", () => {
  it("is not printed where a recorded split is no longer what the code makes, and the start's refusal says why", async () => {
    // A bundle built from splits the code disagrees with is a transaction
    // somebody pays for that may pay out another contract.
    const database = aDatabase();
    await aMerchantPaidAt(database, "mch_a", walletNumber(1));
    const gateway = aGatewayOver(database, {
      ...T1,
      "eip155:84532": { ...T1_TEST, commissionWallet: DISTRIBUTOR },
    });

    const { code, lines } = await printedBy(gateway);

    expect(code).toBe(1);
    expect(partsIn(lines)).toStrictEqual([]);
    expect(lines.join("\n")).toMatch(/no longer what this code makes/);
  });

  it("is not printed on a database whose splits belong to another network", async () => {
    // A gateway pointed at the wrong chain would otherwise print nothing to
    // pay out, or another chain's splits as this one's.
    const database = aDatabase();
    await database.store.addMerchant({ id: "mch_a", name: "mch_a" }, NOW);
    await database.store.recordPayoutSplits(
      [payoutSplitFor(payoutSplitNetworkOf(T1, "eip155:8453"), "mch_a", walletNumber(1))],
      NOW,
    );
    const gateway = aGatewayOver(database);

    const { code, lines } = await printedBy(gateway);

    expect(code).toBe(1);
    expect(partsIn(lines)).toStrictEqual([]);
    expect(lines.join("\n")).toMatch(/records payout splits on eip155:8453/);
  });
});

describe("a registry it could not read", () => {
  it("is not called a refusal, so the command says its outcome is unknown", async () => {
    // Worded as the start's refusal, a database that did not answer would
    // read as splits that disagree with the code.
    const database = aDatabase();
    database.store.networksWithPayoutSplits = async () => {
      throw new Error("the database did not answer");
    };
    const gateway = aGatewayOver(database);

    await expect(printedBy(gateway)).rejects.toThrow("the database did not answer");
  });
});

describe("what it is asked", () => {
  it("prints how to run it for help, and refuses anything else it is handed", async () => {
    const gateway = aGatewayOver(aDatabase());

    expect((await printedBy(gateway, ["--help"])).code).toBe(0);
    expect((await printedBy(gateway, ["-h"])).code).toBe(0);
    const refused = await printedBy(gateway, ["send"]);
    expect(refused.code).toBe(2);
    expect(refused.lines.join("\n")).toMatch(/^Usage:/);
  });
});

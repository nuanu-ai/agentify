/**
 * The payout split smoke, run against a chain written out here instead of
 * Base Sepolia. The chain's answers are the ones the contracts' arithmetic
 * gives at 0.1% for two payments of $0.01, worked out by hand from the
 * 0xSplits source, so a run that passes here is a run whose predictions the
 * real chain can meet; the runs that fail here are the ones that must stop
 * the real smoke at the step that went wrong, with nothing sent after it.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  merchantPayout,
  operatorPayouts,
  PAYOUT_SPLIT_NETWORKS,
  type PayoutTransaction,
  payoutSplitFor,
  payoutSplitNetworkOf,
} from "@agentify/gateway";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { Ledger, UsdcTransfer } from "./split-ledger.js";
import {
  type Cost,
  type Mined,
  planRun,
  runSplitSmoke,
  SmokeStopped,
  type SmokeWorld,
  type SplitCreation,
  smokeSettings,
  whyNotBaseSepolia,
  whyNotWithinGasCap,
} from "./split-smoke-run.js";

const NETWORK = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532");

/** The Base Sepolia experiment's buyer and merchant wallet. */
const BUYER = "0x334bD2f4c4be711E0be7533f0d78040B5f071981";
const MERCHANT = "0xde3F8C4422A7F8C94bce9Cc2Ec118665108148EF";
const STRANGER = "0xF029d915c69C1902bB09A86c801c8226825F265c";

const SPLIT = payoutSplitFor(NETWORK, "mch_0123456789abcdef0123456789abcdef", MERCHANT);
const COMMISSION = SPLIT.commissionWallet;
const WAREHOUSE = NETWORK.warehouse;
const PRICE = 10_000n;

type Four = readonly [bigint, bigint, bigint, bigint];

/** Amounts in the order buyer, split, merchant wallet, commission wallet. */
const ledger = (held: Four, credited: Four): Ledger => {
  const of = ([buyer, split, merchant, commission]: Four) => ({
    [BUYER]: buyer,
    [SPLIT.address]: split,
    [MERCHANT]: merchant,
    [COMMISSION]: commission,
  });
  return { held: of(held), credited: of(credited) };
};

const transfer = (from: string, to: string, value: bigint): UsdcTransfer => ({ from, to, value });

/**
 * A fresh split, a merchant wallet the warehouse credits nothing and a
 * commission wallet it credits the one unit the experiment left it; held and
 * credited in the order buyer, split, merchant wallet, commission wallet.
 */
const INITIAL = ledger([50_000n, 0n, 0n, 119_997n], [0n, 0n, 0n, 1n]);

const CREATED: SplitCreation = {
  split: SPLIT.address,
  recipients: [SPLIT.merchantWallet, SPLIT.commissionWallet],
  allocations: [BigInt(SPLIT.merchantAllocation), BigInt(SPLIT.commissionAllocation)],
  totalAllocation: BigInt(SPLIT.totalAllocation),
  distributionIncentive: 0,
  owner: SPLIT.owner,
  salt: SPLIT.salt as Hex,
};

/** What the chain shows after each of the run's five transactions. */
interface Effect {
  readonly after: Ledger;
  readonly transfers: readonly UsdcTransfer[];
  readonly created?: readonly SplitCreation[];
  readonly distributed?: readonly bigint[];
}

const AS_THE_CONTRACTS_DO: readonly Effect[] = [
  {
    after: ledger([40_000n, 10_000n, 0n, 119_997n], [0n, 0n, 0n, 1n]),
    transfers: [transfer(BUYER, SPLIT.address, 10_000n)],
  },
  {
    after: ledger([40_000n, 1n, 9_988n, 119_997n], [0n, 1n, 1n, 10n]),
    transfers: [transfer(SPLIT.address, WAREHOUSE, 9_999n), transfer(WAREHOUSE, MERCHANT, 9_988n)],
    created: [CREATED],
    distributed: [9_999n],
  },
  {
    after: ledger([30_000n, 10_001n, 9_988n, 119_997n], [0n, 1n, 1n, 10n]),
    transfers: [transfer(BUYER, SPLIT.address, 10_000n)],
  },
  {
    after: ledger([30_000n, 1n, 19_978n, 119_997n], [0n, 1n, 1n, 20n]),
    transfers: [transfer(SPLIT.address, WAREHOUSE, 10_000n), transfer(WAREHOUSE, MERCHANT, 9_990n)],
    distributed: [10_000n],
  },
  {
    after: ledger([30_000n, 1n, 19_978n, 120_016n], [0n, 1n, 1n, 1n]),
    transfers: [transfer(WAREHOUSE, MERCHANT, 0n), transfer(WAREHOUSE, COMMISSION, 19n)],
    distributed: [0n],
  },
];

const CLONE =
  `0x36602c57343d527f9e4ac34f21c619cefc926c8bd93b54bf5a39c7ab2127a895af1cc0691d7e3dff593da1005b3d3d3d3d363d3d37363d73${NETWORK.implementation.slice(2).toLowerCase()}5af43d3d93803e605757fd5bf3` as Hex;

const CHEAP: Cost = {
  gas: 400_000n,
  maxFeePerGas: 10_000_000n,
  maxPriorityFeePerGas: 1_000_000n,
  l1Fee: 200n,
};

interface Scripted extends SmokeWorld {
  /** How many of the scripted transactions the run made happen. */
  readonly made: () => number;
}

/**
 * A chain that answers as the script says: block 100 holds `initial`, and each
 * payment or transaction the run makes is mined in the next block with the
 * next effect.
 */
function scriptedChain(options: {
  readonly effects: readonly Effect[];
  readonly chainId?: number;
  readonly payoutKeyBalance?: bigint;
  readonly cost?: (made: number) => Cost;
  readonly onPayment?: () => void;
}): Scripted {
  const states: Ledger[] = [INITIAL];
  const mined = new Map<Hex, Mined>();
  let createdAt: bigint | null = null;
  const make = (): Hex => {
    const at = states.length - 1;
    const effect = options.effects[at];
    if (effect === undefined) {
      throw new Error(`the script has no transaction ${at + 1}`);
    }
    states.push(effect.after);
    const block = 100n + BigInt(states.length - 1);
    if ((effect.created ?? []).length > 0 && createdAt === null) {
      createdAt = block;
    }
    const hash = `0x${block.toString(16).padStart(64, "0")}` as Hex;
    mined.set(hash, {
      hash,
      block,
      succeeded: true,
      gasUsed: 300_000n,
      paid: 3_000_000_000_000n,
      transfers: effect.transfers,
      created: effect.created ?? [],
      distributed: effect.distributed ?? [],
    });
    return hash;
  };
  const stateAt = (block: bigint) => {
    const at = Number(block - 100n);
    const state = states[Math.min(at, states.length - 1)];
    if (at < 0 || state === undefined) {
      throw new Error(`the script holds no block ${block}`);
    }
    return state;
  };
  return {
    made: () => states.length - 1,
    chainId: async () => options.chainId ?? 84532,
    observe: async (at) => {
      const block = at === "latest" ? 100n + BigInt(states.length - 1) : at;
      return {
        block,
        ledger: stateAt(block),
        splitCode: createdAt !== null && block >= createdAt ? CLONE : undefined,
      };
    },
    payoutKeyBalance: async () => options.payoutKeyBalance ?? 10n ** 16n,
    instruction: async () => merchantPayout(NETWORK, [SPLIT]),
    operatorPayout: async () => {
      const [only] = operatorPayouts(NETWORK, [SPLIT]);
      if (only === undefined) {
        throw new Error("the operator's payout of one split is one transaction");
      }
      return only;
    },
    pay: async () => {
      options.onPayment?.();
      return make();
    },
    costOf: async () => options.cost?.(states.length - 1) ?? CHEAP,
    send: async (_: PayoutTransaction) => make(),
    mined: async (hash) => {
      const found = mined.get(hash);
      if (found === undefined) {
        throw new Error(`the script mined no ${hash}`);
      }
      return found;
    },
  };
}

const aJournal = (): string =>
  path.join(mkdtempSync(path.join(tmpdir(), "split-smoke-")), "journal.jsonl");

const run = (
  world: SmokeWorld,
  journal: string,
  overrides: { confirm?: boolean; gasCap?: bigint } = {},
) =>
  runSplitSmoke({
    world,
    network: NETWORK,
    split: SPLIT,
    buyer: BUYER,
    price: PRICE,
    gasCap: overrides.gasCap ?? 5n * 10n ** 14n,
    confirm: overrides.confirm ?? true,
    journal,
    say: () => undefined,
  });

const stoppedAt = async (running: Promise<void>): Promise<SmokeStopped> => {
  const outcome = await running.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(outcome instanceof SmokeStopped)) {
    throw new Error(`the run was expected to stop, and it ended with ${String(outcome)}`);
  }
  return outcome;
};

const journalLines = (journal: string): readonly Record<string, unknown>[] =>
  readFileSync(journal, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const ENV = {
  AGENTIFY_SMOKE: "1",
  SMOKE_BUYER_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  SMOKE_PAYOUT_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
};

describe("the settings of a split smoke", () => {
  it("pays $0.01 twice under a cap of $0.05, spends at most 0.0005 ETH on gas, and reads Base Sepolia's public RPC, unless told otherwise", () => {
    const settings = smokeSettings(ENV, ["--confirm"]);

    expect(settings).toMatchObject({
      confirm: true,
      price: 10_000n,
      spendCap: 50_000n,
      gasCap: 500_000_000_000_000n,
      rpcUrl: "https://sepolia.base.org",
    });
    expect(smokeSettings(ENV, []).confirm).toBe(false);
  });

  it("runs only on AGENTIFY_SMOKE=1", () => {
    expect(() => smokeSettings({ ...ENV, AGENTIFY_SMOKE: undefined }, [])).toThrow(
      /AGENTIFY_SMOKE=1/,
    );
  });

  it("refuses a run whose two payments the USDC cap cannot hold, and takes two that fill it", () => {
    expect(() => smokeSettings({ ...ENV, SMOKE_PRICE_USD: "0.03" }, [])).toThrow(/SMOKE_MAX_USD/);
    expect(smokeSettings({ ...ENV, SMOKE_PRICE_USD: "0.025" }, []).price).toBe(25_000n);
  });

  it.each([["0"], ["-0.01"], ["0.0000001"], ["ten cents"], [""]])(
    "refuses a price of %j, which is no amount of USDC",
    (price) => {
      expect(() => smokeSettings({ ...ENV, SMOKE_PRICE_USD: price }, [])).toThrow(
        /SMOKE_PRICE_USD/,
      );
    },
  );

  it.each([["0"], ["-1"], ["lots"]])(
    "refuses a gas cap of %j, which is no amount of ETH",
    (cap) => {
      expect(() => smokeSettings({ ...ENV, SMOKE_MAX_GAS_ETH: cap }, [])).toThrow(
        /SMOKE_MAX_GAS_ETH/,
      );
    },
  );

  it("refuses one key for the buyer and the payouts, since the merchant's share would come back to the buyer and hide where it went", () => {
    expect(() => smokeSettings({ ...ENV, SMOKE_PAYOUT_KEY: ENV.SMOKE_BUYER_KEY }, [])).toThrow(
      /SMOKE_PAYOUT_KEY/,
    );
  });

  it.each([["SMOKE_BUYER_KEY"], ["SMOKE_PAYOUT_KEY"]])("refuses to run without %s", (name) => {
    expect(() => smokeSettings({ ...ENV, [name]: undefined }, [])).toThrow(new RegExp(name));
    expect(() => smokeSettings({ ...ENV, [name]: "0x1234" }, [])).toThrow(new RegExp(name));
  });
});

describe("the chain a split smoke runs on", () => {
  it("is Base Sepolia and nothing else", () => {
    expect(whyNotBaseSepolia(84532)).toBeNull();
    expect(whyNotBaseSepolia(8453)).toMatch(/8453/);
    expect(whyNotBaseSepolia(11155111)).toMatch(/11155111/);
  });
});

describe("a split smoke's predictions", () => {
  it.each([
    [10_000n, 9_988n, 9n, 9_990n, 10n],
    [1_000_000n, 998_998n, 999n, 999_000n, 1_000n],
  ])(
    "pays a fresh split's merchant at 0.1%%, for two payments of %i units, %i and then %i credited to Agentify, %i and %i, with four one-unit residues at the end",
    (price, firstToMerchant, firstToAgentify, secondToMerchant, secondToAgentify) => {
      const initial = ledger([10n * price, 0n, 0n, 0n], [0n, 0n, 0n, 0n]);

      const steps = planRun(SPLIT, WAREHOUSE, BUYER, price, initial);

      expect(steps.map((step) => [step.name, step.createsSplit])).toStrictEqual([
        ["the first payment", false],
        ["the first payout", true],
        ["the second payment", false],
        ["the second payout", false],
        ["the operator's payout", false],
      ]);
      const [, first, , second, operator] = steps;
      expect(first?.transfers).toStrictEqual([
        transfer(SPLIT.address, WAREHOUSE, price - 1n),
        transfer(WAREHOUSE, MERCHANT, firstToMerchant),
      ]);
      expect(first?.after.credited[COMMISSION]).toBe(firstToAgentify);
      expect(second?.transfers).toStrictEqual([
        transfer(SPLIT.address, WAREHOUSE, price),
        transfer(WAREHOUSE, MERCHANT, secondToMerchant),
      ]);
      expect(operator?.transfers).toStrictEqual([
        transfer(WAREHOUSE, MERCHANT, 0n),
        transfer(WAREHOUSE, COMMISSION, firstToAgentify + secondToAgentify - 1n),
      ]);
      const end = operator?.after;
      expect([
        end?.held[SPLIT.address],
        end?.credited[SPLIT.address],
        end?.credited[MERCHANT],
        end?.credited[COMMISSION],
      ]).toStrictEqual([1n, 1n, 1n, 1n]);
    },
  );

  it("carries into each withdrawal what the warehouse credited the wallet before the run", () => {
    const initial = ledger([50_000n, 0n, 0n, 0n], [0n, 0n, 1n, 5n]);

    const [, first, , , operator] = planRun(SPLIT, WAREHOUSE, BUYER, PRICE, initial);

    expect(first?.transfers.at(-1)).toStrictEqual(transfer(WAREHOUSE, MERCHANT, 9_989n));
    expect(operator?.transfers.at(-1)).toStrictEqual(
      transfer(WAREHOUSE, COMMISSION, 5n + 19n - 1n),
    );
  });
});

describe("the gas cap", () => {
  const cost: Cost = { gas: 100n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, l1Fee: 50n };

  it("lets a transaction through whose most it could cost, the L1 fee counted twice, fills the cap to the wei", () => {
    expect(whyNotWithinGasCap(900n, cost, 900n + 1_000n + 100n)).toBeNull();
  });

  it("stops a transaction that could pass the cap by one wei", () => {
    expect(whyNotWithinGasCap(900n, cost, 900n + 1_000n + 99n)).toMatch(/cap/);
  });
});

describe("a split smoke run", () => {
  it("pays and pays out on a chain that moves the money as the contracts do, with the split's every parameter on disk before the first payment", async () => {
    const journal = aJournal();
    let onDiskAtFirstPayment: string | null = null;
    const chain = scriptedChain({
      effects: AS_THE_CONTRACTS_DO,
      onPayment: () => {
        onDiskAtFirstPayment ??= readFileSync(journal, "utf8");
      },
    });

    await run(chain, journal);

    expect(chain.made()).toBe(5);
    const [plan] = (onDiskAtFirstPayment ?? "").trim().split("\n");
    expect(JSON.parse(plan ?? "null")).toMatchObject({
      split: {
        address: SPLIT.address,
        network: SPLIT.network,
        merchantId: SPLIT.merchantId,
        merchantWallet: SPLIT.merchantWallet,
        commissionWallet: SPLIT.commissionWallet,
        merchantAllocation: SPLIT.merchantAllocation,
        commissionAllocation: SPLIT.commissionAllocation,
        totalAllocation: SPLIT.totalAllocation,
        distributionIncentive: SPLIT.distributionIncentive,
        owner: SPLIT.owner,
        salt: SPLIT.salt,
        factory: SPLIT.factory,
      },
    });
    expect(journalLines(journal).map((line) => [line.stage, line.hash])).toStrictEqual([
      ["plan", undefined],
      ["the first payment", `0x${(101).toString(16).padStart(64, "0")}`],
      ["the first payout", `0x${(102).toString(16).padStart(64, "0")}`],
      ["the second payment", `0x${(103).toString(16).padStart(64, "0")}`],
      ["the second payout", `0x${(104).toString(16).padStart(64, "0")}`],
      ["the operator's payout", `0x${(105).toString(16).padStart(64, "0")}`],
    ]);
  });

  it("stops at the first payout, naming the split, when it leaves the split's credit without the unit the rounding leaves, and sends nothing after", async () => {
    const [pay, payout, ...rest] = AS_THE_CONTRACTS_DO;
    if (pay === undefined || payout === undefined) throw new Error("the script is short");
    const chain = scriptedChain({
      effects: [
        pay,
        { ...payout, after: ledger([40_000n, 1n, 9_988n, 119_997n], [0n, 0n, 2n, 10n]) },
        ...rest,
      ],
    });
    const journal = aJournal();

    const stopped = await stoppedAt(run(chain, journal));

    expect(stopped.step).toBe("the first payout");
    expect(stopped.message).toContain(SPLIT.address);
    expect(chain.made()).toBe(2);
    expect(journalLines(journal).map((line) => line.stage)).toStrictEqual([
      "plan",
      "the first payment",
    ]);
  });

  it("stops at the operator's payout, naming the address, when a unit of USDC reaches anybody but the run's five", async () => {
    const effects = [...AS_THE_CONTRACTS_DO];
    effects[4] = {
      after: ledger([30_000n, 1n, 19_978n, 120_015n], [0n, 1n, 1n, 1n]),
      transfers: [
        transfer(WAREHOUSE, MERCHANT, 0n),
        transfer(WAREHOUSE, COMMISSION, 18n),
        transfer(WAREHOUSE, STRANGER, 1n),
      ],
      distributed: [0n],
    };

    const stopped = await stoppedAt(run(scriptedChain({ effects }), aJournal()));

    expect(stopped.step).toBe("the operator's payout");
    expect(stopped.message).toContain(STRANGER);
  });

  it("stops at the second payout when it creates the split again, which a deployed split never is", async () => {
    const effects = [...AS_THE_CONTRACTS_DO];
    const second = effects[3];
    if (second === undefined) throw new Error("the script is short");
    effects[3] = { ...second, created: [CREATED] };

    const stopped = await stoppedAt(run(scriptedChain({ effects }), aJournal()));

    expect(stopped.step).toBe("the second payout");
  });

  it("pays nothing when the journal cannot be written", async () => {
    const chain = scriptedChain({ effects: AS_THE_CONTRACTS_DO });
    const nowhere = path.join(path.dirname(aJournal()), "no-such-directory", "journal.jsonl");

    const stopped = await stoppedAt(run(chain, nowhere));

    expect(stopped.step).toBe("the journal");
    expect(chain.made()).toBe(0);
  });

  it("pays nothing and writes nothing on a chain that is not Base Sepolia", async () => {
    const chain = scriptedChain({ effects: AS_THE_CONTRACTS_DO, chainId: 8453 });
    const journal = aJournal();

    const stopped = await stoppedAt(run(chain, journal));

    expect(stopped.step).toBe("the chain");
    expect(chain.made()).toBe(0);
    expect(() => readFileSync(journal)).toThrow(/ENOENT/);
  });

  it("pays nothing when the payout key holds less ETH than the gas cap", async () => {
    const chain = scriptedChain({ effects: AS_THE_CONTRACTS_DO, payoutKeyBalance: 10n ** 14n });

    const stopped = await stoppedAt(run(chain, aJournal(), { gasCap: 10n ** 14n + 1n }));

    expect(stopped.step).toBe("the payout key");
    expect(chain.made()).toBe(0);
  });

  it("sends no payout whose gas could pass the cap, stopping at that payout", async () => {
    const chain = scriptedChain({
      effects: AS_THE_CONTRACTS_DO,
      cost: (made) => (made === 3 ? { ...CHEAP, gas: 10n ** 12n } : CHEAP),
    });

    const stopped = await stoppedAt(run(chain, aJournal()));

    expect(stopped.step).toBe("the second payout");
    expect(chain.made()).toBe(3);
  });

  it("predicts and stops in a dry run, paying nothing and writing no journal", async () => {
    const chain = scriptedChain({ effects: AS_THE_CONTRACTS_DO });
    const journal = aJournal();

    await run(chain, journal, { confirm: false });

    expect(chain.made()).toBe(0);
    expect(() => readFileSync(journal)).toThrow(/ENOENT/);
  });
});

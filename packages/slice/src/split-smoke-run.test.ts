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
  readonly succeeded?: boolean;
  /** What its sender paid, in wei. */
  readonly paid?: bigint;
  /** The split's code from this block on, where it is not the factory's proxy; null for none. */
  readonly code?: Hex | null;
  /** A block somebody else's transaction makes just before this one. */
  readonly elsewhere?: { readonly after: Ledger; readonly createsSplit?: boolean };
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

/** The contracts' run with one of its five transactions showing otherwise. */
const withEffect = (at: number, change: (effect: Effect) => Effect): readonly Effect[] =>
  AS_THE_CONTRACTS_DO.map((effect, index) => (index === at ? change(effect) : effect));

const cloneOf = (implementation: string): Hex =>
  `0x36602c57343d527f9e4ac34f21c619cefc926c8bd93b54bf5a39c7ab2127a895af1cc0691d7e3dff593da1005b3d3d3d3d363d3d37363d73${implementation.slice(2).toLowerCase()}5af43d3d93803e605757fd5bf3`;

/** A real split's code on Base Sepolia, read from the experiment's S. */
const CLONE = cloneOf(NETWORK.implementation);

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
 * next effect, after any block somebody else makes first.
 */
function scriptedChain(options: {
  readonly effects: readonly Effect[];
  readonly initial?: Ledger;
  readonly splitExists?: boolean;
  readonly chainId?: number;
  readonly payoutKeyBalance?: bigint;
  readonly cost?: (made: number) => Cost;
  readonly onPayment?: () => void;
  readonly instruction?: (asked: number) => PayoutTransaction;
}): Scripted {
  const blocks: { ledger: Ledger; code: Hex | undefined }[] = [
    { ledger: options.initial ?? INITIAL, code: options.splitExists === true ? CLONE : undefined },
  ];
  const mined = new Map<Hex, Mined>();
  let made = 0;
  let instructions = 0;
  const make = (): Hex => {
    const effect = options.effects[made];
    if (effect === undefined) {
      throw new Error(`the script has no transaction ${made + 1}`);
    }
    made += 1;
    const codeBefore = blocks.at(-1)?.code;
    if (effect.elsewhere !== undefined) {
      blocks.push({
        ledger: effect.elsewhere.after,
        code: effect.elsewhere.createsSplit === true ? CLONE : codeBefore,
      });
    }
    const creates = (effect.created ?? []).length > 0;
    blocks.push({
      ledger: effect.after,
      code:
        effect.code === null ? undefined : (effect.code ?? (creates ? CLONE : blocks.at(-1)?.code)),
    });
    const block = 100n + BigInt(blocks.length - 1);
    const hash = `0x${block.toString(16).padStart(64, "0")}` as Hex;
    mined.set(hash, {
      hash,
      block,
      succeeded: effect.succeeded ?? true,
      gasUsed: 300_000n,
      paid: effect.paid ?? 3_000_000_000_000n,
      transfers: effect.transfers,
      created: effect.created ?? [],
      distributed: effect.distributed ?? [],
    });
    return hash;
  };
  const blockAt = (block: bigint) => {
    const found = blocks[Number(block - 100n)];
    if (found === undefined) {
      throw new Error(`the script holds no block ${block}`);
    }
    return found;
  };
  return {
    made: () => made,
    chainId: async () => options.chainId ?? 84532,
    observe: async (at) => {
      const block = at === "latest" ? 100n + BigInt(blocks.length - 1) : at;
      const { ledger, code } = blockAt(block);
      return { block, ledger, splitCode: code };
    },
    payoutKeyBalance: async () => options.payoutKeyBalance ?? 10n ** 16n,
    instruction: async () => {
      instructions += 1;
      return options.instruction?.(instructions) ?? merchantPayout(NETWORK, [SPLIT]);
    },
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
    costOf: async () => options.cost?.(made) ?? CHEAP,
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
    "pays the merchant of a fresh split and credits Agentify a thousandth, for two payments of %i units each, with four one-unit residues at the end",
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

  it("keeps a second unit credited to the split where a price's shares both round down, and distributes it with the payout after", () => {
    const price = 12_500n;
    const initial = ledger([10n * price, 0n, 0n, 0n], [0n, 0n, 0n, 0n]);

    const [, first, , second, operator] = planRun(SPLIT, WAREHOUSE, BUYER, price, initial);

    expect(first?.after.credited[SPLIT.address]).toBe(1n);
    expect(second?.distributed).toStrictEqual([12_500n]);
    expect(second?.after.credited[SPLIT.address]).toBe(2n);
    expect(operator?.distributed).toStrictEqual([1n]);
    expect(operator?.after.credited[SPLIT.address]).toBe(2n);
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
    expect(
      (JSON.parse(plan ?? "null") as { predicted: { step: string; transfers: unknown }[] })
        .predicted[1],
    ).toStrictEqual({
      step: "the first payout",
      transfers: [
        { from: SPLIT.address, to: WAREHOUSE, value: "9999" },
        { from: WAREHOUSE, to: MERCHANT, value: "9988" },
      ],
      after: expect.anything(),
    });
    expect(JSON.parse(plan ?? "null")).toMatchObject({
      instruction: { to: NETWORK.multicall3, data: merchantPayout(NETWORK, [SPLIT]).data },
      operator: { to: NETWORK.multicall3, data: operatorPayouts(NETWORK, [SPLIT])[0]?.data },
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
    const chain = scriptedChain({
      effects: withEffect(1, (payout) => ({
        ...payout,
        after: ledger([40_000n, 1n, 9_988n, 119_997n], [0n, 0n, 2n, 10n]),
      })),
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
    const effects = withEffect(4, () => ({
      after: ledger([30_000n, 1n, 19_978n, 120_015n], [0n, 1n, 1n, 1n]),
      transfers: [
        transfer(WAREHOUSE, MERCHANT, 0n),
        transfer(WAREHOUSE, COMMISSION, 18n),
        transfer(WAREHOUSE, STRANGER, 1n),
      ],
      distributed: [0n],
    }));

    const stopped = await stoppedAt(run(scriptedChain({ effects }), aJournal()));

    expect(stopped.step).toBe("the operator's payout");
    expect(stopped.message).toContain(STRANGER);
  });

  it("stops at the second payout when it creates the split again, which a deployed split never is", async () => {
    const effects = withEffect(3, (second) => ({ ...second, created: [CREATED] }));

    const stopped = await stoppedAt(run(scriptedChain({ effects }), aJournal()));

    expect(stopped.step).toBe("the second payout");
  });

  it("stops at the second payment, sending no payout after it, when the facilitator does not settle it", async () => {
    let payments = 0;
    const chain = scriptedChain({
      effects: AS_THE_CONTRACTS_DO,
      onPayment: () => {
        payments += 1;
        if (payments === 2) {
          throw new Error("nothing was charged: the settlement did not succeed");
        }
      },
    });

    const stopped = await stoppedAt(run(chain, aJournal()));

    expect(stopped.step).toBe("the second payment");
    expect(stopped.message).toMatch(/nothing was charged/);
    expect(chain.made()).toBe(2);
  });

  it.each([
    ["its transaction reverted", withEffect(1, (payout) => ({ ...payout, succeeded: false }))],
    [
      "the merchant's share reached the commission wallet",
      withEffect(1, (payout) => ({
        ...payout,
        transfers: [
          transfer(SPLIT.address, WAREHOUSE, 9_999n),
          transfer(WAREHOUSE, COMMISSION, 9_988n),
        ],
      })),
    ],
    [
      "the merchant was paid one unit less than the shares give",
      withEffect(1, (payout) => ({
        ...payout,
        transfers: [
          transfer(SPLIT.address, WAREHOUSE, 9_999n),
          transfer(WAREHOUSE, MERCHANT, 9_987n),
        ],
      })),
    ],
    [
      "the factory created the split with the shares swapped",
      withEffect(1, (payout) => ({
        ...payout,
        created: [{ ...CREATED, allocations: [...CREATED.allocations].reverse() }],
      })),
    ],
    ["the factory created nothing", withEffect(1, (payout) => ({ ...payout, created: [] }))],
    [
      "the split distributed other than its balance less the units it keeps",
      withEffect(1, (payout) => ({ ...payout, distributed: [9_998n] })),
    ],
    [
      "the split's code is a proxy of another implementation",
      withEffect(1, (payout) => ({ ...payout, code: cloneOf(STRANGER) })),
    ],
    [
      "the split's code is longer than the factory's proxy",
      withEffect(1, (payout) => ({ ...payout, code: `${CLONE}00` as Hex })),
    ],
    ["the split holds no code after it", withEffect(1, (payout) => ({ ...payout, code: null }))],
    [
      "the factory created the split with the two wallets swapped",
      withEffect(1, (payout) => ({
        ...payout,
        created: [{ ...CREATED, recipients: [...CREATED.recipients].reverse() }],
      })),
    ],
    [
      "its fees passed the gas cap, the L1 fee above its estimate",
      withEffect(1, (payout) => ({ ...payout, paid: 5n * 10n ** 14n + 1n })),
    ],
  ])("stops at the first payout, sending nothing after it, when %s", async (_, effects) => {
    const chain = scriptedChain({ effects });

    const stopped = await stoppedAt(run(chain, aJournal()));

    expect(stopped.step).toBe("the first payout");
    expect(chain.made()).toBe(2);
  });

  it("stops at the first payment when it came from another wallet than the buyer's", async () => {
    const effects = withEffect(0, (payment) => ({
      ...payment,
      transfers: [transfer(STRANGER, SPLIT.address, 10_000n)],
    }));

    const stopped = await stoppedAt(run(scriptedChain({ effects }), aJournal()));

    expect(stopped.step).toBe("the first payment");
  });

  it("stops at the first payment when somebody created the split just before it, so no payment reached a split without code", async () => {
    const effects = withEffect(0, (payment) => ({
      ...payment,
      elsewhere: { after: INITIAL, createsSplit: true },
    }));

    const stopped = await stoppedAt(run(scriptedChain({ effects }), aJournal()));

    expect(stopped.step).toBe("the first payment");
  });

  it("stops at the second payment when another split credited the commission wallet between the steps, since the predictions no longer hold", async () => {
    const effects = withEffect(2, (payment) => ({
      ...payment,
      elsewhere: { after: ledger([40_000n, 1n, 9_988n, 119_997n], [0n, 1n, 1n, 15n]) },
    }));

    const stopped = await stoppedAt(run(scriptedChain({ effects }), aJournal()));

    expect(stopped.step).toBe("the second payment");
    expect(stopped.message).toContain(COMMISSION);
  });

  it("sends no second payout when the payout screen's transaction has changed since the journal took it", async () => {
    const other = payoutSplitFor(NETWORK, SPLIT.merchantId, STRANGER);
    const chain = scriptedChain({
      effects: AS_THE_CONTRACTS_DO,
      instruction: (asked) => merchantPayout(NETWORK, asked < 3 ? [SPLIT] : [SPLIT, other]),
    });

    const stopped = await stoppedAt(run(chain, aJournal()));

    expect(stopped.step).toBe("the second payout");
    expect(chain.made()).toBe(3);
  });

  it("pays nothing when the payout screen's transaction pays out another split besides the run's", async () => {
    const other = payoutSplitFor(NETWORK, SPLIT.merchantId, STRANGER);
    const chain = scriptedChain({
      effects: AS_THE_CONTRACTS_DO,
      instruction: () => merchantPayout(NETWORK, [SPLIT, other]),
    });

    const stopped = await stoppedAt(run(chain, aJournal()));

    expect(stopped.step).toBe("the plan");
    expect(chain.made()).toBe(0);
  });

  it("pays nothing when the buyer holds less than both payments", async () => {
    const chain = scriptedChain({
      effects: AS_THE_CONTRACTS_DO,
      initial: ledger([19_999n, 0n, 0n, 119_997n], [0n, 0n, 0n, 1n]),
    });

    const stopped = await stoppedAt(run(chain, aJournal()));

    expect(stopped.step).toBe("the buyer");
    expect(chain.made()).toBe(0);
  });

  it("pays nothing when the split already holds code", async () => {
    const chain = scriptedChain({ effects: AS_THE_CONTRACTS_DO, splitExists: true });

    const stopped = await stoppedAt(run(chain, aJournal()));

    expect(stopped.step).toBe("the chain");
    expect(chain.made()).toBe(0);
  });

  it("stops at the first payment when the buyer lost more than the price, as a second settlement would take", async () => {
    const effects = withEffect(0, (payment) => ({
      ...payment,
      after: ledger([30_000n, 10_000n, 0n, 119_997n], [0n, 0n, 0n, 1n]),
    }));

    const stopped = await stoppedAt(run(scriptedChain({ effects }), aJournal()));

    expect(stopped.step).toBe("the first payment");
    expect(stopped.message).toContain(BUYER);
  });

  it("stops at the second payment when somebody paid the merchant wallet between the steps", async () => {
    const effects = withEffect(2, (payment) => ({
      ...payment,
      elsewhere: { after: ledger([40_000n, 1n, 9_989n, 119_997n], [0n, 1n, 1n, 10n]) },
    }));

    const stopped = await stoppedAt(run(scriptedChain({ effects }), aJournal()));

    expect(stopped.step).toBe("the second payment");
    expect(stopped.message).toContain(MERCHANT);
  });

  it("counts the payouts' gas against the cap and not the payments', which the facilitator pays", async () => {
    const effects = AS_THE_CONTRACTS_DO.map((effect, at) =>
      at % 2 === 0 && at < 4 ? { ...effect, paid: 10n ** 18n } : effect,
    );

    await run(scriptedChain({ effects }), aJournal());
  });

  it("runs on payouts whose fees fill the gas cap to the wei", async () => {
    const cap = 5n * 10n ** 14n;
    const effects = AS_THE_CONTRACTS_DO.map((effect, at) =>
      at === 1 ? { ...effect, paid: cap - 2n * 3_000_000_000_000n } : effect,
    );
    const chain = scriptedChain({
      effects,
      cost: () => ({ gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, l1Fee: 0n }),
    });

    await run(chain, aJournal(), { gasCap: cap });

    expect(chain.made()).toBe(5);
  });

  it("runs for a buyer who holds exactly both payments", async () => {
    const less = (effect: Effect): Effect => ({
      ...effect,
      after: {
        ...effect.after,
        held: { ...effect.after.held, [BUYER]: (effect.after.held[BUYER] ?? 0n) - 30_000n },
      },
    });
    const chain = scriptedChain({
      effects: AS_THE_CONTRACTS_DO.map(less),
      initial: ledger([20_000n, 0n, 0n, 119_997n], [0n, 0n, 0n, 1n]),
    });

    await run(chain, aJournal());

    expect(chain.made()).toBe(5);
  });

  it("runs on a payout key that holds exactly the gas cap", async () => {
    const chain = scriptedChain({ effects: AS_THE_CONTRACTS_DO, payoutKeyBalance: 10n ** 15n });

    await run(chain, aJournal(), { gasCap: 10n ** 15n });

    expect(chain.made()).toBe(5);
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

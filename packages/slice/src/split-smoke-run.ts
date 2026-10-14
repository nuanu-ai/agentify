/**
 * The payout split smoke's run, apart from the chain and the gateway it runs
 * against: what it reads from its settings, what it predicts, the journal it
 * writes before anything is paid, and the order of its five steps with the
 * comparison after each. `split-smoke.ts` hands it Base Sepolia and a gateway
 * in this process; its tests hand it a chain written out by hand.
 */

import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import type { PayoutSplit, PayoutSplitNetwork, PayoutTransaction } from "@agentify/gateway";
import { getAddress, type Hex, parseUnits } from "viem";
import { type Ledger, type Move, play, type UsdcTransfer } from "./split-ledger.js";

/** The one chain this smoke pays on. */
export const SMOKE_NETWORK = "eip155:84532";
const BASE_SEPOLIA_CHAIN_ID = 84532;

/**
 * Why the run stopped, and at which step. Whatever was paid before it is in
 * the journal, with what a payout of it needs.
 */
export class SmokeStopped extends Error {
  constructor(
    readonly step: string,
    why: string,
  ) {
    super(why);
    this.name = "SmokeStopped";
  }
}

export interface SmokeSettings {
  readonly confirm: boolean;
  readonly buyerKey: Hex;
  readonly payoutKey: Hex;
  /** Each payment, in USDC units. */
  readonly price: bigint;
  /** The most the run pays, both payments together, in USDC units. */
  readonly spendCap: bigint;
  /** The most the run spends on gas, all its transactions together, in wei. */
  readonly gasCap: bigint;
  readonly rpcUrl: string;
}

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/**
 * The run's settings from its environment and arguments, or a refusal naming
 * the setting at fault. Nothing is read from the chain here.
 */
export function smokeSettings(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
): SmokeSettings {
  const refuse = (why: string): never => {
    throw new SmokeStopped("the settings", why);
  };
  if (env.AGENTIFY_SMOKE !== "1") {
    refuse(
      "set AGENTIFY_SMOKE=1 to run the split smoke: it reads Base Sepolia and, with --confirm, pays test USDC and spends test ETH",
    );
  }
  const keyNamed = (name: string, holds: string): Hex => {
    const key = env[name];
    if (key === undefined || !PRIVATE_KEY.test(key)) {
      return refuse(
        `set ${name} to the private key of a test wallet that ${holds} (0x and 64 hexadecimal characters)`,
      );
    }
    return key as Hex;
  };
  const buyerKey = keyNamed("SMOKE_BUYER_KEY", "holds the test USDC the buyer pays with");
  const payoutKey = keyNamed(
    "SMOKE_PAYOUT_KEY",
    "holds the test ETH the payouts are sent with; its address is the test merchant's wallet",
  );
  if (buyerKey.toLowerCase() === payoutKey.toLowerCase()) {
    refuse(
      "SMOKE_PAYOUT_KEY is SMOKE_BUYER_KEY: the merchant's share would come back to the wallet that paid, and the run could not tell its own USDC from the share",
    );
  }

  const amountIn = (name: string, fallback: string, decimals: number, unit: string): bigint => {
    const written = env[name] ?? fallback;
    const decimal = new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`);
    const amount = decimal.test(written) ? parseUnits(written, decimals) : 0n;
    if (amount <= 0n) {
      refuse(
        `${name} is ${JSON.stringify(written)}, and it must be a positive amount of ${unit} with at most ${decimals} decimals`,
      );
    }
    return amount;
  };
  const price = amountIn("SMOKE_PRICE_USD", "0.01", 6, "USDC");
  const spendCap = amountIn("SMOKE_MAX_USD", "0.05", 6, "USDC");
  const gasCap = amountIn("SMOKE_MAX_GAS_ETH", "0.0005", 18, "ETH");
  if (2n * price > spendCap) {
    refuse(
      `the run pays SMOKE_PRICE_USD twice, ${2n * price} USDC units, above SMOKE_MAX_USD's ${spendCap}`,
    );
  }

  return {
    confirm: argv.includes("--confirm") || env.SMOKE_CONFIRM === "1",
    buyerKey,
    payoutKey,
    price,
    spendCap,
    gasCap,
    rpcUrl: env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
  };
}

/** Why a chain is not the one this smoke pays on, or null where it is. */
export function whyNotBaseSepolia(chainId: number): string | null {
  return chainId === BASE_SEPOLIA_CHAIN_ID
    ? null
    : `the RPC answers chain ${chainId}, and this smoke pays on Base Sepolia, chain ${BASE_SEPOLIA_CHAIN_ID}, alone`;
}

/** The most a transaction can cost at these terms, in wei. */
export interface Cost {
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  /** The L1 data fee as estimated, which no field of the transaction bounds. */
  readonly l1Fee: bigint;
}

/**
 * Why sending a transaction at this cost could take the run's gas past its
 * cap, or null. The gas limit and the fee cap bound what the L2 charges; the
 * L1 fee follows Ethereum's blob price and can move between the estimate and
 * the block, so it is counted twice.
 */
export function whyNotWithinGasCap(spent: bigint, cost: Cost, cap: bigint): string | null {
  const most = cost.gas * cost.maxFeePerGas + 2n * cost.l1Fee;
  return spent + most <= cap
    ? null
    : `it could cost up to ${most} wei, and with ${spent} wei spent the run's gas cap of ${cap} wei (SMOKE_MAX_GAS_ETH) would be passed`;
}

/** One step of the run with what it is predicted to leave. */
export interface PlannedStep {
  readonly name: string;
  readonly kind: "payment" | "instruction" | "operator";
  /** Whether the step's transaction is the one that creates the split. */
  readonly createsSplit: boolean;
  readonly before: Ledger;
  readonly after: Ledger;
  readonly transfers: readonly UsdcTransfer[];
  readonly distributed: readonly bigint[];
}

const sharesOf = (split: PayoutSplit) => ({
  address: split.address,
  recipients: [split.merchantWallet, split.commissionWallet],
  allocations: [split.merchantAllocation, split.commissionAllocation],
  totalAllocation: split.totalAllocation,
});

/**
 * The run's five steps with what each leaves, worked out from the balances
 * read before it: two payments of `price`, each followed by the payout
 * screen's transaction, which creates the split the first time, distributes
 * it and withdraws the merchant's share; then the operator's, which also
 * withdraws the commission.
 */
export function planRun(
  split: PayoutSplit,
  warehouse: string,
  buyer: string,
  price: bigint,
  initial: Ledger,
): readonly PlannedStep[] {
  const payment: readonly Move[] = [{ kind: "pay", from: buyer, to: split.address, value: price }];
  const distribute: Move = { kind: "distribute", split: sharesOf(split) };
  const toMerchant: Move = { kind: "withdraw", owner: split.merchantWallet };
  const toCommission: Move = { kind: "withdraw", owner: split.commissionWallet };
  const script: readonly [string, PlannedStep["kind"], readonly Move[]][] = [
    ["the first payment", "payment", payment],
    ["the first payout", "instruction", [distribute, toMerchant]],
    ["the second payment", "payment", payment],
    ["the second payout", "instruction", [distribute, toMerchant]],
    ["the operator's payout", "operator", [distribute, toMerchant, toCommission]],
  ];

  const steps: PlannedStep[] = [];
  let ledger = initial;
  for (const [name, kind, moves] of script) {
    const played = play(ledger, warehouse, moves);
    steps.push({
      name,
      kind,
      createsSplit: name === "the first payout",
      before: ledger,
      after: played.ledger,
      transfers: played.transfers,
      distributed: played.distributed,
    });
    ledger = played.ledger;
  }
  return steps;
}

/** What the run reads of the chain at one block. */
export interface Observation {
  readonly block: bigint;
  /** The USDC the run's four parties hold and are credited. */
  readonly ledger: Ledger;
  /** The split's code, or undefined where it has none. */
  readonly splitCode: Hex | undefined;
}

/** A `SplitCreated` the factory emitted. */
export interface SplitCreation {
  readonly split: string;
  readonly recipients: readonly string[];
  readonly allocations: readonly bigint[];
  readonly totalAllocation: bigint;
  readonly distributionIncentive: number;
  readonly owner: string;
  readonly salt: Hex;
}

/** A transaction in its block, as its receipt tells it. */
export interface Mined {
  readonly hash: Hex;
  readonly block: bigint;
  readonly succeeded: boolean;
  readonly gasUsed: bigint;
  /** What its sender paid for it, the L1 fee included, in wei. */
  readonly paid: bigint;
  readonly transfers: readonly UsdcTransfer[];
  readonly created: readonly SplitCreation[];
  /** The amounts of the split's `SplitDistributed` events. */
  readonly distributed: readonly bigint[];
}

/** The chain and the gateway the run works through. */
export interface SmokeWorld {
  chainId(): Promise<number>;
  observe(at: bigint | "latest"): Promise<Observation>;
  payoutKeyBalance(): Promise<bigint>;
  /** The payout screen's transaction for the test merchant, as the screen builds it now. */
  instruction(): Promise<PayoutTransaction>;
  /** The operator's payout of the test merchant's split. */
  operatorPayout(): Promise<PayoutTransaction>;
  /** Buys once through the gateway and answers the hash of the settlement. */
  pay(): Promise<Hex>;
  costOf(transaction: PayoutTransaction): Promise<Cost>;
  send(transaction: PayoutTransaction, cost: Cost): Promise<Hex>;
  mined(hash: Hex): Promise<Mined>;
}

export interface SmokeRun {
  readonly world: SmokeWorld;
  readonly network: PayoutSplitNetwork;
  readonly split: PayoutSplit;
  readonly buyer: string;
  readonly price: bigint;
  readonly gasCap: bigint;
  readonly confirm: boolean;
  /** Where the journal is appended to. */
  readonly journal: string;
  readonly say: (line: string) => void;
}

const asJson = (entry: unknown): string =>
  JSON.stringify(entry, (_, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );

/** Appends one line to the journal and waits for it to reach the disk. */
function record(journal: string, entry: Record<string, unknown>): void {
  const file = openSync(journal, "a");
  try {
    writeSync(file, `${asJson({ at: new Date().toISOString(), ...entry })}\n`);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

const SPLIT_FIELDS = [
  "address",
  "network",
  "merchantId",
  "merchantWallet",
  "commissionWallet",
  "merchantAllocation",
  "commissionAllocation",
  "totalAllocation",
  "distributionIncentive",
  "owner",
  "salt",
  "factory",
] as const satisfies readonly (keyof PayoutSplit)[];

/** Whether the journal on disk holds a plan naming this split with every parameter. */
function journalHolds(journal: string, split: PayoutSplit): boolean {
  let text: string;
  try {
    text = readFileSync(journal, "utf8");
  } catch {
    return false;
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .some((line) => {
      const entry = JSON.parse(line) as { stage?: unknown; split?: Record<string, unknown> };
      return (
        entry.stage === "plan" &&
        SPLIT_FIELDS.every((field) => entry.split?.[field] === split[field])
      );
    });
}

/** The split's code as the factory deploys it: an 89-byte proxy of the implementation. */
const isCloneOf = (code: Hex | undefined, implementation: string): boolean =>
  code !== undefined &&
  code.length === 2 + 2 * 89 &&
  code.toLowerCase().includes(implementation.slice(2).toLowerCase());

const sameTransfers = (a: readonly UsdcTransfer[], b: readonly UsdcTransfer[]): boolean =>
  a.length === b.length &&
  a.every((transfer, at) => {
    const other = b[at];
    return (
      other !== undefined &&
      getAddress(transfer.from) === getAddress(other.from) &&
      getAddress(transfer.to) === getAddress(other.to) &&
      transfer.value === other.value
    );
  });

const sameCreation = (created: SplitCreation, split: PayoutSplit): boolean =>
  getAddress(created.split) === getAddress(split.address) &&
  created.recipients.length === 2 &&
  getAddress(created.recipients[0] ?? "") === getAddress(split.merchantWallet) &&
  getAddress(created.recipients[1] ?? "") === getAddress(split.commissionWallet) &&
  created.allocations.length === 2 &&
  created.allocations[0] === BigInt(split.merchantAllocation) &&
  created.allocations[1] === BigInt(split.commissionAllocation) &&
  created.totalAllocation === BigInt(split.totalAllocation) &&
  created.distributionIncentive === split.distributionIncentive &&
  getAddress(created.owner) === getAddress(split.owner) &&
  created.salt.toLowerCase() === split.salt.toLowerCase();

const listed = (transfers: readonly UsdcTransfer[]): string =>
  transfers.length === 0
    ? "none"
    : transfers.map((transfer) => `${transfer.from} → ${transfer.to} ${transfer.value}`).join(", ");

/**
 * What the chain or the gateway answers, or the run stopped at this step with
 * whatever they threw instead.
 */
async function within<T>(step: string, asking: () => Promise<T>): Promise<T> {
  try {
    return await asking();
  } catch (thrown) {
    if (thrown instanceof SmokeStopped) {
      throw thrown;
    }
    throw new SmokeStopped(step, thrown instanceof Error ? thrown.message : String(thrown));
  }
}

/**
 * Runs the smoke: refuses unless the chain, the split and the keys are what
 * it needs, predicts every step, and in a dry run stops there. Otherwise it
 * writes the plan to the journal, then makes each step happen and holds what
 * the chain shows against the prediction; the first difference stops the run
 * at that step, with nothing sent after it.
 */
export async function runSplitSmoke(run: SmokeRun): Promise<void> {
  const { world, split, network, say } = run;
  const parties: readonly [string, string][] = [
    ["the buyer", getAddress(run.buyer)],
    ["the split", getAddress(split.address)],
    ["the merchant wallet", getAddress(split.merchantWallet)],
    ["the commission wallet", getAddress(split.commissionWallet)],
  ];
  const known = new Set([...parties.map(([, address]) => address), getAddress(network.warehouse)]);

  const differences = (predicted: Ledger, observed: Ledger): readonly string[] =>
    parties.flatMap(([role, address]) =>
      (["held", "credited"] as const).flatMap((column) => {
        const want = predicted[column][address] ?? 0n;
        const saw = observed[column][address] ?? 0n;
        const what = column === "held" ? "holds" : "is credited in the warehouse";
        return want === saw
          ? []
          : [`${role} ${address} ${what} ${saw} USDC units, ${want} predicted`];
      }),
    );

  const chainId = await within("the chain", () => world.chainId());
  const whyNot = whyNotBaseSepolia(chainId);
  if (whyNot !== null) {
    throw new SmokeStopped("the chain", whyNot);
  }

  const initial = await within("the chain", () => world.observe("latest"));
  if (initial.splitCode !== undefined) {
    throw new SmokeStopped(
      "the chain",
      `the split ${split.address} already holds code, so this run could not pay a split nobody has created; a fresh merchant gives a fresh split`,
    );
  }
  const funds = initial.ledger.held[getAddress(run.buyer)] ?? 0n;
  if (funds < 2n * run.price) {
    throw new SmokeStopped(
      "the buyer",
      `the buyer ${run.buyer} holds ${funds} USDC units, and the run pays ${2n * run.price}`,
    );
  }
  const ether = await within("the payout key", () => world.payoutKeyBalance());
  if (ether < run.gasCap) {
    throw new SmokeStopped(
      "the payout key",
      `the payout key holds ${ether} wei, less than the gas cap of ${run.gasCap} wei, so a payout could stop for want of gas after the buyer has paid`,
    );
  }

  const instruction = await within("the plan", () => world.instruction());
  const operator = await within("the plan", () => world.operatorPayout());
  for (const [what, transaction] of [
    ["the payout screen's transaction", instruction],
    ["the operator's payout", operator],
  ] as const) {
    const named = transaction.splits.map((one) => getAddress(one.address));
    if (named.length !== 1 || named[0] !== getAddress(split.address)) {
      throw new SmokeStopped(
        "the plan",
        `${what} pays out ${named.join(", ") || "nothing"}, and this run pays out ${split.address} alone`,
      );
    }
  }

  const steps = planRun(split, network.warehouse, run.buyer, run.price, initial.ledger);
  say(`split ${split.address} of ${split.merchantId} on ${split.network}`);
  say(
    `  pays ${split.merchantWallet} ${split.merchantAllocation} and ${split.commissionWallet} ${split.commissionAllocation} of ${split.totalAllocation}; salt ${split.salt}`,
  );
  for (const step of steps) {
    say(`predicted, ${step.name}: USDC transfers ${listed(step.transfers)}`);
  }

  if (!run.confirm) {
    say("DRY RUN: every check before paying passed, and nothing was signed or written.");
    return;
  }

  try {
    record(run.journal, {
      stage: "plan",
      split,
      implementation: network.implementation,
      instruction: { to: instruction.to, value: instruction.value, data: instruction.data },
      operator: { to: operator.to, value: operator.value, data: operator.data },
      buyer: run.buyer,
      price: run.price,
      predicted: steps.map((step) => ({
        step: step.name,
        transfers: step.transfers,
        after: step.after,
      })),
    });
  } catch (thrown) {
    throw new SmokeStopped(
      "the journal",
      `the plan could not be written to ${run.journal}, so nothing is paid: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }
  say(`journal: ${run.journal} holds the split's parameters and both transactions`);

  let spent = 0n;
  let last = initial.ledger;
  for (const step of steps) {
    const stop = (why: string): never => {
      throw new SmokeStopped(step.name, why);
    };
    const ask = <T>(asking: () => Promise<T>): Promise<T> => within(step.name, asking);
    if (!journalHolds(run.journal, split)) {
      stop(
        `the journal ${run.journal} no longer holds the split's parameters, so nothing more is sent`,
      );
    }

    let hash: Hex;
    if (step.kind === "payment") {
      hash = await ask(() => world.pay());
    } else {
      const planned = step.kind === "instruction" ? instruction : operator;
      const transaction =
        step.kind === "instruction" ? await ask(() => world.instruction()) : operator;
      if (transaction.data !== planned.data || transaction.to !== planned.to) {
        stop("the payout screen now gives another transaction than the one the plan wrote down");
      }
      const cost = await ask(() => world.costOf(transaction));
      const tooDear = whyNotWithinGasCap(spent, cost, run.gasCap);
      if (tooDear !== null) {
        stop(`nothing was sent: ${tooDear}`);
      }
      hash = await ask(() => world.send(transaction, cost));
    }

    const mined = await ask(() => world.mined(hash));
    if (step.kind !== "payment") {
      spent += mined.paid;
    }
    if (!mined.succeeded) {
      stop(`transaction ${hash} reverted in block ${mined.block}`);
    }
    const strangers = mined.transfers.filter(
      (transfer) => !known.has(getAddress(transfer.from)) || !known.has(getAddress(transfer.to)),
    );
    if (strangers.length > 0) {
      stop(
        `transaction ${hash} moved USDC to or from an address outside the run: ${listed(strangers)}`,
      );
    }
    if (!sameTransfers(mined.transfers, step.transfers)) {
      stop(
        `transaction ${hash} made the USDC transfers ${listed(mined.transfers)}, and ${listed(step.transfers)} were predicted`,
      );
    }
    const createdHere = mined.created.filter(
      (created) => getAddress(created.split) === getAddress(split.address),
    );
    if (step.createsSplit) {
      if (
        mined.created.length !== 1 ||
        createdHere.length !== 1 ||
        !sameCreation(createdHere[0] as SplitCreation, split)
      ) {
        stop(
          `transaction ${hash} was to create ${split.address} once with the journal's parameters, and the factory reported ${mined.created.length} creations: ${asJson(mined.created)}`,
        );
      }
    } else if (mined.created.length > 0) {
      stop(
        `transaction ${hash} created a split, and none was to be created: ${asJson(mined.created)}`,
      );
    }
    if (asJson(mined.distributed) !== asJson(step.distributed)) {
      stop(
        `transaction ${hash} distributed ${asJson(mined.distributed)} USDC units, and ${asJson(step.distributed)} were predicted`,
      );
    }

    const before = await ask(() => world.observe(mined.block - 1n));
    const moved = differences(step.before, before.ledger);
    if (moved.length > 0) {
      stop(
        `between the run's last read and block ${mined.block - 1n} the balances moved without the run: ${moved.join("; ")}`,
      );
    }
    const after = await ask(() => world.observe(mined.block));
    const wrong = differences(step.after, after.ledger);
    if (wrong.length > 0) {
      stop(`at block ${mined.block}, after ${hash}: ${wrong.join("; ")}`);
    }
    if (step.name === "the first payment" && before.splitCode !== undefined) {
      stop(
        `the split had code at block ${before.block}, and this payment was to reach a split without any`,
      );
    }
    if (step.name === "the second payment" && before.splitCode === undefined) {
      stop(
        `the split had no code at block ${before.block}, and this payment was to reach the created split`,
      );
    }
    if (step.kind !== "payment" && !isCloneOf(after.splitCode, network.implementation)) {
      stop(
        `the split's code at block ${mined.block} is not the factory's 89-byte proxy of ${network.implementation}: ${after.splitCode ?? "none"}`,
      );
    }
    if (spent > run.gasCap) {
      stop(
        `the payouts have cost ${spent} wei, past the gas cap of ${run.gasCap} wei: the L1 fee rose above twice its estimate`,
      );
    }

    last = after.ledger;
    record(run.journal, {
      stage: step.name,
      hash,
      block: mined.block,
      gasUsed: mined.gasUsed,
      paid: mined.paid,
      after: after.ledger,
    });
    say(
      `${step.name}: ${hash} in block ${mined.block}, gas ${mined.gasUsed}; USDC transfers ${listed(mined.transfers)}; every balance as predicted`,
    );
  }

  const delta = (column: "held" | "credited", address: string): bigint =>
    (last[column][address] ?? 0n) - (initial.ledger[column][address] ?? 0n);
  say("accounting, in USDC units, from the first read to the last block:");
  for (const [role, address] of parties) {
    say(
      `  ${role} ${address}: held ${delta("held", address)}, credited ${delta("credited", address)}`,
    );
  }
  const total = parties.reduce(
    (sum, [, address]) => sum + delta("held", address) + delta("credited", address),
    0n,
  );
  if (total !== 0n) {
    throw new SmokeStopped(
      "the accounting",
      `the parties' USDC, held and credited, changed by ${total} units over the run, so some of it is somewhere this run does not read`,
    );
  }
  say("  together 0: every unit the buyer paid is held or credited by the run's parties");
  say(`gas: ${spent} wei for the three payouts, under the cap of ${run.gasCap} wei`);
}

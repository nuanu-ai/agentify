/**
 * The two fixture files beside this one, typed for the tests that read them.
 * `base-sepolia-experiment.json` is what Base Sepolia holds and answered;
 * `hand-encoded-vectors.json` is what an encoder written outside this
 * repository gave for production-shaped splits, with no chain behind it. No
 * value here is computed by the code these tests check.
 */

import { readFileSync } from "node:fs";

interface ExperimentTransaction {
  readonly label: string;
  readonly hash: string;
  readonly from: string;
  readonly to: string;
  readonly input: string;
  readonly blockNumber: number;
}

interface Experiment {
  readonly network: string;
  readonly parameters: {
    readonly recipients: readonly [string, string];
    readonly allocations: readonly [number, number];
    readonly totalAllocation: number;
    readonly distributionIncentive: number;
    readonly owner: string;
  };
  readonly transactions: readonly ExperimentTransaction[];
  readonly reads: readonly Record<string, unknown>[];
}

interface HandEncoded {
  readonly salts: readonly {
    readonly network: string;
    readonly merchantId: string;
    readonly salt: string;
  }[];
  readonly splits: readonly {
    readonly network: string;
    readonly merchantId: string;
    readonly merchantWallet: string;
    readonly commissionWallet: string;
    readonly address: string;
  }[];
  readonly payouts: {
    readonly merchant: {
      readonly network: string;
      readonly merchantId: string;
      readonly merchantWallet: string;
      readonly commissionWallet: string;
      readonly data: string;
    };
    readonly merchantOverTwoWallets: {
      readonly network: string;
      readonly merchantId: string;
      readonly merchantWallets: readonly [string, string];
      readonly commissionWallet: string;
      readonly data: string;
    };
    readonly operator: {
      readonly network: string;
      readonly splits: readonly string[];
      readonly data: string;
    };
  };
}

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8")) as T;

const experiment = read<Experiment>("./base-sepolia-experiment.json");

export const handEncoded = read<HandEncoded>("./hand-encoded-vectors.json");

/** The parameters both experiment splits were created with, salt aside. */
export const EXPERIMENT_PARAMETERS = experiment.parameters;

const [merchant, commission] = experiment.parameters.recipients;

/** The experiment's merchant wallet, first recipient of S and S2. */
export const MERCHANT = merchant;
/** The experiment's commission wallet, second recipient of S and S2. */
export const COMMISSION = commission;

const transactionsLabelled = (label: string): readonly ExperimentTransaction[] => {
  const found = experiment.transactions.filter((transaction) => transaction.label === label);
  if (found.length === 0) {
    throw new Error(`the experiment has no transaction labelled ${label}`);
  }
  return found;
};

/** The one address every transaction with these labels went to. */
const theOneTarget = (...labels: readonly string[]): string => {
  const targets = new Set(
    labels.flatMap((label) => transactionsLabelled(label).map((transaction) => transaction.to)),
  );
  const [only, ...more] = [...targets];
  if (only === undefined || more.length > 0) {
    throw new Error(`the experiment's ${labels.join(" and ")} went to ${[...targets].join(", ")}`);
  }
  return only;
};

/** Who sent every create, distribute and withdraw: the experiment's distributor. */
export const DISTRIBUTOR = (() => {
  const senders = new Set(
    ["createSplitDeterministic", "distribute", "withdraw M", "withdraw A"].flatMap((label) =>
      transactionsLabelled(label).map((transaction) => transaction.from),
    ),
  );
  const [only, ...more] = [...senders];
  if (only === undefined || more.length > 0) {
    throw new Error(`the experiment's payouts were sent by ${[...senders].join(", ")}`);
  }
  return only;
})();

/** Each address as the chain's transactions name it, in lower case. */
export const ON_CHAIN = {
  factory: theOneTarget("createSplitDeterministic"),
  warehouse: theOneTarget("withdraw M", "withdraw A"),
  usdc: theOneTarget("pay S", "pay S2"),
} as const;

/** The one input every transaction with this label carried. */
export const inputOf = (label: string): string => {
  const inputs = new Set(transactionsLabelled(label).map((transaction) => transaction.input));
  const [only, ...more] = [...inputs];
  if (only === undefined || more.length > 0) {
    throw new Error(`the experiment's ${label} transactions carried ${inputs.size} inputs`);
  }
  return only;
};

/** The input of the create transaction that carried this salt. */
export const createInputWith = (salt: string): string => {
  const found = transactionsLabelled("createSplitDeterministic").filter((transaction) =>
    transaction.input.includes(salt.slice(2).toLowerCase()),
  );
  const [only, ...more] = found;
  if (only === undefined || more.length > 0) {
    throw new Error(`the experiment has ${found.length} create transactions with salt ${salt}`);
  }
  return only.input;
};

const readOf = (stage: string, split?: string): Record<string, unknown> => {
  const found = experiment.reads.find(
    (row) => row.stage === stage && (split === undefined || row.split === split),
  );
  if (found === undefined) {
    throw new Error(
      `the experiment has no ${stage} read${split === undefined ? "" : ` of ${split}`}`,
    );
  }
  return found;
};

const text = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`the experiment's ${String(row.stage)} read has no ${key}`);
  }
  return value;
};

/** The implementation the factory answered it clones, checksummed as it answered. */
export const IMPLEMENTATION = text(readOf("factory"), "implementation");

/** What the factory predicted for S and S2, and for S's salt with allocations shifted by one. */
export const S = {
  address: text(readOf("predict", "S"), "address"),
  salt: text(readOf("predict", "S"), "salt"),
};
export const S2 = {
  address: text(readOf("predict", "S2"), "address"),
  salt: text(readOf("predict", "S2"), "salt"),
};
export const S3 = {
  address: text(readOf("negative-3"), "address"),
  allocations: (readOf("negative-3").shiftedAllocations as readonly string[]).map(Number),
};

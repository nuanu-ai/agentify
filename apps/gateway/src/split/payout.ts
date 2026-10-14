/**
 * The transactions that pay out what waits in payout splits. Anybody may send
 * one, for gas alone, and the gateway sends none: it builds them from the
 * splits as recorded, for a merchant to paste into a wallet or for the
 * operator to send.
 *
 * Each is one zero-value call of Multicall3's `aggregate3`. Within it a split
 * is created first, since the factory hands back one that already exists,
 * then distributed, which credits each share in the warehouse; then each
 * wallet a split names is withdrawn once. Multicall3 runs every call as
 * itself, so nothing in the sending wallet can be touched.
 */

import { encodeFunctionData, type Hex } from "viem";
import {
  checkedAddress,
  checkedSplit,
  SPLIT_TUPLE,
  type SplitParameters,
  splitAddress,
  ZERO_ADDRESS,
} from "./address.js";
import type { PayoutSplitNetwork } from "./networks.js";
import { type PayoutSplit, splitParametersOf } from "./parameters.js";

/**
 * The most splits one payout pays out. Creating and distributing one costs up
 * to about 400 thousand gas, so twenty stay near half of the 16,777,216 one
 * transaction may use; a transaction that cannot be mined pays nobody.
 */
const SPLITS_PER_PAYOUT = 20;

/** One transaction to send, as a wallet asks for it. */
export interface PayoutTransaction {
  /** Multicall3: the transaction calls nothing else directly. */
  readonly to: string;
  /** Always zero: a payout carries none of its sender's money. */
  readonly value: 0n;
  /** The whole call, which no wallet can check if any of it is cut. */
  readonly data: Hex;
  /** The splits it pays out, in the order it pays them. */
  readonly splits: readonly PayoutSplit[];
}

const ABI = [
  {
    type: "function",
    name: "createSplitDeterministic",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_splitParams", ...SPLIT_TUPLE },
      { name: "_owner", type: "address" },
      { name: "_creator", type: "address" },
      { name: "_salt", type: "bytes32" },
    ],
    outputs: [{ name: "split", type: "address" }],
  },
  {
    type: "function",
    name: "distribute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_split", ...SPLIT_TUPLE },
      { name: "_token", type: "address" },
      { name: "_distributor", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_token", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

const tupleOf = (split: SplitParameters) => {
  const checked = checkedSplit(split);
  return {
    tuple: {
      recipients: checked.recipients,
      allocations: checked.allocations,
      totalAllocation: checked.totalAllocation,
      distributionIncentive: checked.distributionIncentive,
    },
    checked,
  };
};

/**
 * The factory's `createSplitDeterministic` for this split. The creator is
 * named only in the factory's event and changes neither the split nor its
 * address.
 */
export function createSplitCall(split: SplitParameters, creator: string): Hex {
  const { tuple, checked } = tupleOf(split);
  return encodeFunctionData({
    abi: ABI,
    functionName: "createSplitDeterministic",
    args: [tuple, checked.owner, checkedAddress(creator, "the creator"), checked.salt],
  });
}

/**
 * The split's own `distribute(split, token, distributor)`, which credits each
 * recipient's share of the token in the warehouse. The distributor is named
 * only in the split's event: with no incentive it is paid nothing.
 */
export function distributeCall(split: SplitParameters, token: string, distributor: string): Hex {
  const { tuple } = tupleOf(split);
  return encodeFunctionData({
    abi: ABI,
    functionName: "distribute",
    args: [
      tuple,
      checkedAddress(token, "the token"),
      checkedAddress(distributor, "the distributor"),
    ],
  });
}

/** The warehouse's `withdraw(owner, token)`, which pays the owner what is credited to them. */
export function withdrawCall(owner: string, token: string): Hex {
  return encodeFunctionData({
    abi: ABI,
    functionName: "withdraw",
    args: [checkedAddress(owner, "the owner"), checkedAddress(token, "the token")],
  });
}

interface Call {
  readonly target: string;
  readonly allowFailure: boolean;
  readonly callData: Hex;
}

/**
 * Throws unless every split is this network's, was made by its factory, sits
 * at the address its own parameters give, and is named once: a payout over
 * any other would create one contract and distribute another, or be sent on a
 * chain where it does nothing.
 */
function refuseUnlessPayable(network: PayoutSplitNetwork, splits: readonly PayoutSplit[]): void {
  const seen = new Set<string>();
  for (const split of splits) {
    if (split.network !== network.network) {
      throw new Error(
        `the split ${split.address} is on ${split.network}, and this payout is built for ${network.network}`,
      );
    }
    if (split.factory.toLowerCase() !== network.factory.toLowerCase()) {
      throw new Error(
        `the split ${split.address} was made by the factory ${split.factory}, which ${network.network}'s payout split does not name, so the code it clones is unknown here`,
      );
    }
    const derived = splitAddress({
      ...splitParametersOf(split),
      factory: split.factory,
      implementation: network.implementation,
    });
    if (derived !== checkedAddress(split.address, "the split")) {
      throw new Error(
        `the split recorded at ${split.address} has parameters that give ${derived}, so a payout of it would create one contract and distribute another`,
      );
    }
    if (seen.has(derived)) {
      throw new Error(`the split ${split.address} is named twice in one payout`);
    }
    seen.add(derived);
  }
}

/** Each wallet in the order the splits first name it, once, whatever its spelling. */
const eachOnce = (wallets: readonly string[]): readonly string[] => [
  ...new Set(wallets.map((wallet) => checkedAddress(wallet, "a wallet"))),
];

function transactionOf(
  network: PayoutSplitNetwork,
  splits: readonly PayoutSplit[],
  terms: { readonly distributeMayFail: boolean; readonly withdrawCommission: boolean },
): PayoutTransaction {
  const calls: Call[] = [];
  for (const split of splits) {
    const parameters = splitParametersOf(split);
    calls.push(
      // The factory returns a split that already exists instead of failing,
      // so a failure here is real, and the distribute after it would be a
      // call to an address with no code, which "succeeds".
      {
        target: split.factory,
        allowFailure: false,
        callData: createSplitCall(parameters, ZERO_ADDRESS),
      },
      {
        target: split.address,
        allowFailure: terms.distributeMayFail,
        callData: distributeCall(parameters, network.usdc, ZERO_ADDRESS),
      },
    );
  }
  // The warehouse reverts a withdrawal at a balance of zero and to a wallet
  // USDC refuses, and neither may undo the distributions before it.
  const withdraw = (owner: string): Call => ({
    target: network.warehouse,
    allowFailure: true,
    callData: withdrawCall(owner, network.usdc),
  });
  calls.push(...eachOnce(splits.map((split) => split.merchantWallet)).map(withdraw));
  if (terms.withdrawCommission) {
    calls.push(...eachOnce(splits.map((split) => split.commissionWallet)).map(withdraw));
  }

  return {
    to: checkedAddress(network.multicall3, "Multicall3"),
    value: 0n,
    data: encodeFunctionData({
      abi: ABI,
      functionName: "aggregate3",
      args: [
        calls.map((call) => ({
          target: checkedAddress(call.target, "a call's target"),
          allowFailure: call.allowFailure,
          callData: call.callData,
        })),
      ],
    }),
    splits,
  };
}

/**
 * The one transaction that pays a merchant out of their splits on this
 * network, as their payout screen shows it: each split created and
 * distributed, then each of their wallets withdrawn once. Only a withdrawal
 * may fail without undoing the rest. Agentify's share is left credited in the
 * warehouse, for the operator's payout to collect.
 *
 * Built from the splits as recorded, never from the network's commission
 * wallet or rate today; the network gives only the contracts and the token.
 * Refuses an empty list, splits of more than one merchant, more than twenty
 * splits, and any split `operatorPayouts` refuses.
 */
export function merchantPayout(
  network: PayoutSplitNetwork,
  splits: readonly PayoutSplit[],
): PayoutTransaction {
  if (splits.length === 0) {
    throw new Error("there is no split to pay out, so there is no payout to build");
  }
  const merchants = new Set(splits.map((split) => split.merchantId));
  if (merchants.size > 1) {
    throw new Error(`one merchant's payout names the splits of ${merchants.size} merchants`);
  }
  if (splits.length > SPLITS_PER_PAYOUT) {
    throw new Error(
      `the merchant has ${splits.length} splits to pay out, and one transaction carries at most ${SPLITS_PER_PAYOUT}`,
    );
  }
  refuseUnlessPayable(network, splits);
  return transactionOf(network, splits, { distributeMayFail: false, withdrawCommission: false });
}

/**
 * The operator's payout of every split given, in parts of at most twenty,
 * in the order given. Each part creates and distributes its splits, letting
 * any distribution fail alone, so a split Circle has blocked does not stop the
 * others; then it withdraws each merchant wallet its splits name once, and
 * last each commission wallet they name. No split gives no transaction.
 *
 * Refuses a split of another network, one made by another factory, one whose
 * address its parameters do not give, and one named twice.
 */
export function operatorPayouts(
  network: PayoutSplitNetwork,
  splits: readonly PayoutSplit[],
): readonly PayoutTransaction[] {
  refuseUnlessPayable(network, splits);
  const parts: PayoutTransaction[] = [];
  for (let start = 0; start < splits.length; start += SPLITS_PER_PAYOUT) {
    parts.push(
      transactionOf(network, splits.slice(start, start + SPLITS_PER_PAYOUT), {
        distributeMayFail: true,
        withdrawCommission: true,
      }),
    );
  }
  return parts;
}

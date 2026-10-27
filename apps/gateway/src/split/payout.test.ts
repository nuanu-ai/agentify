/**
 * A payout is a transaction somebody pays gas for, pasted into a wallet by a
 * merchant or sent by the operator. A byte off makes it do nothing, or the
 * wrong thing, so its calls are compared with the inputs of the experiment's
 * real transactions and its wrapping with a layout written out word by word.
 * The built transaction is read back here by slicing its words, never by a
 * decoder of the code under test.
 */

import { checksummedAddressOf } from "@nuanu-ai/agentify-contracts";
import { encodeAbiParameters, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  COMMISSION,
  createInputWith,
  DISTRIBUTOR,
  EXPERIMENT_PARAMETERS,
  handEncoded,
  inputOf,
  MERCHANT,
  ON_CHAIN,
  S,
  S2,
} from "./fixture.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "./networks.js";
import { type PayoutSplit, payoutSplitFor, splitParametersOf } from "./parameters.js";
import {
  broughtBy,
  createSplitCall,
  distributeCall,
  merchantPayout,
  operatorPayouts,
  payoutDryRun,
  withdrawCall,
} from "./payout.js";

const ZERO = "0x0000000000000000000000000000000000000000";

/** Multicall3's address on every chain it is deployed to, Base and Base Sepolia among them. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** The code's Base Sepolia entry: the payout contracts and the token come from here. */
const TEST_NETWORK = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532");

/** The same with the experiment's commission wallet, so its splits are this network's. */
const WITH_THE_EXPERIMENTS_COMMISSION = { ...TEST_NETWORK, commissionWallet: COMMISSION };

const LIVE_NETWORK = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:8453");

/** Every network a payout is built knowing of: no share is withdrawn to a contract or wallet of any. */
const NETWORKS = PAYOUT_SPLIT_NETWORKS;

/** One of the experiment's splits as the registry would hand it over. */
const recorded = (split: { address: string; salt: string }, merchantId: string): PayoutSplit => ({
  address: split.address,
  network: "eip155:84532",
  merchantId,
  merchantWallet: MERCHANT,
  commissionWallet: COMMISSION,
  merchantAllocation: EXPERIMENT_PARAMETERS.allocations[0],
  commissionAllocation: EXPERIMENT_PARAMETERS.allocations[1],
  totalAllocation: EXPERIMENT_PARAMETERS.totalAllocation,
  distributionIncentive: EXPERIMENT_PARAMETERS.distributionIncentive,
  owner: EXPERIMENT_PARAMETERS.owner,
  salt: split.salt,
  factory: checksummedAddressOf(ON_CHAIN.factory),
});

const S_ROW = recorded(S, "mch_a");
const S2_ROW = recorded(S2, "mch_b");
/** S2 as the same merchant's second split, paying the same wallet as S. */
const S2_OF_THE_SAME_MERCHANT = recorded(S2, "mch_a");

const MERCHANT_ID = handEncoded.payouts.merchant.merchantId;
const SECOND_WALLET = handEncoded.payouts.merchantOverTwoWallets.merchantWallets[1];

const WORD = 64;

/** A value as one ABI word: left-padded to thirty-two bytes, in lower case. */
const word = (hex: string): string => hex.replace(/^0x/, "").toLowerCase().padStart(WORD, "0");

/** Call data right-padded to whole words, as `bytes` sits inside a tuple. */
const padded = (data: string): string => {
  const body = data.slice(2);
  return body.padEnd(Math.ceil(body.length / WORD) * WORD, "0");
};

/** An input with one argument word, counted from zero after the selector, replaced. */
const withArgument = (input: string, index: number, value: string): string => {
  const at = 2 + 8 + index * WORD;
  return `${input.slice(0, at)}${word(value)}${input.slice(at + WORD)}`;
};

/** One argument word of an input, counted from zero after the selector. */
const argumentOf = (input: string, index: number): string =>
  input.slice(2 + 8 + index * WORD, 2 + 8 + (index + 1) * WORD);

const addressIn = (wordHex: string): string => `0x${wordHex.slice(24)}`;

/** The experiment's inputs as the instruction sends them: nobody named as creator or distributor. */
const CREATE_S = withArgument(createInputWith(S.salt), 2, ZERO);
const CREATE_S2 = withArgument(createInputWith(S2.salt), 2, ZERO);
const DISTRIBUTE = withArgument(inputOf("distribute"), 2, ZERO);
const WITHDRAW_M = inputOf("withdraw M");
const WITHDRAW_A = inputOf("withdraw A");

interface Call {
  readonly target: string;
  readonly allowFailure: boolean;
  readonly data: string;
}

/** The calls inside an `aggregate3` input, read off its words. */
function callsOf(data: string): readonly Call[] {
  expect(data.slice(0, 10)).toBe("0x82ad56cb");
  const body = data.slice(10);
  const at = (byte: number): bigint => BigInt(`0x${body.slice(byte * 2, byte * 2 + WORD)}`);
  expect(at(0)).toBe(0x20n);
  const count = Number(at(32));
  const heads = 64;
  return Array.from({ length: count }, (_, index) => {
    const start = heads + Number(at(heads + 32 * index));
    const flag = at(start + 32);
    expect([0n, 1n]).toContain(flag);
    expect(at(start + 64)).toBe(0x60n);
    const length = Number(at(start + 96));
    return {
      target: `0x${body.slice(start * 2 + 24, start * 2 + WORD)}`,
      allowFailure: flag === 1n,
      data: `0x${body.slice((start + 128) * 2, (start + 128 + length) * 2)}`,
    };
  });
}

const call = (target: string, allowFailure: boolean, data: string): Call => ({
  target: target.toLowerCase(),
  allowFailure,
  data,
});

describe("the calls of a payout", () => {
  it("ask the factory to create each split with the bytes the experiment's create transactions carried", () => {
    expect(createSplitCall(splitParametersOf(S_ROW), DISTRIBUTOR)).toBe(createInputWith(S.salt));
    expect(createSplitCall(splitParametersOf(S2_ROW), DISTRIBUTOR)).toBe(createInputWith(S2.salt));
  });

  it("distribute with the bytes of the experiment's distribute transactions", () => {
    expect(distributeCall(splitParametersOf(S_ROW), ON_CHAIN.usdc, DISTRIBUTOR)).toBe(
      inputOf("distribute"),
    );
  });

  it("withdraw a share with the bytes of the experiment's withdraw transactions", () => {
    expect(withdrawCall(MERCHANT, ON_CHAIN.usdc)).toBe(WITHDRAW_M);
    expect(withdrawCall(COMMISSION, ON_CHAIN.usdc)).toBe(WITHDRAW_A);
  });
});

describe("a merchant's payout of one split", () => {
  it("is one transaction to Multicall3 carrying no money, laid out word by word", () => {
    const paid = merchantPayout(TEST_NETWORK, [S_ROW], NETWORKS);

    expect(paid.to).toBe(MULTICALL3);
    expect(paid.value).toBe(0n);
    // aggregate3((address,bool,bytes)[]): the array's offset and length, the
    // offset of each element, then each element: target, allowFailure, the
    // offset of its data, the data's length and the data padded to words.
    expect(paid.data).toBe(
      `0x82ad56cb${word("20")}${word("4")}${word("80")}${word("2e0")}${word("520")}${word("600")}` +
        `${word(ON_CHAIN.factory)}${word("0")}${word("60")}${word("1c4")}${padded(CREATE_S)}` +
        `${word(S.address)}${word("1")}${word("60")}${word("1a4")}${padded(DISTRIBUTE)}` +
        `${word(ON_CHAIN.warehouse)}${word("1")}${word("60")}${word("44")}${padded(WITHDRAW_M)}` +
        `${word(ON_CHAIN.warehouse)}${word("1")}${word("60")}${word("44")}${padded(WITHDRAW_A)}`,
    );
    expect(paid.splits).toStrictEqual([S_ROW]);
  });

  it("is the transaction a hand encoder gives for a production-shaped split", () => {
    const { merchant } = handEncoded.payouts;
    const split = payoutSplitFor(
      WITH_THE_EXPERIMENTS_COMMISSION,
      merchant.merchantId,
      merchant.merchantWallet,
    );
    expect(merchantPayout(WITH_THE_EXPERIMENTS_COMMISSION, [split], NETWORKS).data).toBe(
      merchant.data,
    );
  });

  it("is built from the split as recorded, whatever commission wallet the network names today", () => {
    const today = { ...TEST_NETWORK, commissionWallet: LIVE_NETWORK.commissionWallet };
    expect(merchantPayout(today, [S_ROW], NETWORKS).data).toBe(
      merchantPayout(TEST_NETWORK, [S_ROW], NETWORKS).data,
    );
    const [create, distribute, , commission] = callsOf(
      merchantPayout(today, [S_ROW], NETWORKS).data,
    );
    expect(create?.data).toBe(CREATE_S);
    expect(distribute?.data).toBe(DISTRIBUTE);
    expect(commission?.data).toBe(WITHDRAW_A);
  });
});

describe("every call of a payout", () => {
  const cases = [
    { network: WITH_THE_EXPERIMENTS_COMMISSION, merchantId: MERCHANT_ID },
    {
      network: WITH_THE_EXPERIMENTS_COMMISSION,
      merchantId: "mch_ffffffffffffffffffffffffffffffff",
    },
    { network: LIVE_NETWORK, merchantId: MERCHANT_ID },
  ];

  it.each(cases)(
    "names one split on $network.network for $merchantId",
    ({ network, merchantId }) => {
      const split = payoutSplitFor(network, merchantId, MERCHANT);
      const golden = handEncoded.splits.find(
        (vector) =>
          vector.network === network.network &&
          vector.merchantId === merchantId &&
          vector.commissionWallet === network.commissionWallet,
      );
      const salt = handEncoded.salts.find(
        (vector) => vector.network === network.network && vector.merchantId === merchantId,
      );
      const [create, distribute, withdraw, commission, ...more] = callsOf(
        merchantPayout(network, [split], NETWORKS).data,
      );
      if (
        create === undefined ||
        distribute === undefined ||
        withdraw === undefined ||
        commission === undefined
      ) {
        throw new Error("a call is missing");
      }

      expect(more).toStrictEqual([]);
      expect(create.target).toBe(ON_CHAIN.factory);
      // createSplitDeterministic(split, owner, creator, salt), the split's
      // recipients and allocations at fixed words for two recipients.
      expect(addressIn(argumentOf(create.data, 1))).toBe(ZERO);
      expect(argumentOf(create.data, 3)).toBe(word(salt?.salt ?? "missing"));
      expect(addressIn(argumentOf(create.data, 9))).toBe(MERCHANT.toLowerCase());
      expect(addressIn(argumentOf(create.data, 10))).toBe(network.commissionWallet.toLowerCase());
      expect([argumentOf(create.data, 12), argumentOf(create.data, 13)]).toStrictEqual([
        word((999_000).toString(16)),
        word((1_000).toString(16)),
      ]);
      // The split the create names is the one distributed and the one recorded.
      expect(distribute.target).toBe(golden?.address.toLowerCase());
      expect(split.address).toBe(golden?.address);
      // distribute(split, token, distributor) and withdraw(owner, token).
      expect(addressIn(argumentOf(distribute.data, 1))).toBe(network.usdc.toLowerCase());
      expect(withdraw.target).toBe(network.warehouse.toLowerCase());
      expect(addressIn(argumentOf(withdraw.data, 0))).toBe(MERCHANT.toLowerCase());
      expect(addressIn(argumentOf(withdraw.data, 1))).toBe(network.usdc.toLowerCase());
      expect(commission.target).toBe(network.warehouse.toLowerCase());
      expect(commission.allowFailure).toBe(true);
      expect(addressIn(argumentOf(commission.data, 0))).toBe(
        network.commissionWallet.toLowerCase(),
      );
      expect(addressIn(argumentOf(commission.data, 1))).toBe(network.usdc.toLowerCase());
    },
  );
});

describe("a merchant's payout over every split that can hold their money", () => {
  it("creates and distributes each, then withdraws each of their wallets once and the commission last", () => {
    const { merchantOverTwoWallets } = handEncoded.payouts;
    const [first, second] = merchantOverTwoWallets.merchantWallets;
    const splits = [first, second].map((wallet) =>
      payoutSplitFor(WITH_THE_EXPERIMENTS_COMMISSION, merchantOverTwoWallets.merchantId, wallet),
    );

    expect(merchantPayout(WITH_THE_EXPERIMENTS_COMMISSION, splits, NETWORKS).data).toBe(
      merchantOverTwoWallets.data,
    );
  });

  it("withdraws the commission once for the whole transaction, never once per split", () => {
    const { merchantOverTwoWallets } = handEncoded.payouts;
    const splits = merchantOverTwoWallets.merchantWallets.map((wallet) =>
      payoutSplitFor(WITH_THE_EXPERIMENTS_COMMISSION, merchantOverTwoWallets.merchantId, wallet),
    );

    const calls = callsOf(merchantPayout(WITH_THE_EXPERIMENTS_COMMISSION, splits, NETWORKS).data);

    expect(calls.filter(({ data }) => data === WITHDRAW_A)).toHaveLength(1);
    expect(calls.at(-1)).toStrictEqual(call(ON_CHAIN.warehouse, true, WITHDRAW_A));
  });

  it("withdraws each commission wallet their splits recorded, once each and last", () => {
    // A split keeps the commission wallet it was made with, so a merchant's
    // older split may credit another one than their split in force does.
    const formerCommission = aWallet(99);
    const older = payoutSplitFor(
      { ...TEST_NETWORK, commissionWallet: formerCommission },
      S_ROW.merchantId,
      MERCHANT,
    );

    const calls = callsOf(
      merchantPayout(TEST_NETWORK, [S_ROW, older, S2_OF_THE_SAME_MERCHANT], NETWORKS).data,
    );

    expect(calls.slice(-3)).toStrictEqual([
      call(ON_CHAIN.warehouse, true, WITHDRAW_M),
      call(ON_CHAIN.warehouse, true, WITHDRAW_A),
      call(ON_CHAIN.warehouse, true, withdrawCall(formerCommission, ON_CHAIN.usdc)),
    ]);
  });

  it("withdraws a wallet two of their splits name only once", () => {
    const calls = callsOf(
      merchantPayout(TEST_NETWORK, [S_ROW, S2_OF_THE_SAME_MERCHANT], NETWORKS).data,
    );

    expect(calls).toStrictEqual([
      call(ON_CHAIN.factory, false, CREATE_S),
      call(S.address, true, DISTRIBUTE),
      call(ON_CHAIN.factory, false, CREATE_S2),
      call(S2.address, true, DISTRIBUTE),
      call(ON_CHAIN.warehouse, true, WITHDRAW_M),
      call(ON_CHAIN.warehouse, true, WITHDRAW_A),
    ]);
  });
});

describe("a payout's withdrawals", () => {
  it("withdraw a wallet once whichever spelling each of its splits recorded it in", () => {
    const lower = { ...S2_OF_THE_SAME_MERCHANT, merchantWallet: MERCHANT.toLowerCase() };
    const withdrawals = callsOf(merchantPayout(TEST_NETWORK, [S_ROW, lower], NETWORKS).data).filter(
      ({ target }) => target === ON_CHAIN.warehouse,
    );
    expect(withdrawals).toStrictEqual([
      call(ON_CHAIN.warehouse, true, WITHDRAW_M),
      call(ON_CHAIN.warehouse, true, WITHDRAW_A),
    ]);
  });
});

describe("a payout that would not do what it says", () => {
  it("is refused over no split at all", () => {
    expect(refusal(() => merchantPayout(TEST_NETWORK, [], NETWORKS))).toMatch(/no split/);
  });

  it("is refused over two merchants' splits, which one merchant's screen must not name", () => {
    expect(refusal(() => merchantPayout(TEST_NETWORK, [S_ROW, S2_ROW], NETWORKS))).toMatch(
      /merchant/,
    );
  });

  it("is refused for a split of another network", () => {
    const elsewhere = payoutSplitFor(LIVE_NETWORK, MERCHANT_ID, MERCHANT);
    expect(refusal(() => merchantPayout(TEST_NETWORK, [elsewhere], NETWORKS))).toMatch(
      /eip155:8453/,
    );
    expect(refusal(() => operatorPayouts(TEST_NETWORK, [S_ROW, elsewhere], NETWORKS))).toMatch(
      /eip155:8453/,
    );
  });

  it("is refused for a split whose address its own parameters do not give", () => {
    const mismatched = { ...S_ROW, salt: S2.salt };
    expect(refusal(() => merchantPayout(TEST_NETWORK, [mismatched], NETWORKS))).toMatch(
      new RegExp(S.address),
    );
    expect(refusal(() => operatorPayouts(TEST_NETWORK, [mismatched], NETWORKS))).toMatch(
      new RegExp(S.address),
    );
  });

  it("is refused for a split made by a factory this network does not name", () => {
    const foreign = { ...S_ROW, factory: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" };
    expect(refusal(() => merchantPayout(TEST_NETWORK, [foreign], NETWORKS))).toMatch(/factory/);
  });

  it("is refused where one split is named twice", () => {
    expect(refusal(() => merchantPayout(TEST_NETWORK, [S_ROW, S_ROW], NETWORKS))).toMatch(/twice/);
    expect(refusal(() => operatorPayouts(TEST_NETWORK, [S_ROW, S2_ROW, S_ROW], NETWORKS))).toMatch(
      /twice/,
    );
    const spelledLower = { ...S_ROW, address: S.address.toLowerCase() };
    expect(refusal(() => operatorPayouts(TEST_NETWORK, [S_ROW, spelledLower], NETWORKS))).toMatch(
      /twice/,
    );
  });

  it("is refused for a merchant over more than twenty splits, which no one transaction carries safely", () => {
    const many = Array.from({ length: 21 }, (_, index) =>
      payoutSplitFor(TEST_NETWORK, MERCHANT_ID, aWallet(index)),
    );
    expect(() => merchantPayout(TEST_NETWORK, many.slice(0, 20), NETWORKS)).not.toThrow();
    expect(refusal(() => merchantPayout(TEST_NETWORK, many, NETWORKS))).toMatch(/21.*20/s);
  });
});

describe("a payout that would withdraw a merchant's share to an address nobody can be paid at", () => {
  // A payout withdraws each share to the wallet its split names, and Multicall3
  // runs that withdrawal as itself: a share withdrawn to Multicall3 is taken by
  // whoever calls it next, and one withdrawn to a contract of the payout's own,
  // to a token or to a commission wallet never reaches the merchant. Saving
  // such a wallet is refused, and so is building a payout over a split that
  // names one anyway, on every network the gateway knows of.

  /** A split of this merchant that pays its share to `wallet`, at the address its own parameters give. */
  const payingTheShareTo = (wallet: string): PayoutSplit =>
    wallet === ZERO
      ? // No split pays the zero address: the parameters give no address at all.
        { ...payoutSplitFor(TEST_NETWORK, MERCHANT_ID, MERCHANT), merchantWallet: ZERO }
      : payoutSplitFor(TEST_NETWORK, MERCHANT_ID, wallet);

  it.each([
    ["the zero address", ZERO, /zero address/],
    ["another network's commission wallet", LIVE_NETWORK.commissionWallet, /commission wallet/],
    ["the split factory", TEST_NETWORK.factory, /factory/],
    ["the split implementation", TEST_NETWORK.implementation, /implementation/],
    ["the warehouse", TEST_NETWORK.warehouse, /warehouse/],
    ["Multicall3", TEST_NETWORK.multicall3, /Multicall3/],
    ["this network's USDC", TEST_NETWORK.usdc, /USDC/],
    ["another network's USDC", LIVE_NETWORK.usdc, /USDC/],
  ] as const)(
    "is refused where the share would go to %s, and the refusal says which",
    (_what, wallet, said) => {
      const split = payingTheShareTo(wallet);

      for (const refused of [
        refusal(() => merchantPayout(TEST_NETWORK, [split], NETWORKS)),
        refusal(() => operatorPayouts(TEST_NETWORK, [S_ROW, split], NETWORKS)),
      ]) {
        expect(refused).toContain(checksummedAddressOf(wallet));
        expect(refused).toMatch(said);
      }
    },
  );

  it("is built where the same split pays an ordinary wallet", () => {
    // The negative control: the refusals above are of the wallet, not of how
    // the split was put together.
    const split = payingTheShareTo(MERCHANT);

    expect(merchantPayout(TEST_NETWORK, [split], NETWORKS).splits).toStrictEqual([split]);
    expect(operatorPayouts(TEST_NETWORK, [S_ROW, split], NETWORKS)).toHaveLength(1);
  });
});

describe("the operator's payout", () => {
  it("creates and distributes every split, then withdraws each merchant wallet once and the commission last", () => {
    const { operator } = handEncoded.payouts;
    const later = payoutSplitFor(WITH_THE_EXPERIMENTS_COMMISSION, MERCHANT_ID, SECOND_WALLET);
    expect([S_ROW, S2_ROW, later].map(({ address }) => address)).toStrictEqual(operator.splits);

    const parts = operatorPayouts(TEST_NETWORK, [S_ROW, S2_ROW, later], NETWORKS);

    expect(parts).toHaveLength(1);
    expect(parts[0]?.to).toBe(MULTICALL3);
    expect(parts[0]?.value).toBe(0n);
    expect(parts[0]?.data).toBe(operator.data);
    expect(callsOf(parts[0]?.data ?? "").slice(0, 4)).toStrictEqual([
      call(ON_CHAIN.factory, false, CREATE_S),
      call(S.address, true, DISTRIBUTE),
      call(ON_CHAIN.factory, false, CREATE_S2),
      call(S2.address, true, DISTRIBUTE),
    ]);
    expect(callsOf(parts[0]?.data ?? "").slice(-3)).toStrictEqual([
      call(ON_CHAIN.warehouse, true, WITHDRAW_M),
      call(ON_CHAIN.warehouse, true, withdrawCall(SECOND_WALLET, ON_CHAIN.usdc)),
      call(ON_CHAIN.warehouse, true, WITHDRAW_A),
    ]);
  });

  it("is no transaction at all where there is no split", () => {
    expect(operatorPayouts(TEST_NETWORK, [], NETWORKS)).toStrictEqual([]);
  });
});

describe("the operator's payout over more splits than one transaction carries", () => {
  /** Splits of several merchants, every third one sharing the wallet of the one before. */
  const splitsOf = (count: number): PayoutSplit[] =>
    Array.from({ length: count }, (_, index) =>
      payoutSplitFor(
        WITH_THE_EXPERIMENTS_COMMISSION,
        `mch_${index}`,
        aWallet(index % 3 === 2 ? index - 1 : index),
      ),
    );

  it.each([
    [19, [19]],
    [20, [20]],
    [21, [20, 1]],
    [41, [20, 20, 1]],
  ])(
    "comes in parts of at most twenty for %i splits, none left out and none twice",
    (count, sizes) => {
      const splits = splitsOf(count);
      const parts = operatorPayouts(WITH_THE_EXPERIMENTS_COMMISSION, splits, NETWORKS);

      expect(parts.map((part) => part.splits.length)).toStrictEqual(sizes);
      const distributed: string[] = [];
      for (const part of parts) {
        const calls = callsOf(part.data);
        const own = part.splits;
        const head = calls.slice(0, own.length * 2);
        const tail = calls.slice(own.length * 2);
        own.forEach((split, index) => {
          expect(head[index * 2]?.target).toBe(ON_CHAIN.factory);
          expect(head[index * 2]?.allowFailure).toBe(false);
          expect(head[index * 2 + 1]?.target).toBe(split.address.toLowerCase());
          expect(head[index * 2 + 1]?.allowFailure).toBe(true);
        });
        distributed.push(...head.filter((_, index) => index % 2 === 1).map(({ target }) => target));
        // Each wallet this part's splits name, once, and then the commission.
        const wallets = [...new Set(own.map((split) => split.merchantWallet.toLowerCase()))];
        expect(tail.map(({ target }) => target)).toStrictEqual(
          [...wallets, COMMISSION].map(() => ON_CHAIN.warehouse),
        );
        expect(tail.map(({ data }) => addressIn(argumentOf(data, 0)))).toStrictEqual([
          ...wallets,
          COMMISSION.toLowerCase(),
        ]);
        expect(tail.every(({ allowFailure }) => allowFailure)).toBe(true);
        expect(part.to).toBe(MULTICALL3);
        expect(part.value).toBe(0n);
      }
      expect(distributed).toStrictEqual(splits.map(({ address }) => address.toLowerCase()));
    },
  );
});

describe("a dry run of a merchant's payout", () => {
  /** `balanceOf(address)`, USDC's read of what an address holds. */
  const BALANCE_OF = "70a08231";

  /** How Multicall3 answers `aggregate3`: each call's success and what it returned. */
  const answerOf = (results: readonly (readonly [boolean, Hex])[]): Hex =>
    encodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "success", type: "bool" },
            { name: "returnData", type: "bytes" },
          ],
        },
      ],
      [results.map(([success, returnData]) => ({ success, returnData }))],
    );

  const balance = (units: bigint): readonly [boolean, Hex] => [
    true,
    `0x${units.toString(16).padStart(WORD, "0")}`,
  ];

  /** What the payout itself answers inside the dry run; its words are not read. */
  const RAN: readonly [boolean, Hex] = [true, answerOf([])];

  const twoWallets = merchantPayout(
    WITH_THE_EXPERIMENTS_COMMISSION,
    handEncoded.payouts.merchantOverTwoWallets.merchantWallets.map((wallet) =>
      payoutSplitFor(
        WITH_THE_EXPERIMENTS_COMMISSION,
        handEncoded.payouts.merchantOverTwoWallets.merchantId,
        wallet,
      ),
    ),
    NETWORKS,
  );

  it("runs the very payout on the screen through Multicall3, between two reads of each wallet it pays", () => {
    // The payout's own calls run as Multicall3 inside it, as they do when it
    // is sent, so what the chain answers is what sending it now would do.
    const payout = merchantPayout(TEST_NETWORK, [S_ROW, S2_OF_THE_SAME_MERCHANT], NETWORKS);
    const run = payoutDryRun(TEST_NETWORK, payout);
    const readOf = (wallet: string) =>
      call(TEST_NETWORK.usdc, false, `0x${BALANCE_OF}${word(wallet)}`);

    expect(run.to).toBe(MULTICALL3);
    expect(callsOf(run.data)).toStrictEqual([
      readOf(MERCHANT),
      call(MULTICALL3, false, payout.data),
      readOf(MERCHANT),
    ]);
  });

  it("reads each wallet a payout over two wallets pays, in the order it pays them", () => {
    const [first, second] = handEncoded.payouts.merchantOverTwoWallets.merchantWallets;
    const reads = callsOf(payoutDryRun(TEST_NETWORK, twoWallets).data)
      .filter(({ target }) => target === TEST_NETWORK.usdc.toLowerCase())
      .map(({ data }) => addressIn(argumentOf(data, 0)));

    expect(reads).toStrictEqual([first, second, first, second].map((w) => w.toLowerCase()));
  });

  it("counts what the payout adds to its wallets together, and not what they held before it", () => {
    const run = payoutDryRun(TEST_NETWORK, twoWallets);

    const brought = broughtBy(
      run,
      answerOf([balance(5n), balance(70n), RAN, balance(1_005n), balance(70n)]),
    );

    expect(brought).toBe(1_000n);
  });

  it("counts nothing where the payout adds nothing", () => {
    const run = payoutDryRun(TEST_NETWORK, merchantPayout(TEST_NETWORK, [S_ROW], NETWORKS));

    expect(broughtBy(run, answerOf([balance(42n), RAN, balance(42n)]))).toBe(0n);
  });

  it.each([
    ["a result missing", [balance(5n), RAN]],
    ["a read that failed", [balance(5n), RAN, [false, "0x"] as const]],
    ["a payout that failed", [balance(5n), [false, "0x"] as const, balance(5n)]],
    ["a wallet holding less after the payout", [balance(5n), RAN, balance(4n)]],
  ])("is no answer where the chain's reply has %s", (_, results) => {
    const run = payoutDryRun(TEST_NETWORK, merchantPayout(TEST_NETWORK, [S_ROW], NETWORKS));

    expect(refusal(() => broughtBy(run, answerOf(results)))).not.toBe("");
  });

  it("is refused for a payout sent anywhere but this network's Multicall3", () => {
    const payout = merchantPayout(TEST_NETWORK, [S_ROW], NETWORKS);

    expect(
      refusal(() => payoutDryRun(TEST_NETWORK, { ...payout, to: TEST_NETWORK.warehouse })),
    ).toMatch(/Multicall3/);
  });
});

/** Why building a payout threw, or a failure of the test where it built one. */
function refusal(build: () => unknown): string {
  try {
    build();
  } catch (thrown) {
    return thrown instanceof Error ? thrown.message : String(thrown);
  }
  throw new Error("a payout was built");
}

/** A wallet no other index gives: all digits, so it is its own checksummed spelling. */
function aWallet(index: number): string {
  return `0x${(index + 1).toString().padStart(40, "0")}`;
}

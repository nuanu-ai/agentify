/**
 * Where a payout split's USDC goes, held against what Base Sepolia did with
 * the experiment's eighteen transactions: what each was sent to do comes from
 * the gateway's fixture of those transactions, what the chain then showed
 * from the receipts and balances read back beside this file. The smoke's
 * predictions are made by this arithmetic, so a difference here is a
 * prediction that would fail on the chain, or one that would pass a payout
 * that paid somebody else.
 */

import { readFileSync } from "node:fs";
import { decodeFunctionData, getAddress, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { type Ledger, type Move, play, type SplitShares } from "./split-ledger.js";

interface Recorded {
  readonly held: Readonly<Record<string, string>>;
  readonly credited: Readonly<Record<string, string>>;
}

interface Observed {
  readonly parties: Readonly<Record<string, string>>;
  readonly transactions: readonly {
    readonly hash: string;
    readonly block: number;
    readonly status: string;
    readonly transfers: readonly {
      readonly from: string;
      readonly to: string;
      readonly value: string;
    }[];
    readonly distributed: readonly { readonly split: string; readonly amount: string }[];
    readonly before: Recorded;
    readonly after: Recorded;
  }[];
}

interface Sent {
  readonly parameters: {
    readonly recipients: readonly string[];
    readonly allocations: readonly number[];
    readonly totalAllocation: number;
  };
  readonly transactions: readonly {
    readonly label: string;
    readonly hash: string;
    readonly to: string;
    readonly input: `0x${string}`;
  }[];
}

const observed = JSON.parse(
  readFileSync(new URL("./base-sepolia-experiment-ledgers.json", import.meta.url), "utf8"),
) as Observed;

const sent = JSON.parse(
  readFileSync(
    new URL("../../../apps/gateway/src/split/base-sepolia-experiment.json", import.meta.url),
    "utf8",
  ),
) as Sent;

const { warehouse } = observed.parties as { warehouse: string };

const addressOf = (name: string): string => {
  const address = observed.parties[name];
  if (address === undefined) {
    throw new Error(`the experiment names no party ${name}`);
  }
  return address;
};

const ledgerOf = (recorded: Recorded): Ledger => {
  const amounts = (record: Readonly<Record<string, string>>) =>
    Object.fromEntries(
      Object.entries(record).map(([name, value]) => [addressOf(name), BigInt(value)]),
    );
  return { held: amounts(recorded.held), credited: amounts(recorded.credited) };
};

const ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function withdraw(address owner, address token)",
]);

const sharesOf = (split: string): SplitShares => ({
  address: getAddress(split),
  recipients: sent.parameters.recipients,
  allocations: sent.parameters.allocations,
  totalAllocation: sent.parameters.totalAllocation,
});

/** What each experiment transaction was sent to do, read from the bytes it carried. */
const movesOf = (transaction: Sent["transactions"][number]): readonly Move[] => {
  if (transaction.label === "createSplitDeterministic") {
    return [];
  }
  if (transaction.label === "distribute") {
    return [{ kind: "distribute", split: sharesOf(transaction.to) }];
  }
  const call = decodeFunctionData({ abi: ABI, data: transaction.input });
  if (call.functionName === "transferWithAuthorization") {
    const [from, to, value] = call.args;
    return [{ kind: "pay", from, to, value }];
  }
  const [owner] = call.args;
  return [{ kind: "withdraw", owner }];
};

const replayed = sent.transactions.map((transaction, at) => {
  const chain = observed.transactions[at];
  if (chain === undefined || chain.hash !== transaction.hash) {
    throw new Error(`the two fixtures disagree on the experiment's transaction ${at}`);
  }
  return { ...transaction, chain, moves: movesOf(transaction) };
});

describe("a payout split's USDC, as the split and the warehouse move it", () => {
  it.each(
    replayed.map(
      (transaction) => [transaction.label, transaction.chain.block, transaction] as const,
    ),
  )("moves the experiment's %s at block %i exactly as Base Sepolia did", (_, __, transaction) => {
    const played = play(ledgerOf(transaction.chain.before), warehouse, transaction.moves);

    expect(played.ledger).toStrictEqual(ledgerOf(transaction.chain.after));
    expect(played.transfers).toStrictEqual(
      transaction.chain.transfers.map((transfer) => ({
        from: addressOf(transfer.from),
        to: addressOf(transfer.to),
        value: BigInt(transfer.value),
      })),
    );
    expect(played.distributed).toStrictEqual(
      transaction.chain.distributed.map((distribution) => BigInt(distribution.amount)),
    );
    expect(played.refused).toStrictEqual([]);
  });

  it("ends the experiment's four payments where the chain ended them, every unit with a recipient or in a one-unit residue", () => {
    const [first] = replayed;
    const last = replayed.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error("the experiment has no transactions");
    }

    let ledger = ledgerOf(first.chain.before);
    for (const transaction of replayed) {
      ledger = play(ledger, warehouse, transaction.moves).ledger;
    }

    expect(ledger).toStrictEqual(ledgerOf(last.chain.after));
    const merchant = addressOf("merchant");
    const commission = addressOf("commission");
    const residues = [addressOf("S"), addressOf("S2")].flatMap((split) => [
      ledger.held[split],
      ledger.credited[split],
    ]);
    expect(residues).toStrictEqual([1n, 1n, 1n, 1n]);
    expect([ledger.credited[merchant], ledger.credited[commission]]).toStrictEqual([1n, 1n]);
    expect((ledger.held[merchant] ?? 0n) + (ledger.held[commission] ?? 0n) + 6n).toBe(4_000_000n);
  });

  it("pays nothing to an owner the warehouse credits nothing, which it refuses, and leaves every balance as it was", () => {
    const merchant = addressOf("merchant");
    const ledger: Ledger = { held: { [merchant]: 5n }, credited: { [merchant]: 0n } };

    const played = play(ledger, warehouse, [{ kind: "withdraw", owner: merchant.toLowerCase() }]);

    expect(played.ledger).toStrictEqual(ledger);
    expect(played.transfers).toStrictEqual([]);
    expect(played.refused).toStrictEqual([merchant]);
  });

  it("pays an owner credited one unit a transfer of nothing, which the warehouse makes rather than refuses", () => {
    const merchant = addressOf("merchant");

    const played = play({ held: { [merchant]: 5n }, credited: { [merchant]: 1n } }, warehouse, [
      { kind: "withdraw", owner: merchant },
    ]);

    expect(played.transfers).toStrictEqual([
      { from: getAddress(warehouse), to: merchant, value: 0n },
    ]);
    expect(played.ledger).toStrictEqual({ held: { [merchant]: 5n }, credited: { [merchant]: 1n } });
    expect(played.refused).toStrictEqual([]);
  });

  it("distributes nothing from a split holding one unit and credited one, moving no USDC", () => {
    const split = sharesOf(addressOf("S"));
    const ledger: Ledger = { held: { [split.address]: 1n }, credited: { [split.address]: 1n } };

    const played = play(ledger, warehouse, [{ kind: "distribute", split }]);

    expect(played.distributed).toStrictEqual([0n]);
    expect(played.transfers).toStrictEqual([]);
    expect(played.ledger.held[split.address]).toBe(1n);
    expect(played.ledger.credited[split.address]).toBe(1n);
  });
});

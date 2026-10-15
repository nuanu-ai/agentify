/**
 * Where a payout split's USDC goes, worked out the way the 0xSplits v2.2
 * contracts move it, to the minimal unit. A distribution keeps one unit on
 * the split and one of its credit in the warehouse, deposits the rest of what
 * the split holds, and credits each recipient its share of everything above
 * those two units, rounded down; what the rounding leaves stays credited to
 * the split. A withdrawal pays an owner all its credit but one unit, and the
 * warehouse refuses it outright at a credit of nothing.
 *
 * The warehouse's own USDC balance is not kept: it holds every split's money
 * on the chain, so only the credits it owes the parties are.
 */

import { getAddress } from "viem";

/** USDC in minimal units, by checksummed address. */
type Amounts = Readonly<Record<string, bigint>>;

/** The USDC each party holds, and the USDC the warehouse credits each. */
export interface Ledger {
  readonly held: Amounts;
  readonly credited: Amounts;
}

/** One USDC `Transfer` a transaction emits. */
export interface UsdcTransfer {
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
}

/** A split as its distribution reads it: where it is, and how it shares. */
export interface SplitShares {
  readonly address: string;
  readonly recipients: readonly string[];
  readonly allocations: readonly number[];
  readonly totalAllocation: number;
}

/** One thing a transaction does with USDC. */
export type Move =
  /** A transfer between two parties, as a buyer's payment to a split is. */
  | { readonly kind: "pay"; readonly from: string; readonly to: string; readonly value: bigint }
  | { readonly kind: "distribute"; readonly split: SplitShares }
  | { readonly kind: "withdraw"; readonly owner: string };

/** What the moves leave behind. */
export interface Played {
  readonly ledger: Ledger;
  /** The USDC transfers, in the order the contracts make them. */
  readonly transfers: readonly UsdcTransfer[];
  /** What each distribution shared out, in order, as its `SplitDistributed` says. */
  readonly distributed: readonly bigint[];
  /** The owners whose withdrawal the warehouse refused, for want of any credit. */
  readonly refused: readonly string[];
}

/** One less than the amount, or nothing where there is nothing: the unit a contract keeps. */
const allButOne = (amount: bigint): bigint => (amount > 0n ? amount - 1n : 0n);

/** The moves played in order on a ledger, which is left as it was. */
export function play(ledger: Ledger, warehouse: string, moves: readonly Move[]): Played {
  const held: Record<string, bigint> = { ...ledger.held };
  const credited: Record<string, bigint> = { ...ledger.credited };
  const transfers: UsdcTransfer[] = [];
  const distributed: bigint[] = [];
  const refused: string[] = [];
  const vault = getAddress(warehouse);
  const of = (amounts: Record<string, bigint>, address: string): bigint => amounts[address] ?? 0n;

  for (const move of moves) {
    switch (move.kind) {
      case "pay": {
        const from = getAddress(move.from);
        const to = getAddress(move.to);
        held[from] = of(held, from) - move.value;
        held[to] = of(held, to) + move.value;
        transfers.push({ from, to, value: move.value });
        break;
      }
      case "distribute": {
        const split = getAddress(move.split.address);
        const deposit = allButOne(of(held, split));
        const amount = deposit + allButOne(of(credited, split));
        if (deposit > 0n) {
          held[split] = of(held, split) - deposit;
          credited[split] = of(credited, split) + deposit;
          transfers.push({ from: split, to: vault, value: deposit });
        }
        move.split.recipients.forEach((recipient, at) => {
          const share =
            (amount * BigInt(move.split.allocations[at] ?? 0)) / BigInt(move.split.totalAllocation);
          const owner = getAddress(recipient);
          credited[owner] = of(credited, owner) + share;
          credited[split] = of(credited, split) - share;
        });
        distributed.push(amount);
        break;
      }
      case "withdraw": {
        const owner = getAddress(move.owner);
        const credit = of(credited, owner);
        if (credit === 0n) {
          refused.push(owner);
          break;
        }
        credited[owner] = 1n;
        held[owner] = of(held, owner) + credit - 1n;
        transfers.push({ from: vault, to: owner, value: credit - 1n });
        break;
      }
    }
  }

  return { ledger: { held, credited }, transfers, distributed, refused };
}

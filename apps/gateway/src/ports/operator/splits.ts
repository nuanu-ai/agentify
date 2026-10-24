/**
 * The reads of the registry of payout splits the workspace makes across
 * merchants: one row per split with what settled into it, for Money. A split
 * waiting behind a merchant's pending wallet change stays inside the registry:
 * nothing here hands out its address.
 */

import type { FiguresAsked, Read } from "./figures.js";
import type { Tally } from "./money.js";

/** One payout split as Money lists it. */
export interface SplitRow {
  /** Where buyers paid, in the checksummed spelling. */
  readonly address: string;
  readonly merchantId: string;
  /** The merchant's name, or null where the merchant is no longer on the channel. */
  readonly merchantName: string | null;
  /** The wallet it pays the merchant's share to. */
  readonly merchantWallet: string;
  /** The wallet it pays the commission to. */
  readonly commissionWallet: string;
  /** When the split was first recorded. */
  readonly recordedAt: number;
  /** Whether buyers are asked to pay into it now, rather than into a later split of the same merchant. */
  readonly inForce: boolean;
  /**
   * Every sale whose payment settled into it, summed from the orders. What it
   * has already paid out is on the chain, not here.
   */
  readonly settled: Tally;
}

/** How many splits a read lists; the rest are counted. */
export const SPLITS_LISTED_AT_MOST = 50;

export interface Splits extends Read {
  /** The splits holding the most settled first, then the newest; at most `SPLITS_LISTED_AT_MOST`. */
  readonly rows: readonly SplitRow[];
  /** How many splits there are to list, the waiting ones left out. */
  readonly of: number;
  /** Of them, how many have nothing settled into them. */
  readonly empty: number;
  /** How many splits wait behind a wallet change not yet in force, which are not listed. */
  readonly waiting: number;
}

export interface OperatorSplits {
  /** Every split recorded on the channel's network but the waiting ones, with what settled into each. */
  splits(asked: FiguresAsked): Promise<Splits>;
}

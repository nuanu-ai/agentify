import type { PayoutTransaction } from "../split/payout.js";

/**
 * Why what a payout would bring was not read: the endpoint serves another
 * chain, did not answer, reverted the run, answered it with nothing or with
 * something that is not its answer, or did not answer within the time the
 * page had for it.
 */
export type PayoutCheckFailed =
  | "WRONG_CHAIN"
  | "UNANSWERED"
  | "REVERTED"
  | "EMPTY_ANSWER"
  | "NOT_THE_DRY_RUN"
  | "TOO_SLOW";

/** A read that gave no answer; its code is what the operator's log names. */
export class PayoutCheckFailure extends Error {
  override readonly name = "PayoutCheckFailure";

  constructor(
    readonly code: PayoutCheckFailed,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * What a merchant's payout would bring if it were sent now, as the chain runs
 * it without sending it. Read and never written.
 */
export interface PayoutCheck {
  /**
   * The USDC, in millionths, that sending `payout` now would add to the
   * wallets it withdraws to, together, if the chain answers within
   * `withinMs`. It throws a `PayoutCheckFailure` where there is no answer,
   * which is not an answer of nothing.
   */
  wouldBring(payout: PayoutTransaction, withinMs: number): Promise<bigint>;
}

import type { PayoutTransaction } from "../split/payout.js";

/**
 * What a merchant's payout would bring if it were sent now, as the chain runs
 * it without sending it. Read and never written.
 */
export interface PayoutCheck {
  /**
   * The USDC, in millionths, that sending `payout` now would add to the
   * wallets it withdraws to, together. It throws where the chain could not be
   * asked, or answered something that is not this question's answer; that is
   * not an answer of nothing.
   */
  wouldBring(payout: PayoutTransaction): Promise<bigint>;
}

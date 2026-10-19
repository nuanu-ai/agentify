/**
 * The payment facilitator. Verification and execution are separate calls
 * because in the synchronous mode the charge is executed only after the goods
 * come back, so a merchant's refusal costs the buyer nothing.
 *
 * Each call has three outcomes, not two: "could not find out" is not "no". An
 * agent told a purchase did not happen may buy it again elsewhere, so neither
 * call throws on a silence or rounds it to a verdict; it answers `"unknown"`.
 */

import type { PaymentVerificationFailure } from "@agentify/core";

/**
 * One charge, as the payment layer needs to see it. The payment is passed on
 * verbatim and not parsed here: its contents belong to the payment protocol.
 */
export interface Charge {
  readonly orderId: string;
  readonly amount: string;
  readonly currency: string;
  readonly payment: string;
  /**
   * The address this order is paid at, the merchant's recorded split, or null
   * where there is none. The payment is checked against our own copy of it,
   * never the one inside the payment.
   *
   * It is read from the merchant at verification, so a payment made out to a
   * split they have since moved off is refused. From then on it is kept on the
   * order and reused for the charge: reading the merchant again would charge
   * against an address the buyer never signed for, possibly after the goods
   * went out.
   */
  readonly payTo: string | null;
}

export type VerifyOutcome =
  | {
      readonly verified: true;
      readonly payer: string | null;
      /**
       * The instant the payment's authorisation stops being valid, as the
       * payment it verified was signed with, or null where the payment names
       * none this gateway can read.
       */
      readonly validUntil: number | null;
    }
  | {
      readonly verified: false;
      readonly reason: PaymentVerificationFailure;
      readonly message: string;
    }
  /** The facilitator could not be asked, or did not answer. Nothing is claimed. */
  | { readonly verified: "unknown"; readonly message: string };

export type SettleOutcome =
  | { readonly settled: true; readonly transaction: string }
  | { readonly settled: false; readonly reason: string }
  /**
   * The charge was asked for and nothing came back; the money may or may not
   * have moved. No second charge is ever sent for it.
   */
  | { readonly settled: "unknown"; readonly reason: string };

export interface Facilitator {
  verify(charge: Charge): Promise<VerifyOutcome>;
  settle(charge: Charge): Promise<SettleOutcome>;
}

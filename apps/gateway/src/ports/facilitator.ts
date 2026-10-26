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
  /**
   * The order's identifier, the one name for the order the payment layer is
   * given. What it is sent can be published by a discovery listing, so it
   * carries nothing that opens the order.
   */
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

export interface PaymentRecoveryContext {
  readonly kind: "evm-exact-eip3009";
  readonly network: string;
  readonly asset: string;
  readonly payer: string;
  readonly payTo: string;
  readonly amount: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: string;
  /**
   * The chain time, in Unix seconds, before which the transfer cannot have
   * happened: the authorization was still unused when it was checked, less an
   * allowance for the difference between our clock and the chain's.
   */
  readonly notBefore: string;
}

export interface PaymentRecoveryRequest {
  readonly context: PaymentRecoveryContext;
  /** A search hint, never evidence that money moved. */
  readonly transaction?: string;
  /** The next block to read, as an earlier search left it. */
  readonly nextBlock?: string;
}

/**
 * Recovery could not reach a verdict for a reason an operator has to act on:
 * the chain could not be read, or what was saved cannot be searched for. Its
 * message is safe to log, since it names the call, the endpoint's host and the
 * kind of failure, never the endpoint's path or query, where a provider key
 * can sit.
 */
export class RecoveryFailure extends Error {
  override readonly name = "RecoveryFailure";
}

export type PaymentRecoveryOutcome =
  | { readonly settled: true; readonly transaction: string; readonly executedAt: number }
  | { readonly settled: false; readonly reason: string }
  | {
      readonly settled: "unknown";
      readonly reason: string;
      readonly nextBlock?: string;
      /**
       * Why the search stopped before it was done, in a `RecoveryFailure`'s
       * words: a read the endpoint refused. What it read before is kept in
       * `nextBlock`, so a rate-limited endpoint still makes progress.
       */
      readonly failure?: string;
    };

export type VerifyOutcome =
  | {
      readonly verified: true;
      readonly payer: string | null;
      readonly recovery?: PaymentRecoveryContext;
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
  /**
   * No verdict on the payment, and nothing is claimed; `cause` says why.
   * `failure` is for the operator's log: Agentify's own sentence where the
   * question could not be put or the answer contradicted the payment, or the
   * name of what failed where the facilitator could not be reached. A buyer
   * never reads it.
   */
  | { readonly verified: "unknown"; readonly cause: NoVerdict; readonly failure: string };

/**
 * Why a payment got no verdict: the facilitator could not be reached, did not
 * answer or failed on its own side, which asking again may cure; it turned
 * away Agentify itself (its credentials, the address it was sent to, the
 * place it asked from) or the terms Agentify asked it to check, which lasts
 * until an operator acts; the order as it stands cannot pay its seller,
 * because nowhere to pay is recorded or the facilitator refused the seller's
 * address; or the facilitator vouched for the payment naming a payer other
 * than the wallet that signed it.
 */
export type NoVerdict =
  | "no_answer"
  | "refused_agentify"
  | "seller_cannot_be_paid"
  | "payer_contradicted";

export type SettleOutcome =
  | { readonly settled: true; readonly transaction: string }
  | { readonly settled: false; readonly reason: string }
  /**
   * The charge was asked for and nothing came back; the money may or may not
   * have moved. No second charge is ever sent for it.
   */
  | { readonly settled: "unknown"; readonly reason: string; readonly transaction?: string };

export interface Facilitator {
  verify(charge: Charge): Promise<VerifyOutcome>;
  settle(charge: Charge): Promise<SettleOutcome>;
  /**
   * Looks for a submitted charge's outcome on the chain, without submitting
   * anything. It throws a `RecoveryFailure` when it cannot look, which is not
   * an answer about the payment.
   */
  reconcile?(request: PaymentRecoveryRequest): Promise<PaymentRecoveryOutcome>;
  /**
   * Reconstructs recovery from the saved charge, without submitting a payment.
   * `since` is an instant, in milliseconds, before which the payment cannot
   * have been checked, such as the order's creation.
   */
  recoveryFor?(charge: Charge, since: number): Promise<PaymentRecoveryContext | null>;
}

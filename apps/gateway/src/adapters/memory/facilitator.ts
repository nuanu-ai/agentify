/**
 * The facilitator, scripted: a test says what the payment layer will answer
 * and reads back every call it was asked, which is how "never charged twice"
 * is checked. The default answers are the happy ones.
 */

import type { PaymentVerificationFailure } from "@agentify/core";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { Charge, Facilitator, SettleOutcome, VerifyOutcome } from "../../ports/facilitator.js";

/**
 * Who the payment layer would say paid: `payload.authorization.from` of the
 * presented payment, verbatim and unverified, as the real exact-EVM
 * facilitator returns it. Normalising the spelling is `walletThatPaid`'s job
 * in `app/gateway.ts`, not this adapter's, so the sandbox is no tidier than
 * the real layer.
 *
 * A payment that names no signer gives `null`, as the real adapter does. Do
 * not invent a stand-in payer here: it would make every such payment one buyer
 * and hand the second sender the first one's purchase.
 */
const scriptedPayer = (payment: string): string | null => {
  let signed: unknown;
  try {
    signed = decodePaymentSignatureHeader(payment).payload;
  } catch {
    return null;
  }

  const from = (signed as { authorization?: { from?: unknown } } | undefined)?.authorization?.from;
  return typeof from === "string" ? from : null;
};

export class ScriptedFacilitator implements Facilitator {
  readonly verifies: Charge[] = [];
  readonly settles: Charge[] = [];

  #verifyOutcomes: VerifyOutcome[] = [];
  #settleOutcomes: SettleOutcome[] = [];
  #settlements = 0;
  #verifyGate: Promise<void> | null = null;
  #settleGate: Promise<void> | null = null;

  /** The next verification answers this, and the ones after it the last one. */
  willVerify(...outcomes: VerifyOutcome[]): this {
    this.#verifyOutcomes = outcomes;
    return this;
  }

  willRefuseVerification(
    reason: PaymentVerificationFailure,
    message = "refused in the script",
  ): this {
    return this.willVerify({ verified: false, reason, message });
  }

  willSettle(...outcomes: SettleOutcome[]): this {
    this.#settleOutcomes = outcomes;
    return this;
  }

  /**
   * Holds every verification until the returned function is called, so a test
   * can put two presentations of one order past verification at once.
   */
  holdVerification(): () => void {
    let release: () => void = () => undefined;
    this.#verifyGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  /**
   * Holds every settlement until the returned function is called. The call is
   * recorded before the wait, so a test can see a charge that went out and has
   * not come back.
   */
  holdSettle(): () => void {
    let release: () => void = () => undefined;
    this.#settleGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  async verify(charge: Charge): Promise<VerifyOutcome> {
    this.verifies.push(charge);
    if (this.#verifyGate !== null) {
      await this.#verifyGate;
    }
    return next(this.#verifyOutcomes, this.verifies.length, {
      verified: true,
      payer: scriptedPayer(charge.payment),
    });
  }

  async settle(charge: Charge): Promise<SettleOutcome> {
    this.settles.push(charge);
    this.#settlements += 1;
    if (this.#settleGate !== null) {
      await this.#settleGate;
    }
    return next(this.#settleOutcomes, this.#settlements, {
      settled: true,
      transaction: `0xtx${this.#settlements}`,
    });
  }
}

function next<T>(scripted: readonly T[], call: number, fallback: T): T {
  if (scripted.length === 0) {
    return fallback;
  }
  return scripted[Math.min(call, scripted.length) - 1] ?? fallback;
}

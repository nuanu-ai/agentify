/**
 * The facilitator, over HTTP, through the official `@x402/core` client. The
 * requirements handed to it are always rebuilt from our own order, never taken
 * from the payment, so a payment against a price the agent invented fails.
 *
 * A silence is not a no, and a no is not a silence: a 4xx carrying the
 * facilitator's verdict is that verdict, and everything else (a 5xx, a
 * timeout, no connection) is "unknown". A verification failure's reason is a
 * best fit among three codes; the facilitator's own string is kept in the
 * message.
 */

import type { PaymentVerificationFailure } from "@agentify/core";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import {
  type PaymentPayload,
  type PaymentRequirements,
  SettleError,
  type SettleResponse,
  VerifyError,
  type VerifyResponse,
} from "@x402/core/types";
import { authorisedUntil, type PaymentEdge } from "../../http/x402.js";
import type { Charge, Facilitator, SettleOutcome, VerifyOutcome } from "../../ports/facilitator.js";

export class X402Facilitator implements Facilitator {
  readonly #client: FacilitatorClient;
  readonly #edge: PaymentEdge;

  constructor(client: FacilitatorClient, edge: PaymentEdge) {
    this.#client = client;
    this.#edge = edge;
  }

  async verify(charge: Charge): Promise<VerifyOutcome> {
    const payload = decoded(charge.payment);
    if (payload === null) {
      return {
        verified: false,
        reason: "signature",
        message: "the payment presented could not be read as a payment at all",
      };
    }

    let requirements: PaymentRequirements;
    try {
      requirements = this.#requirements(charge);
    } catch (thrown) {
      // Our own side of the question could not be built (no payout address,
      // a currency we cannot charge in). That is not a verdict on the payment,
      // so it must not be reported as a refusal.
      return { verified: "unknown", message: describe(thrown) };
    }

    const mismatch = wrongOffer(payload.accepted, requirements);
    if (mismatch !== null) {
      // Paid against something other than what we asked for: not a payment for
      // this order, whatever the facilitator would say.
      return { verified: false, reason: "price_stale", message: mismatch };
    }

    let answered: VerifyResponse;
    try {
      answered = await this.#client.verify(payload, requirements);
    } catch (thrown) {
      // A verdict sent with a refusing status is still a verdict.
      if (thrown instanceof VerifyError && refused(thrown.statusCode)) {
        const said = thrown.invalidMessage ?? thrown.invalidReason ?? "no reason was given";
        return { verified: false, reason: shapeOf(thrown.invalidReason), message: said };
      }
      return { verified: "unknown", message: describe(thrown) };
    }

    if (answered.isValid) {
      // The end comes from the payment the facilitator has just checked the
      // signature of, so it is the one the payer signed.
      return {
        verified: true,
        payer: answered.payer ?? null,
        validUntil: authorisedUntil(payload),
      };
    }
    const said = answered.invalidMessage ?? answered.invalidReason ?? "no reason was given";
    return { verified: false, reason: shapeOf(answered.invalidReason), message: said };
  }

  async settle(charge: Charge): Promise<SettleOutcome> {
    const payload = decoded(charge.payment);
    if (payload === null) {
      throw new Error(
        `the charge on ${charge.orderId} was to be executed and the payment kept for it cannot be read`,
      );
    }
    // Throws with its own sentence, which points the reader at the merchant's
    // settings rather than at the payment.
    const requirements = this.#requirements(charge);

    let answered: SettleResponse;
    try {
      answered = await this.#client.settle(payload, requirements);
    } catch (thrown) {
      // Turned away (for example `self_send_not_allowed`, a payer paying
      // himself): the request was refused before anything ran, so no money
      // moved.
      if (thrown instanceof SettleError && refused(thrown.statusCode)) {
        return {
          settled: false,
          reason: thrown.errorMessage ?? thrown.errorReason ?? "no reason was given",
        };
      }
      // A timeout or an internal failure may have completed the settlement
      // before it stopped answering. Nothing is claimed and no second charge is
      // sent.
      return { settled: "unknown", reason: describe(thrown) };
    }

    if (answered.success) {
      return { settled: true, transaction: answered.transaction };
    }
    return {
      settled: false,
      reason: answered.errorMessage ?? answered.errorReason ?? "no reason was given",
    };
  }

  /**
   * What this payment should have been paid against, rebuilt from our own
   * order. It throws, rather than answering null like the decode, because
   * every failure here is on our side and must not read as "this is not a
   * payment".
   */
  #requirements(charge: Charge) {
    return this.#edge.requirementsFor(charge, charge.orderId, charge.payTo);
  }
}

function decoded(payment: string): PaymentPayload | null {
  try {
    return decodePaymentSignatureHeader(payment);
  } catch {
    return null;
  }
}

/**
 * What an agent accepted, against what we asked for. These fields are the
 * agent's unsigned copy of our offer, so passing this proves nothing: it is
 * only a cheap early refusal. The payment is bound to the order by the claim
 * taken on it and to the amount by the facilitator's signature check.
 */
function wrongOffer(
  accepted:
    | {
        amount?: string;
        asset?: string;
        network?: string;
        payTo?: string;
        extra?: Record<string, unknown>;
      }
    | undefined,
  ours: {
    amount: string;
    asset: string;
    network: string;
    payTo: string;
    extra: Record<string, unknown>;
  },
): string | null {
  if (accepted === undefined) {
    return "the payment names no offer, so there is nothing to check it against";
  }
  if (accepted.amount !== ours.amount) {
    return `this order is priced at ${ours.amount} and the payment was made for ${accepted.amount ?? "nothing"}`;
  }
  if (!sameAddress(accepted.asset, ours.asset) || accepted.network !== ours.network) {
    return "the payment was made in a different asset or on a different chain from the one asked for";
  }
  if (!sameAddress(accepted.payTo, ours.payTo)) {
    return "the payment was made out to a different address from the one asked for";
  }
  if (accepted.extra?.order_id !== ours.extra.order_id) {
    return "the payment was made against a different order from the one it was presented for";
  }
  return null;
}

/**
 * Whether two chain addresses are the same, ignoring case. An address has a
 * checksummed and a lower-case spelling, and an agent's client may send back
 * either; the checksum is enforced where a merchant enters their address.
 */
const sameAddress = (theirs: string | undefined, ours: string): boolean =>
  theirs !== undefined && theirs.toLowerCase() === ours.toLowerCase();

/**
 * The closest of the machine's three reasons to what the facilitator said. The
 * facilitator's set of reasons is open; an unrecognised one is recorded as
 * `signature`.
 */
function shapeOf(reason: string | undefined): PaymentVerificationFailure {
  const said = (reason ?? "").toLowerCase();
  if (said.includes("funds") || said.includes("balance") || said.includes("revert")) {
    return "insufficient_funds";
  }
  if (said.includes("authorization_value") || said.includes("amount") || said.includes("expired")) {
    return "price_stale";
  }
  return "signature";
}

/**
 * Whether a status carries the facilitator's own decision: a 4xx declines the
 * request before anything moved, a 5xx may fail after. Only a body shaped as a
 * verdict reaches here, so a proxy's error page or an empty 429 stays a
 * silence.
 *
 * This line is inferred from what the statuses mean, not measured against a
 * real facilitator. If one answers a definite refusal with a 5xx, it is read
 * as unknown, which is the safe direction to be wrong in.
 */
function refused(status: number): boolean {
  return status >= 400 && status < 500;
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

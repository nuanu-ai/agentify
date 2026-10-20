/**
 * The facilitator, over HTTP, through the official `@x402/core` client. The
 * requirements handed to it are always rebuilt from our own order, never taken
 * from the payment, so a payment against a price the agent invented fails.
 *
 * A settlement failure may describe an unconfirmed broadcast. Only a known
 * pre-broadcast refusal proves nonpayment; other failures stay unknown.
 */

import type { PaymentVerificationFailure } from "@agentify/core";
import { PAYABLE_CURRENCIES } from "@nuanu-ai/agentify-contracts";
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
import { getDefaultAsset } from "@x402/evm";
import {
  atomicUnits,
  authorisedUntil,
  PAYMENT_REF_IN_EXTRA,
  type PaymentEdge,
} from "../../http/x402.js";
import type {
  Charge,
  Facilitator,
  PaymentRecoveryContext,
  PaymentRecoveryOutcome,
  PaymentRecoveryRequest,
  SettleOutcome,
  VerifyOutcome,
} from "../../ports/facilitator.js";
import { authorizationOf, type Eip3009Recovery } from "./recovery.js";

/**
 * How far another clock may differ from ours: an agent's when it sets an
 * authorization's expiry, and the chain's when recovery searches by time.
 */
const CLOCK_SKEW_SECONDS = 30;

export class X402Facilitator implements Facilitator {
  readonly #client: FacilitatorClient;
  readonly #edge: PaymentEdge;
  readonly #now: () => number;
  readonly reconcile?: (request: PaymentRecoveryRequest) => Promise<PaymentRecoveryOutcome>;

  constructor(
    client: FacilitatorClient,
    edge: PaymentEdge,
    recovery?: Eip3009Recovery,
    now = Date.now,
  ) {
    this.#client = client;
    this.#edge = edge;
    if (recovery) this.reconcile = (request) => recovery.reconcile(request);
    this.#now = now;
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

    let authorization: ReturnType<typeof authorizationOf>;
    try {
      authorization = authorizationOf(payload, requirements);
      const now = BigInt(Math.floor(this.#now() / 1000));
      const expires = BigInt(authorization.validBefore);
      const asked = requirements.maxTimeoutSeconds;
      // Signing again fixes both cases, and the offer still stands: answering
      // `price_stale` would send the agent to a new purchase it signs the same way.
      if (expires <= now) {
        return {
          verified: false,
          reason: "signature",
          message: `the signed authorization has already expired; sign one that stays valid for ${asked} seconds, as the offer asks`,
        };
      }
      if (expires > now + BigInt(asked + CLOCK_SKEW_SECONDS)) {
        return {
          verified: false,
          reason: "signature",
          message: `the signed authorization stays valid for ${expires - now} seconds, longer than the ${asked} seconds the offer asks for (${CLOCK_SKEW_SECONDS} more are allowed for clock differences); sign one that expires within ${asked} seconds`,
        };
      }
    } catch (thrown) {
      return {
        verified: false,
        reason: "signature",
        message: describe(thrown),
      };
    }
    // The facilitator's check refuses a used authorization, so the transfer
    // lands after this moment, give or take the clocks.
    const recovery: PaymentRecoveryContext = {
      ...authorization,
      notBefore: String(Math.floor(this.#now() / 1000) - CLOCK_SKEW_SECONDS),
    };

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
      if (answered.payer && !sameAddress(answered.payer, authorization.payer)) {
        return {
          verified: "unknown",
          message: "The facilitator named a payer different from the signed authorization.",
        };
      }
      return {
        verified: true,
        payer: authorization.payer,
        validUntil: authorisedUntil(payload),
        recovery,
      };
    }
    const said = answered.invalidMessage ?? answered.invalidReason ?? "no reason was given";
    return { verified: false, reason: shapeOf(answered.invalidReason), message: said };
  }

  async settle(charge: Charge): Promise<SettleOutcome> {
    const payload = decoded(charge.payment);
    if (payload === null) {
      throw new Error(
        `the charge on the order paid under ${charge.paymentRef} was to be executed and the payment kept for it cannot be read`,
      );
    }
    // Throws with its own sentence, which points the reader at the merchant's
    // settings rather than at the payment.
    const requirements = savedRequirements(charge, payload);
    const mismatch = wrongOffer(payload.accepted, requirements);
    if (mismatch) throw new Error(mismatch);
    try {
      authorizationOf(payload, requirements);
    } catch (thrown) {
      return { settled: false, reason: describe(thrown) };
    }

    let answered: SettleResponse;
    try {
      answered = await this.#client.settle(payload, requirements);
    } catch (thrown) {
      if (thrown instanceof SettleError) {
        return settlementFailure(thrown);
      }
      // A timeout or an internal failure may have completed the settlement
      // before it stopped answering. Nothing is claimed and no second charge is
      // sent.
      return { settled: "unknown", reason: describe(thrown) };
    }

    if (answered.success) {
      return { settled: true, transaction: answered.transaction };
    }
    return settlementFailure(answered);
  }

  async recoveryFor(charge: Charge, since: number): Promise<PaymentRecoveryContext | null> {
    try {
      const payload = decoded(charge.payment);
      if (!payload) return null;
      // Recovery binds signed financial terms to the saved sale; an old unsigned routing hint cannot establish payment.
      return {
        ...authorizationOf(payload, savedRequirements(charge, payload)),
        notBefore: String(Math.floor(since / 1000) - CLOCK_SKEW_SECONDS),
      };
    } catch {
      return null;
    }
  }

  /**
   * What this payment should have been paid against, rebuilt from our own
   * order. It throws, rather than answering null like the decode, because
   * every failure here is on our side and must not read as "this is not a
   * payment".
   */
  #requirements(charge: Charge) {
    return this.#edge.requirementsFor(charge, charge.paymentRef, charge.payTo);
  }
}

function settlementFailure(
  response: Pick<SettleResponse, "transaction" | "errorReason" | "errorMessage">,
): SettleOutcome {
  // These checks return before broadcast; a hash contradicts that evidence.
  const refusedBeforeBroadcast =
    !response.transaction &&
    (response.errorReason === "invalid_exact_evm_payload_authorization_value_mismatch" ||
      response.errorReason === "invalid_exact_evm_recipient_mismatch");
  return {
    settled: refusedBeforeBroadcast ? false : "unknown",
    reason: response.errorMessage ?? response.errorReason ?? "no reason was given",
    ...(!refusedBeforeBroadcast && response.transaction
      ? { transaction: response.transaction }
      : {}),
  };
}

function savedRequirements(charge: Charge, payload: PaymentPayload): PaymentRequirements {
  if (typeof charge.payTo !== "string")
    throw new Error("There is nowhere to send the money recorded for this order.");
  if (!PAYABLE_CURRENCIES.includes(charge.currency.toUpperCase()))
    throw new Error("The saved charge uses an unsupported currency.");
  if (!payload.accepted) throw new Error("The saved payment names no offer.");
  const asset = getDefaultAsset(payload.accepted.network);
  const amount = atomicUnits(charge.amount, asset.decimals);
  if (
    !sameAddress(payload.accepted.asset, asset.asset) ||
    payload.accepted.amount !== amount ||
    !sameAddress(payload.accepted.payTo, charge.payTo)
  ) {
    throw new Error("The saved payment's financial offer contradicts the recorded sale.");
  }
  const requirements = {
    ...payload.accepted,
    asset: asset.asset,
    amount,
    payTo: charge.payTo,
    extra: { name: asset.name, version: asset.version, [PAYMENT_REF_IN_EXTRA]: charge.paymentRef },
  };
  return requirements;
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
        maxTimeoutSeconds?: number;
        extra?: Record<string, unknown>;
      }
    | undefined,
  ours: {
    amount: string;
    asset: string;
    network: string;
    payTo: string;
    maxTimeoutSeconds: number;
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
  if (accepted.maxTimeoutSeconds !== ours.maxTimeoutSeconds) {
    return "the payment names a different timeout from the offer it was made against";
  }
  if (accepted.extra?.[PAYMENT_REF_IN_EXTRA] !== ours.extra[PAYMENT_REF_IN_EXTRA]) {
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
 * Whether a verification status carries the facilitator's own decision. Only
 * a body shaped as a verdict reaches here, so a proxy's error page or an empty
 * 429 stays a silence. Verification submits no payment.
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

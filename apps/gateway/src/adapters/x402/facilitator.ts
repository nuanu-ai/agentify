/**
 * The facilitator, over HTTP, through the official `@x402/core` client. The
 * requirements handed to it are the trusted offer saved with the order, never
 * taken from the payment or rebuilt from current deployment settings.
 *
 * A settlement failure may describe an unconfirmed broadcast. Only a known
 * pre-broadcast refusal proves nonpayment; other failures stay unknown.
 */

import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import {
  type PaymentPayload,
  SettleError,
  type SettleResponse,
  VerifyError,
  type VerifyResponse,
} from "@x402/core/types";
import { failureNamed } from "../../failure-named.js";
import {
  authorisedUntil,
  CLOCK_SKEW_SECONDS,
  inUsdc,
  PRICE_STAMP_IN_EXTRA,
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
import type { TokenBalances } from "../../ports/payment-chain.js";
import { authorizationOf, type Eip3009Recovery } from "./recovery.js";
import { readRefusal } from "./refusal-codes.js";

export class X402Facilitator implements Facilitator {
  readonly #client: FacilitatorClient;
  readonly #balances: TokenBalances | undefined;
  readonly reconcile?: (request: PaymentRecoveryRequest) => Promise<PaymentRecoveryOutcome>;

  constructor(client: FacilitatorClient, recovery?: Eip3009Recovery, balances?: TokenBalances) {
    this.#client = client;
    this.#balances = balances;
    if (recovery) this.reconcile = (request) => recovery.reconcile(request);
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

    const requirements = charge.requirements;

    const mismatch = wrongOffer(payload.accepted, requirements);
    if (mismatch !== null) {
      // Paid against something other than what we asked for: not a payment for
      // this order, whatever the facilitator would say.
      return { verified: false, reason: "price_stale", message: mismatch };
    }

    let authorization: ReturnType<typeof authorizationOf>;
    try {
      authorization = authorizationOf(payload, requirements);
      const now = BigInt(Math.floor(Date.now() / 1000));
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
      notBefore: String(Math.floor(Date.now() / 1000) - CLOCK_SKEW_SECONDS),
    };

    let answered: VerifyResponse;
    try {
      answered = await this.#client.verify(payload, requirements);
    } catch (thrown) {
      // A verdict sent with a refusing status is still a verdict.
      if (thrown instanceof VerifyError && refused(thrown.statusCode)) {
        return await this.#explained(refusal(thrown), authorization);
      }
      const status =
        thrown instanceof VerifyError ? thrown.statusCode : statusOfFailedCheck(thrown);
      return {
        verified: "unknown",
        cause: status !== null && REFUSING_AGENTIFY.has(status) ? "refused_agentify" : "no_answer",
        failure:
          status === null
            ? failureNamed(thrown)
            : `the facilitator answered HTTP ${status}; ${failureNamed(thrown)}`,
      };
    }

    if (answered.isValid) {
      if (answered.payer && !sameAddress(answered.payer, authorization.payer)) {
        return {
          verified: "unknown",
          cause: "payer_contradicted",
          failure: "The facilitator named a payer different from the signed authorization.",
        };
      }
      return {
        verified: true,
        payer: authorization.payer,
        validUntil: authorisedUntil(payload),
        recovery,
      };
    }
    return await this.#explained(refusal(answered), authorization);
  }

  /**
   * A refusal whose code names no cause, held against the payer's balance: a
   * wallet holding less than the price cannot pay it, whatever else the
   * facilitator saw. Only that fact relabels it. A refusal that names its
   * cause, a balance that covers the price and a read that fails all leave
   * the refusal as it was.
   */
  async #explained(
    outcome: VerifyOutcome,
    authorization: ReturnType<typeof authorizationOf>,
  ): Promise<VerifyOutcome> {
    if (
      this.#balances === undefined ||
      outcome.verified !== false ||
      (outcome.reason !== "unexplained" && outcome.reason !== "unrecognised")
    ) {
      return outcome;
    }
    let held: bigint;
    try {
      held = await this.#balances.balance(authorization.asset, authorization.payer);
    } catch {
      return outcome;
    }
    const asked = BigInt(authorization.amount);
    if (held >= asked) return outcome;
    return {
      verified: false,
      reason: "insufficient_funds",
      message: `the paying wallet holds ${inUsdc(held)} USDC on ${authorization.network}, less than the ${inUsdc(asked)} USDC this price asks (the payment layer said ${outcome.message})`,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
    };
  }

  async settle(charge: Charge): Promise<SettleOutcome> {
    const payload = decoded(charge.payment);
    if (payload === null) {
      throw new Error(
        `the charge on the order ${charge.orderId} was to be executed and the payment kept for it cannot be read`,
      );
    }
    const requirements = charge.requirements;
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
  if (accepted.extra?.[PRICE_STAMP_IN_EXTRA] !== ours.extra[PRICE_STAMP_IN_EXTRA]) {
    return "the payment was made against a different stamped price from the one saved for this order";
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
 * A facilitator's refusal, by what its code means. The buyer reads the code of
 * a verdict with the facilitator's words. The operator's log gets the code's
 * leading machine word and never the words, which can quote the payment
 * presented. A code or words that are not text are read as absent.
 */
function refusal(answer: { invalidReason?: unknown; invalidMessage?: unknown }): VerifyOutcome {
  const code = textOf(answer.invalidReason);
  const words = textOf(answer.invalidMessage);
  const reading = readRefusal(code);
  const word = machineWord(code);
  if ("noVerdict" in reading) {
    return {
      verified: "unknown",
      cause: reading.noVerdict,
      failure: `the facilitator answered a refusal that is no verdict on the payment: ${word}`,
    };
  }
  const message =
    code === undefined
      ? (words ?? "no reason was given")
      : words === undefined
        ? code
        : `${code}: ${words}`;
  return {
    verified: false,
    reason: reading.refused,
    message,
    ...(word === undefined ? {} : { code: word }),
  };
}

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * The code's leading run of lower-case letters, digits and underscores, at
 * most 80 characters. A facilitator may append its own text after the code,
 * and that text can quote the payment.
 */
const machineWord = (code: string | undefined): string | undefined =>
  code === undefined ? undefined : /^[a-z0-9_]{1,80}/.exec(code)?.[0];

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

/**
 * The statuses with which a facilitator turns Agentify itself away: its
 * credentials, or the address it was sent to. The same payment meets them
 * until an operator acts, while a timeout, 429 or 5xx may pass on its own.
 */
const REFUSING_AGENTIFY: ReadonlySet<number> = new Set([401, 403, 404]);

/**
 * The status of a check the client failed with no verdict in its body. The
 * client raises those as a plain error carrying the status only in its words,
 * so they are read exactly; a client that words it otherwise yields null,
 * read as no answer. The rest of the words quote the facilitator's body and
 * are never kept.
 */
function statusOfFailedCheck(thrown: unknown): number | null {
  const status =
    thrown instanceof Error ? /^Facilitator verify failed \((\d{3})\):/.exec(thrown.message) : null;
  return status?.[1] === undefined ? null : Number(status[1]);
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

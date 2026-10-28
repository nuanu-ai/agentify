/**
 * A payment presented for an order already paid for, checked here instead of
 * by the payment layer. Such a payment is never charged; it only shows that
 * whoever sent it holds a wallet, so what is checked is its signature, its
 * terms and that it is fresh. The payment layer would also check that the
 * wallet could pay again, which has no bearing on giving back what it already
 * paid for.
 *
 * The price stamp travels in the payment's unsigned copy of the offer,
 * so one wallet's authorization fits every order of the same price and payee.
 * What binds an authorization to one order is its claim here, and, where the
 * chain answers, its use there.
 */

import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { authorizationTypes } from "@x402/evm";
import { type Hex, hashTypedData, isAddressEqual, recoverAddress } from "viem";
import { authorizationIn } from "../http/payment-authorization.js";
import {
  authorizationFingerprint,
  CLOCK_SKEW_SECONDS,
  PRICE_STAMP_IN_EXTRA,
} from "../http/x402.js";
import type { VerifyOutcome } from "../ports/facilitator.js";
import type { PaymentChain } from "../ports/payment-chain.js";
import type { ClaimHolder, StoredOrder } from "../ports/store.js";

/** What a payment for a paid order is checked with. */
export interface ReturnCheck {
  readonly now: number;
  /** Who holds the claim on a payment's fingerprint, if anyone. */
  readonly claimHolder: (fingerprint: string) => Promise<ClaimHolder | null>;
  readonly chain?: PaymentChain;
}

/**
 * The payment checked against `paid`'s own terms: a verified outcome naming
 * the wallet that signed it, whichever wallet that is, or a refusal. Null
 * where this gateway cannot tell without the payment layer: a signature only
 * the chain can judge, with no chain to ask or a chain that did not answer.
 */
export async function returningPayment(
  payment: string,
  paid: { readonly priceOffer: NonNullable<StoredOrder["priceOffer"]>; readonly orderId: string },
  { now, claimHolder, chain }: ReturnCheck,
): Promise<VerifyOutcome | null> {
  const ours = paid.priceOffer.requirements;

  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(payment);
  } catch {
    return refused("signature", "the payment presented could not be read as a payment at all");
  }
  const signed = authorizationIn(payload);
  if (signed === null) {
    return refused(
      "signature",
      "this gateway accepts x402 version 2 exact payments signed as an EIP-3009 transfer authorization, and this payment is not one",
    );
  }
  const { authorization, signature } = signed;

  if (payload.accepted.network !== ours.network || !same(payload.accepted.asset, ours.asset)) {
    return refused(
      "price_stale",
      "the payment was made in a different asset or on a different chain from the one asked for",
    );
  }
  if (payload.accepted.extra?.[PRICE_STAMP_IN_EXTRA] !== paid.priceOffer.stamp) {
    return refused(
      "price_stale",
      "the payment was made against a different stamped price from the one saved for this order",
    );
  }
  if (payload.accepted.amount !== ours.amount || authorization.value !== ours.amount) {
    return refused(
      "price_stale",
      `this order is priced at ${ours.amount} and the payment was made for ${authorization.value}`,
    );
  }
  if (!same(payload.accepted.payTo, ours.payTo) || !same(authorization.to, ours.payTo)) {
    return refused(
      "price_stale",
      "the payment was made out to a different address from the one asked for",
    );
  }

  if (payload.accepted.maxTimeoutSeconds !== ours.maxTimeoutSeconds) {
    return refused("price_stale", "the payment names a different timeout from the saved offer");
  }

  const seconds = BigInt(Math.floor(now / 1_000));
  if (BigInt(authorization.validBefore) <= seconds) {
    return refused(
      "signature",
      `the signed authorization has already expired; sign one that stays valid for ${ours.maxTimeoutSeconds} seconds, as the offer asks`,
    );
  }
  const lasts = BigInt(authorization.validBefore) - seconds;
  const asked = ours.maxTimeoutSeconds;
  if (lasts > BigInt(asked + CLOCK_SKEW_SECONDS)) {
    return refused(
      "signature",
      `the signed authorization stays valid for ${lasts} seconds, longer than the ${asked} seconds the offer asks for (${CLOCK_SKEW_SECONDS} more are allowed for clock differences); sign one that expires within ${asked} seconds`,
    );
  }
  if (BigInt(authorization.validAfter) > seconds) {
    return refused("signature", "the signed authorization is not valid yet");
  }

  const digest = hashTypedData({
    domain: {
      name: String(ours.extra.name),
      version: String(ours.extra.version),
      chainId: Number(ours.network.split(":")[1]),
      verifyingContract: ours.asset as Hex,
    },
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  const accepted = await signedBy(authorization.from, digest, signature, chain);
  if (accepted === null) return null;
  if (!accepted) {
    return refused("signature", "the signature is not the signing wallet's");
  }

  // Only for a signature that is the wallet's, so a payment anyone could make
  // up learns nothing of which authorizations have been taken.
  const fingerprint = authorizationFingerprint({
    network: ours.network,
    asset: ours.asset,
    payer: authorization.from,
    nonce: authorization.nonce,
  });
  // A claim this order holds and has kept is the one that paid it; one it
  // holds and has not kept is an earlier return, which may come again.
  const holder = await claimHolder(fingerprint);
  if (holder !== null && (holder.orderId !== paid.orderId || holder.retained)) {
    return ALREADY_USED;
  }
  // A second guard where the chain answers. The claims, with the cap on how
  // long a payment stays valid, are what bind an authorization to one order,
  // so a chain that does not answer leaves the decision to them.
  if (chain !== undefined) {
    const used = await chain
      .used(ours.asset, authorization.from, authorization.nonce)
      .catch(() => false);
    if (used) return ALREADY_USED;
  }
  return {
    verified: true,
    payer: authorization.from,
    validUntil: Number(authorization.validBefore) * 1_000,
  };
}

/**
 * Whether `wallet` signed `digest`: by its own key, read here, or by the
 * chain's word for a wallet that is a contract. A signature shaped as a key's
 * that recovers to another address is refused here when there is no chain to
 * ask; any other shape is left to the payment layer then.
 */
async function signedBy(
  wallet: Hex,
  digest: Hex,
  signature: Hex,
  chain: PaymentChain | undefined,
): Promise<boolean | null> {
  const byKey = signature.length === 2 + 65 * 2;
  if (byKey) {
    try {
      if (isAddressEqual(await recoverAddress({ hash: digest, signature }), wallet)) return true;
    } catch {
      // Not a point on the curve: no key signed it, though a contract may
      // still accept these bytes.
    }
  }
  if (chain === undefined) return byKey ? false : null;
  try {
    return await chain.accepts(wallet, digest, signature);
  } catch {
    return null;
  }
}

/**
 * An authorization some order has taken. Its words are the same whichever
 * order took it, so they say nothing of that order or of this one.
 */
const ALREADY_USED: VerifyOutcome = {
  verified: false,
  reason: "signature",
  message: "the signed authorization has already been used, and each payment needs one of its own",
};

const refused = (
  reason: "signature" | "price_stale",
  message: string,
): VerifyOutcome & { readonly verified: false } => ({ verified: false, reason, message });

const same = (a: string | undefined, b: string): boolean =>
  a !== undefined && a.toLowerCase() === b.toLowerCase();

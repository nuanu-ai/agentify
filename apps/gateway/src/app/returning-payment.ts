/**
 * A payment presented for an order already paid for, checked here instead of
 * by the payment layer. Such a payment is never charged; it only shows that
 * whoever sent it holds a wallet, so what is checked is its signature, its
 * terms and that it is fresh. The payment layer would also check that the
 * wallet could pay again, which has no bearing on giving back what it already
 * paid for.
 */

import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { authorizationTypes } from "@x402/evm";
import { type Hex, hashTypedData, isAddressEqual, recoverAddress } from "viem";
import { authorizationFingerprint, PAYMENT_REF_IN_EXTRA, type PaymentEdge } from "../http/x402.js";
import type { VerifyOutcome } from "../ports/facilitator.js";
import type { SignatureReader } from "../ports/signatures.js";
import type { StoredOrder } from "../ports/store.js";

/**
 * The payment checked against `paid`'s own terms: a verified outcome naming
 * the wallet that signed it, whichever wallet that is, or a refusal. Null
 * where this gateway cannot tell without the payment layer: a signature only
 * the chain can judge, with no chain to ask or a chain that did not answer.
 */
export async function returningPayment(
  payment: string,
  paid: Pick<
    StoredOrder,
    "paymentRef" | "payTo" | "payment" | "paymentRecovery" | "paymentFingerprint"
  > & {
    readonly price: { readonly amount: string; readonly currency: string };
  },
  edge: PaymentEdge,
  now: number,
  signatures?: SignatureReader,
): Promise<VerifyOutcome | null> {
  let ours: PaymentRequirements;
  try {
    ours = edge.requirementsFor(paid.price, paid.paymentRef, paid.payTo);
  } catch {
    // Our own side of the question could not be built; the payment layer's
    // path answers that as not knowing.
    return null;
  }

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
  if (payload.accepted.extra?.[PAYMENT_REF_IN_EXTRA] !== paid.paymentRef) {
    return refused(
      "price_stale",
      "the payment was made against a different order from the one it was presented for",
    );
  }
  if (authorization.value !== ours.amount) {
    return refused(
      "price_stale",
      `this order is priced at ${ours.amount} and the payment was made for ${authorization.value}`,
    );
  }
  if (!same(authorization.to, ours.payTo)) {
    return refused(
      "price_stale",
      "the payment was made out to a different address from the one asked for",
    );
  }

  const seconds = BigInt(Math.floor(now / 1_000));
  if (BigInt(authorization.validBefore) <= seconds) {
    return refused(
      "signature",
      `the signed authorization has already expired; sign one that stays valid for ${ours.maxTimeoutSeconds} seconds, as the offer asks`,
    );
  }
  if (BigInt(authorization.validAfter) > seconds) {
    return refused("signature", "the signed authorization is not valid yet");
  }
  if (paidWith(paid, ours, authorization)) {
    return refused(
      "signature",
      "this authorization has been presented before, and each payment needs a new one",
    );
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
  const accepted = await signedBy(authorization.from, digest, signature, signatures);
  if (accepted === null) return null;
  if (!accepted) {
    return refused("signature", "the signature is not the signing wallet's");
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
  signatures: SignatureReader | undefined,
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
  if (signatures === undefined) return byKey ? false : null;
  try {
    return await signatures.accepts(wallet, digest, signature);
  } catch {
    return null;
  }
}

interface Authorization {
  readonly from: Hex;
  readonly to: Hex;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: Hex;
}

/**
 * The EIP-3009 authorization and its signature in an x402 version 2 exact
 * payment, each written as that scheme writes it, or null for any other
 * payment. A signature is bytes, so an empty one is no signature.
 */
function authorizationIn(payload: PaymentPayload): {
  readonly authorization: Authorization;
  readonly signature: Hex;
} | null {
  const signed = record(payload.payload);
  const authorization = record(signed?.authorization);
  const method = payload.accepted?.extra?.assetTransferMethod;
  if (
    payload.x402Version !== 2 ||
    payload.accepted?.scheme !== "exact" ||
    (method !== undefined && method !== "eip3009") ||
    signed?.permit2Authorization !== undefined ||
    typeof signed?.signature !== "string" ||
    !/^0x(?:[\da-f]{2})+$/i.test(signed.signature) ||
    authorization === null ||
    !address(authorization.from) ||
    !address(authorization.to) ||
    !uint256(authorization.value) ||
    !uint256(authorization.validAfter) ||
    !uint256(authorization.validBefore) ||
    typeof authorization.nonce !== "string" ||
    !/^0x[\da-f]{64}$/i.test(authorization.nonce)
  ) {
    return null;
  }
  return {
    authorization: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce as Hex,
    },
    signature: signed.signature as Hex,
  };
}

/**
 * Whether `authorization` is the one that paid the order, wherever the order
 * keeps that one: the terms saved for recovery, the payment itself while it is
 * kept, and the fingerprint it was claimed under. The token keys a used
 * authorization by its signer and nonce, and so does this.
 */
function paidWith(
  paid: Pick<StoredOrder, "payment" | "paymentRecovery" | "paymentFingerprint">,
  ours: PaymentRequirements,
  authorization: Authorization,
): boolean {
  const presented = nonceOf(authorization.from, authorization.nonce);
  if (
    paid.paymentFingerprint ===
    authorizationFingerprint({
      network: ours.network,
      asset: ours.asset,
      payer: authorization.from,
      nonce: authorization.nonce,
    })
  ) {
    return true;
  }
  if (
    paid.paymentRecovery !== undefined &&
    nonceOf(paid.paymentRecovery.payer, paid.paymentRecovery.nonce) === presented
  ) {
    return true;
  }
  if (paid.payment === null) return false;
  try {
    const kept = authorizationIn(decodePaymentSignatureHeader(paid.payment));
    return (
      kept !== null && nonceOf(kept.authorization.from, kept.authorization.nonce) === presented
    );
  } catch {
    // A kept payment that cannot be read names no authorization.
    return false;
  }
}

const nonceOf = (payer: string, nonce: string): string =>
  `${payer.toLowerCase()}:${nonce.toLowerCase()}`;

const refused = (
  reason: "signature" | "price_stale",
  message: string,
): VerifyOutcome & { readonly verified: false } => ({ verified: false, reason, message });

const same = (a: string | undefined, b: string): boolean =>
  a !== undefined && a.toLowerCase() === b.toLowerCase();

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const address = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[\da-f]{40}$/i.test(value);

const uint256 = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value) && BigInt(value) < 1n << 256n;

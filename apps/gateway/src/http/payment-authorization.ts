/** The supported payment shape, checked locally before any facilitator call. */
import type { Hex } from "viem";

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
 * payment. Empty bytes are permitted: a contract wallet decides which bytes
 * it accepts, and the verifier checks that wallet.
 */
export function authorizationIn(payload: unknown): {
  readonly authorization: Authorization;
  readonly signature: Hex;
} | null {
  const envelope = record(payload);
  const accepted = record(envelope?.accepted);
  const signed = record(envelope?.payload);
  const authorization = record(signed?.authorization);
  const method = record(accepted?.extra)?.assetTransferMethod;
  if (
    envelope?.x402Version !== 2 ||
    accepted?.scheme !== "exact" ||
    (method !== undefined && method !== "eip3009") ||
    signed?.permit2Authorization !== undefined ||
    typeof signed?.signature !== "string" ||
    !/^0x(?:[\da-f]{2})*$/i.test(signed.signature) ||
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

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const address = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[\da-f]{40}$/i.test(value);

const uint256 = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value) && BigInt(value) < 1n << 256n;

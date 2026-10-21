/**
 * Payments signed the way an x402 client signs them: an EIP-3009
 * `transferWithAuthorization` over the token's own EIP-712 domain, by a wallet
 * whose key only the test holds. Where a test needs to know who signed a
 * payment, and not only who the payment says signed it, it signs here.
 */

import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { authorizationTypes } from "@x402/evm";
import { type Hex, keccak256, type LocalAccount, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** A wallet made from its name, so no key is ever written out. */
export const aWallet = (name: string): LocalAccount => privateKeyToAccount(keccak256(toHex(name)));

/** What a client could get wrong, or sign differently, against the requirements it was given. */
export interface SignedTerms {
  /** The authorization's nonce, written as a short hex number and padded to 32 bytes. */
  readonly nonce: string;
  /** When the authorization stops being valid, in milliseconds. */
  readonly validBefore: number;
  /** When it starts being valid, in milliseconds; the epoch when left out. */
  readonly validAfter?: number;
  /** A different amount or payee from the one asked for, signed and offered both. */
  readonly value?: string;
  readonly payTo?: string;
  /** Another chain, written into the offer and the signed domain both. */
  readonly network?: `${string}:${string}`;
  /** Replaces the signature after signing. */
  readonly signature?: Hex;
}

export async function signedPayment(
  wallet: LocalAccount,
  requirements: PaymentRequirements,
  terms: SignedTerms,
): Promise<string> {
  const network = terms.network ?? requirements.network;
  const accepted: PaymentRequirements = {
    ...requirements,
    network,
    amount: terms.value ?? requirements.amount,
    payTo: terms.payTo ?? requirements.payTo,
  };
  const authorization = {
    from: wallet.address,
    to: accepted.payTo as Hex,
    value: accepted.amount,
    validAfter: String(Math.floor((terms.validAfter ?? 0) / 1_000)),
    validBefore: String(Math.floor(terms.validBefore / 1_000)),
    nonce: `0x${terms.nonce.replace(/^0x/, "").padStart(64, "0")}` as Hex,
  };
  const signature =
    terms.signature ??
    (await wallet.signTypedData({
      domain: {
        name: String(accepted.extra?.name),
        version: String(accepted.extra?.version),
        chainId: Number(network.split(":")[1]),
        verifyingContract: accepted.asset as Hex,
      },
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        ...authorization,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
      },
    }));
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted,
    payload: { signature, authorization },
  });
}

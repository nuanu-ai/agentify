/**
 * What a payment shows about its payer before the payment layer is asked:
 * whether its signature is the key of the wallet it names, and whether that
 * wallet holds the price. These decide only where a payment waits for its
 * check; the payment layer stays the judge of whether it is valid.
 */

import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { authorizationTypes } from "@x402/evm";
import { type Hex, hashTypedData, isAddressEqual, recoverAddress } from "viem";
import { authorizationIn } from "../http/payment-authorization.js";
import type { Clock } from "../ports/clock.js";
import type { TokenBalances } from "../ports/payment-chain.js";

/**
 * The wallet whose own key signed this EIP-3009 payment, or null. A contract
 * wallet, an ERC-6492 wrapper and bytes that are no signature at all name a
 * wallet they cannot be shown to come from here.
 */
export async function keyHolderOf(
  payment: string,
  requirements: PaymentRequirements,
): Promise<Hex | null> {
  let signed: ReturnType<typeof authorizationIn>;
  try {
    signed = authorizationIn(decodePaymentSignatureHeader(payment));
  } catch {
    return null;
  }
  if (signed === null || signed.signature.length !== 2 + 65 * 2) return null;
  const { authorization, signature } = signed;
  try {
    const digest = hashTypedData({
      domain: {
        name: String(requirements.extra?.name),
        version: String(requirements.extra?.version),
        chainId: Number(requirements.network.split(":")[1]),
        verifyingContract: requirements.asset as Hex,
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
    const signer = await recoverAddress({ hash: digest, signature });
    return isAddressEqual(signer, authorization.from) ? authorization.from : null;
  } catch {
    // Not a point on the curve: no key signed it.
    return null;
  }
}

/** How long a wallet's balance, once read, stands for it. */
const BALANCE_KEPT_MS = 5_000;

/** How many wallets' balances are kept at once; the oldest goes first. */
const BALANCES_KEPT_AT_MOST = 1_024;

/**
 * Wallets' balances as lately read, so one buyer's retries ask the chain
 * once. A read that fails is not kept, and answers null.
 */
export class RecentBalances {
  readonly #read: () => TokenBalances | undefined;
  readonly #clock: Clock;
  readonly #kept = new Map<string, { readonly held: bigint; readonly at: number }>();

  constructor(read: () => TokenBalances | undefined, clock: Clock) {
    this.#read = read;
    this.#clock = clock;
  }

  async of(token: string, wallet: string): Promise<bigint | null> {
    const key = `${token.toLowerCase()}:${wallet.toLowerCase()}`;
    const now = this.#clock();
    const kept = this.#kept.get(key);
    if (kept !== undefined && now - kept.at < BALANCE_KEPT_MS) return kept.held;
    const reader = this.#read();
    if (reader === undefined) return null;
    let held: bigint;
    try {
      held = await reader.balance(token, wallet);
    } catch {
      return null;
    }
    this.#kept.delete(key);
    this.#kept.set(key, { held, at: now });
    if (this.#kept.size > BALANCES_KEPT_AT_MOST) {
      const oldest = this.#kept.keys().next().value;
      if (oldest !== undefined) this.#kept.delete(oldest);
    }
    return held;
  }
}

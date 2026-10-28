/**
 * What a payment shows about its payer before the payment layer is asked:
 * whether its signature is the key of the wallet it names, and what that
 * wallet holds. These decide only where a payment waits for its check, or
 * refuse what the token would refuse anyway; the payment layer stays the
 * judge of whether a payment is valid.
 */

import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { authorizationTypes } from "@x402/evm";
import { type Hex, hashTypedData, isAddressEqual, recoverAddress } from "viem";
import { authorizationIn } from "../http/payment-authorization.js";
import type { Clock } from "../ports/clock.js";
import type { TokenBalances } from "../ports/payment-chain.js";
import { MerchantGate } from "./merchant-gate.js";
import { gateRefused, payerReadTimed } from "./purchase-metrics.js";

/** What a payment proves of who pays it. */
export type PayerProof =
  /** Its signature recovers to the wallet it names. */
  | {
      readonly signedByKey: true;
      readonly wallet: Hex;
      readonly nonce: Hex;
      readonly validAfter: bigint;
      /** Whether `s` is in the lower half, as the token requires of a key's signature. */
      readonly lowS: boolean;
    }
  /**
   * Nothing shows that: a contract wallet, an ERC-6492 wrapper or noise.
   * `claimed` is the wallet it names, lower-cased, or one stand-in for every
   * payment that names none.
   */
  | {
      readonly signedByKey: false;
      readonly claimed: string;
      readonly validAfter: bigint | null;
    };

/** Half the order of secp256k1: a key's signature with `s` above it is refused by the token. */
const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** How many signatures' recovered signers are kept; the oldest goes first. */
const SIGNERS_KEPT_AT_MOST = 1_024;

/** Signers already recovered, by typed-data digest and signature, since recovery is the costly step. */
const signers = new Map<string, Hex | null>();

export async function payerOf(
  payment: string,
  requirements: PaymentRequirements,
): Promise<PayerProof> {
  let signed: ReturnType<typeof authorizationIn>;
  try {
    signed = authorizationIn(decodePaymentSignatureHeader(payment));
  } catch {
    signed = null;
  }
  if (signed === null) return { signedByKey: false, claimed: "unidentified", validAfter: null };
  const { authorization, signature } = signed;
  const validAfter = BigInt(authorization.validAfter);
  const claimed = {
    signedByKey: false,
    claimed: authorization.from.toLowerCase(),
    validAfter,
  } as const;
  if (signature.length !== 2 + 65 * 2) return claimed;
  let digest: Hex;
  try {
    digest = hashTypedData({
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
        validAfter,
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });
  } catch {
    return claimed;
  }
  const signer = await signerOf(digest, signature);
  if (signer === null || !isAddressEqual(signer, authorization.from)) return claimed;
  return {
    signedByKey: true,
    wallet: authorization.from,
    nonce: authorization.nonce,
    validAfter,
    lowS: BigInt(`0x${signature.slice(66, 130)}`) <= HALF_ORDER,
  };
}

async function signerOf(digest: Hex, signature: Hex): Promise<Hex | null> {
  const key = `${digest}:${signature.toLowerCase()}`;
  const known = signers.get(key);
  if (known !== undefined) return known;
  let signer: Hex | null;
  try {
    signer = await recoverAddress({ hash: digest, signature });
  } catch {
    // Not a point on the curve: no key signed it.
    signer = null;
  }
  signers.set(key, signer);
  if (signers.size > SIGNERS_KEPT_AT_MOST) {
    const oldest = signers.keys().next().value;
    if (oldest !== undefined) signers.delete(oldest);
  }
  return signer;
}

/** What the chain says of a payer's wallet as its payment is about to wait. */
export interface PayerState {
  readonly held: bigint;
  /** Whether the token has marked this authorization's nonce used or cancelled. */
  readonly used: boolean;
}

/** How long a balance that covers the price stands for its wallet. */
const BALANCE_KEPT_MS = 5_000;

/** How many wallets' balances are kept at once; the oldest goes first. */
const BALANCES_KEPT_AT_MOST = 1_024;

/**
 * Reads of one merchant's payers at once, and how many may wait for one.
 * The endpoint is shared with payment recovery, so a flood at one merchant
 * must not keep it busy.
 */
const READS_AT_ONCE = 2;
const READS_WAITING_AT_MOST = 8;
const READ_PLACE_WAIT_MS = 1_000;

/**
 * Payers' wallets as read from the chain, one batched request each. Reads
 * asked about the same authorization at once are one read. A balance read
 * stands for a few seconds only for a price it covers, so a buyer's retries
 * ask once, and one below the price asked is read again, so a buyer who tops
 * up can pay at once.
 * A read that failed, could not get a place, or has no chain to ask answers
 * null.
 */
export class PayerReads {
  readonly #read: () => TokenBalances | undefined;
  readonly #clock: Clock;
  readonly #places = new MerchantGate({
    atOnce: READS_AT_ONCE,
    waitingAtMost: READS_WAITING_AT_MOST,
  });
  readonly #inFlight = new Map<string, Promise<PayerState | null>>();
  readonly #kept = new Map<string, { readonly held: bigint; readonly at: number }>();

  constructor(read: () => TokenBalances | undefined, clock: Clock) {
    this.#read = read;
    this.#clock = clock;
  }

  async stateOf(
    merchantId: string,
    token: string,
    wallet: string,
    nonce: string,
    asked: bigint,
  ): Promise<PayerState | null> {
    const holder = `${token.toLowerCase()}:${wallet.toLowerCase()}`;
    const kept = this.#kept.get(holder);
    if (kept !== undefined && this.#clock() - kept.at < BALANCE_KEPT_MS && kept.held >= asked) {
      return { held: kept.held, used: false };
    }
    const asking = `${holder}:${nonce.toLowerCase()}`;
    const running = this.#inFlight.get(asking);
    if (running !== undefined) return running;
    const reading = this.#readOnce(merchantId, token, wallet, nonce, holder).finally(() =>
      this.#inFlight.delete(asking),
    );
    this.#inFlight.set(asking, reading);
    return reading;
  }

  async #readOnce(
    merchantId: string,
    token: string,
    wallet: string,
    nonce: string,
    holder: string,
  ): Promise<PayerState | null> {
    const reader = this.#read();
    if (reader === undefined) return null;
    const place = await this.#places.enter(merchantId, READ_PLACE_WAIT_MS);
    if (place === null) {
      gateRefused("payer_read");
      return null;
    }
    let state: PayerState;
    try {
      state = await payerReadTimed(this.#clock, () => reader.payerState(token, wallet, nonce));
    } catch {
      return null;
    } finally {
      place();
    }
    this.#kept.delete(holder);
    this.#kept.set(holder, { held: state.held, at: this.#clock() });
    if (this.#kept.size > BALANCES_KEPT_AT_MOST) {
      const oldest = this.#kept.keys().next().value;
      if (oldest !== undefined) this.#kept.delete(oldest);
    }
    return state;
  }
}

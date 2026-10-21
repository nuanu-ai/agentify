/**
 * The payment protocol at the edge. Encoding and decoding are the official x402
 * packages'; this file adds which order a payment is for. The all-in-one x402
 * middleware is not used because it verifies and settles around one request,
 * and the order machine needs the two apart.
 *
 * The order's payment reference travels in the requirements' `extra` and comes
 * back inside the payment. It is a hint, never an authority: a payment is
 * checked against the price on our own order. The order's identifier is never
 * in the requirements, because they go to the payment facilitator and a
 * discovery listing can publish them, and the identifier opens the order's
 * goods.
 */

import { createHash } from "node:crypto";
import type { BazaarDeclaration, Card } from "@nuanu-ai/agentify-contracts";
import {
  bazaarDeclarationOf,
  PAYABLE_CURRENCIES,
  PAYABLE_DECIMALS,
  ServiceNameSchema,
} from "@nuanu-ai/agentify-contracts";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import { getDefaultAsset } from "@x402/evm";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { purchaseUrlOf } from "../app/addresses.js";
import { authorisationSecondsOf } from "../app/payment-window.js";
import type { GatewayConfig } from "../config.js";
import { randomIds } from "../ports/clock.js";

/** The x402 version this edge speaks. */
export const X402_VERSION = 2;

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "payment-signature";
/** The payment header's name in version 1 of the protocol. */
const PAYMENT_SIGNATURE_HEADER_V1 = "x-payment";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/**
 * How far another clock may differ from ours: an agent's when it sets an
 * authorization's expiry, and the chain's when recovery searches by time.
 */
export const CLOCK_SKEW_SECONDS = 30;

/** Where in the requirements' `extra` the order's payment reference is written. */
export const PAYMENT_REF_IN_EXTRA = "payment_ref";

/**
 * A price in the token's smallest unit, written out exactly; money never
 * becomes a float here. A price with more fractional digits than the token
 * carries is refused, never rounded: a rounded charge is a different charge.
 */
export function atomicUnits(amount: string, decimals: number): string {
  const [whole = "0", fraction = ""] = amount.split(".");

  if (fraction.length > decimals) {
    throw new Error(
      `${amount} is written to ${fraction.length} places and this token carries ${decimals}, so there is no exact amount to charge`,
    );
  }

  const written = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return written;
}

const PARCEL_LISTED =
  "this is a parcel: the price shown is for the goods alone, and a purchase that names an address is priced for it with shipping included";

const PARCEL_PRICED = "this is a parcel: the amount asked includes shipping to the address named";

/**
 * Every reason a challenge gives for not returning the resource. A challenge
 * carries no other, so the widest a card's challenge can be is measured with
 * each of them.
 */
export const CHALLENGE_REASONS = {
  probe: "payment required",
  paymentOnAGet: "this GET is not read for payment: the purchase is a POST with a JSON body",
  unreadablePayment: "the payment could not be read, so here is a fresh price",
  noHeldOrder:
    "the payment did not name an order this gateway is holding, so here is a fresh price",
} as const;

export type ChallengeReason = (typeof CHALLENGE_REASONS)[keyof typeof CHALLENGE_REASONS];

/** The longest listing name there is, in a character JSON writes as two. */
const widestListingName = (): string => {
  const longest = ServiceNameSchema.maxLength;
  if (longest === null) {
    throw new Error("a listing name with no longest length leaves a challenge with no widest size");
  }
  return "\\".repeat(longest);
};

/**
 * Each part of a challenge that is not the card, at its widest: an amount with
 * every whole digit an amount may carry and every place USDC has, identifiers
 * as the stores issue them, an address, and the longest listing name. Measured
 * with these, a card's challenge is never wider later, whatever its merchant
 * is renamed, its orders are priced at or its money is paid to.
 */
const WIDEST = {
  price: { amount: `${"9".repeat(18)}.${"9".repeat(PAYABLE_DECIMALS)}`, currency: "USD" },
  itemId: randomIds("item"),
  paymentRef: randomIds("pay"),
  payTo: `0x${"f".repeat(40)}`,
  serviceName: widestListingName(),
} as const;

/** What the payment edge reads of a gateway's configuration. */
type EdgeConfig = Pick<GatewayConfig, "payment" | "publicBaseUrl"> & {
  readonly deadlines: Pick<GatewayConfig["deadlines"], "quoteTtlMs" | "syncResponseMs">;
};

export class PaymentEdge {
  readonly #config: EdgeConfig;

  constructor(config: EdgeConfig) {
    this.#config = config;
  }

  /**
   * What an agent is asked to pay, to whom, and for which order, named by its
   * payment reference; `null` names none, for a price with no order behind
   * it. The address is the one given, unchanged: the card's merchant's
   * recorded split for a challenge, and the order's own address at
   * verification and at the charge, never anything from our configuration.
   *
   * No address is refused, in every mode, never defaulted: the configured
   * address is the operator's, and standing it in would send a merchant's
   * takings to somebody else irreversibly. The sandbox's placeholder is a
   * split computed for the merchant before this is asked.
   */
  requirementsFor(
    price: { readonly amount: string; readonly currency: string },
    paymentRef: string | null,
    payTo: string | null,
  ): PaymentRequirements {
    if (!PAYABLE_CURRENCIES.includes(price.currency.toUpperCase())) {
      throw new Error(
        `${price.currency} is not a currency this gateway can charge in, and it will not invent a rate to one that is`,
      );
    }
    // An order kept before its document carried an address has none at all,
    // which is the same as null here.
    if (typeof payTo !== "string") {
      throw new Error(
        "there is nowhere to send the money: the merchant who published this product has set no wallet, or their wallet has no recorded payout split, and this gateway will not stand its own address in for theirs",
      );
    }

    const asset = getDefaultAsset(this.#network());
    return {
      scheme: "exact",
      network: this.#network(),
      asset: asset.asset,
      amount: atomicUnits(price.amount, asset.decimals),
      payTo,
      // How long the signed authorisation stays valid, which is longer than the
      // price holds: a purchase delivered in the answer is charged after its
      // goods.
      maxTimeoutSeconds: authorisationSecondsOf(this.#config.deadlines),
      extra: {
        name: asset.name,
        version: asset.version,
        // A challenge for a card alone, with no order behind it, names none.
        ...(paymentRef === null ? {} : { [PAYMENT_REF_IN_EXTRA]: paymentRef }),
      },
    };
  }

  /**
   * The whole challenge, as the header carries it, including the discovery
   * declaration that lets an agent find and buy the product.
   *
   * The declaration always describes the purchase, a POST with a JSON body,
   * whichever method the request came in on: an agent reads it off the GET
   * probe, and a declaration naming GET leads it to pay with GET, which reads
   * no payment.
   */
  challengeFor(
    price: { readonly amount: string; readonly currency: string },
    paymentRef: string | null,
    listed: {
      readonly itemId: string;
      readonly card: Card;
      readonly serviceName: string | null;
      /** Where the card's merchant is paid: their recorded split. */
      readonly payTo: string | null;
    },
    why?: ChallengeReason,
  ): string {
    const declared = bazaarDeclarationOf(listed.card, {
      // The configured base, never the request's: behind the proxy the request
      // says `http://` with the caller's query string, and a catalog keys a
      // listing on this address, so two spellings would be two listings.
      url: purchaseUrlOf(this.#config, listed.itemId),
      serviceName: listed.serviceName,
    });

    // A parcel's listed price is for the goods alone, and its purchase is
    // priced with shipping to the address named; the agent is told which
    // number it is reading.
    const said =
      listed.card.fulfillment === "ship"
        ? [why, paymentRef === null ? PARCEL_LISTED : PARCEL_PRICED]
            .filter((part) => part !== undefined)
            .join("; ")
        : why;

    const challenge: PaymentRequired = {
      x402Version: X402_VERSION,
      ...(said === undefined ? {} : { error: said }),
      resource: {
        url: declared.resource.url,
        description: declared.resource.description,
        mimeType: declared.resource.mimeType,
        ...(declared.resource.serviceName === undefined
          ? {}
          : { serviceName: declared.resource.serviceName }),
        // A copy, not a cast: the contract's tags are read-only.
        ...(declared.resource.tags === undefined ? {} : { tags: [...declared.resource.tags] }),
      },
      accepts: [this.requirementsFor(price, paymentRef, listed.payTo)],
      extensions: discoveryExtensionOf(declared),
    };
    return encodePaymentRequiredHeader(challenge);
  }

  /**
   * The size in bytes of the widest challenge header `card` can be answered
   * with: for every reason a challenge gives, with an order and without one,
   * and every other part at its widest.
   */
  widestChallengeFor(card: Card): number {
    let widest = 0;
    for (const paymentRef of [null, WIDEST.paymentRef]) {
      for (const why of Object.values(CHALLENGE_REASONS)) {
        const header = this.challengeFor(
          WIDEST.price,
          paymentRef,
          { itemId: WIDEST.itemId, card, serviceName: WIDEST.serviceName, payTo: WIDEST.payTo },
          why,
        );
        widest = Math.max(widest, Buffer.byteLength(header));
      }
    }
    return widest;
  }

  receiptHeader(settlement: SettleResponse): string {
    return encodePaymentResponseHeader(settlement);
  }

  #network(): `${string}:${string}` {
    return this.#config.payment.network as `${string}:${string}`;
  }

  token(): TokenIdentity {
    return { network: this.#config.payment.network, asset: getDefaultAsset(this.#network()).asset };
  }
}

/** `widestChallengeFor` on the challenges a gateway with this configuration answers with. */
export function widestChallengeOn(config: GatewayConfig): (card: Card) => number {
  const edge = new PaymentEdge(config);
  return (card) => edge.widestChallengeFor(card);
}

/**
 * One card's declaration in the shape the protocol carries it. The library's
 * `enrichDeclaration` hook writes the method in, without which the catalog's
 * check fails; it is given the purchase's method whatever the request's. No
 * route pattern is passed, so the product identifier is not declared twice;
 * the empty `getPath` is never read but the hook requires an `adapter` key.
 */
function discoveryExtensionOf(declared: BazaarDeclaration): Record<string, unknown> {
  const built = declareDiscoveryExtension({
    bodyType: "json",
    input: declared.input,
    inputSchema: declared.inputSchema,
    output: declared.output,
  });

  const enriched = bazaarResourceServerExtension.enrichDeclaration?.(built.bazaar, {
    method: "POST",
    adapter: { getPath: () => "" },
  });

  return { bazaar: enriched ?? built.bazaar };
}

/**
 * The replay guard's key for one payment: the same for every presentation of
 * one authorisation, and not something an agent can vary.
 *
 * It keys on what the token contract keys on,
 * `authorizationState[payer][nonce]`, plus the token from our configuration
 * (never from the payment). The nonce alone would make the nonce space global
 * across payers. Hex is lowercased and
 * amounts go through BigInt, so `0xABCD` and `0xabcd` are not two payments.
 * The protocol version and the agent's copy of amount and address stay out:
 * an agent could vary them freely.
 *
 * Without an authorisation the signature is used, and without either the
 * whole canonicalised payload. That last case is weak: a field the verifier
 * ignores would change the fingerprint while the payment stays valid.
 */
export function paymentFingerprint(payload: PaymentPayload, token: TokenIdentity): string {
  // The decoder is a schemaless base64 JSON parse, so the payload may be
  // anything at all.
  const signed = asRecord(payload.payload) ?? {};
  const authorization = asRecord(signed.authorization);

  const chain = { network: token.network.toLowerCase(), asset: token.asset.toLowerCase() };
  const payer = asHex(authorization?.from);
  const nonce = asHex(authorization?.nonce);
  if (payer !== null && nonce !== null) {
    return authorizationFingerprint({ ...token, payer, nonce });
  }

  const signature = asHex(signed.signature);
  if (signature !== null) {
    return digestOf({ ...chain, by: "signature", signature });
  }

  return digestOf({ ...chain, by: "payload", payload: canonical(signed) });
}

/** The token's one-use authorization identity, shared by submission and recovery. */
export function authorizationFingerprint(
  authorization: TokenIdentity & { readonly payer: string; readonly nonce: string },
): string {
  return digestOf({
    network: authorization.network.toLowerCase(),
    asset: authorization.asset.toLowerCase(),
    by: "authorization",
    payer: authorization.payer.toLowerCase(),
    nonce: authorization.nonce.toLowerCase(),
  });
}

/**
 * The instant a payment's authorisation stops being valid, in milliseconds,
 * from the seconds the exact-EVM scheme signs it with: an EIP-3009
 * authorisation's `validBefore`, or a Permit2 permit's `deadline`. Null where
 * the payment names neither in a spelling read here.
 */
export function authorisedUntil(payload: PaymentPayload): number | null {
  const signed = asRecord(payload.payload);
  const seconds = asAmount(
    asRecord(signed?.authorization)?.validBefore ??
      asRecord(signed?.permit2Authorization)?.deadline,
  );
  return seconds === null ? null : Number(seconds) * 1_000;
}

export interface TokenIdentity {
  readonly network: string;
  readonly asset: string;
}

/** The amounts a scheme writes, which are numbers however they are spelled. */
const AMOUNTS = new Set(["value", "amount", "validAfter", "validBefore", "maxAmount"]);

/**
 * The payload with hex lowercased and amounts put through BigInt, so two
 * spellings of one payment come out identical.
 */
function canonical(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((held) => canonical(held));
  }
  const record = asRecord(value);
  if (record !== null) {
    return Object.fromEntries(
      Object.entries(record).map(([name, held]) => [name, canonical(held, name)]),
    );
  }
  if (key !== undefined && AMOUNTS.has(key)) {
    return asAmount(value) ?? value;
  }
  return asHex(value) ?? value;
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(stably(value)).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asHex(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? value.toLowerCase() : null;
}

/**
 * A whole number in one spelling. A JSON number past 2^53 is left alone, since
 * it is no longer the integer it was written as.
 */
function asAmount(value: unknown): string | null {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value).toString();
  }
  if (typeof value === "string" && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(value)) {
    return BigInt(value).toString();
  }
  return null;
}

/** JSON with its keys in a fixed order, so the same value has one text. */
function stably(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stably).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${stably(held)}`).join(",")}}`;
}

/**
 * What an agent presented, if anything, and the payment reference it names its
 * order by.
 * `null` means no payment; `"unreadable"` means one that would not decode,
 * which the caller answers with a fresh challenge that says so, or the agent
 * cannot tell its own encoding is at fault.
 */
export function presentedPayment(headers: Record<string, string | string[] | undefined>):
  | {
      readonly raw: string;
      readonly payload: PaymentPayload;
      readonly paymentRef: string | null;
    }
  | "unreadable"
  | null {
  const header =
    headerValue(headers, PAYMENT_SIGNATURE_HEADER) ??
    headerValue(headers, PAYMENT_SIGNATURE_HEADER_V1);
  if (header === undefined) {
    return null;
  }

  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    return "unreadable";
  }

  const named = payload.accepted?.extra?.[PAYMENT_REF_IN_EXTRA];
  return { raw: header, payload, paymentRef: typeof named === "string" ? named : null };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const found = headers[name.toLowerCase()];
  return Array.isArray(found) ? found[0] : found;
}

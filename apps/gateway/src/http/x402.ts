/**
 * The payment protocol at the edge. Encoding and decoding are the official x402
 * packages'; this file adds which order a payment is for. The all-in-one x402
 * middleware is not used because it verifies and settles around one request,
 * and the order machine needs the two apart.
 *
 * The order identifier travels in the requirements' `extra` and comes back
 * inside the payment. It is a hint, never an authority: a payment is checked
 * against the price on our own order.
 */

import { createHash } from "node:crypto";
import type { BazaarDeclaration, Card } from "@nuanu-ai/agentify-contracts";
import {
  API_ROUTES,
  bazaarDeclarationOf,
  expandPath,
  PAYABLE_CURRENCIES,
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
import { isSandboxFacilitator, type PaymentConfig } from "../config.js";

/** The x402 version this edge speaks. */
export const X402_VERSION = 2;

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "payment-signature";
/** The payment header's name in version 1 of the protocol. */
export const PAYMENT_SIGNATURE_HEADER_V1 = "x-payment";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export const ORDER_ID_IN_EXTRA = "order_id";

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

export class PaymentEdge {
  readonly #config: PaymentConfig;
  readonly #baseUrl: string;
  readonly #timeoutSeconds: number;

  constructor(config: PaymentConfig, baseUrl: string, timeoutSeconds: number) {
    this.#config = config;
    this.#baseUrl = baseUrl;
    this.#timeoutSeconds = timeoutSeconds;
  }

  /**
   * What an agent is asked to pay, to whom, and for which order. The agent pays
   * the card's own merchant directly, so the address comes from that merchant,
   * never from our configuration.
   *
   * A merchant with no address is refused, never defaulted: the configured
   * address is the operator's, and standing it in would send a merchant's
   * takings to somebody else irreversibly. It is used only in the sandbox,
   * which settles against nothing.
   */
  requirementsFor(
    price: { readonly amount: string; readonly currency: string },
    orderId: string | null,
    payoutWallet: string | null,
  ): PaymentRequirements {
    if (!PAYABLE_CURRENCIES.includes(price.currency.toUpperCase())) {
      throw new Error(
        `${price.currency} is not a currency this gateway can charge in, and it will not invent a rate to one that is`,
      );
    }

    const payTo = payoutWallet ?? this.#sandboxPlaceholder();

    const asset = getDefaultAsset(this.#network());
    return {
      scheme: "exact",
      network: this.#network(),
      asset: asset.asset,
      amount: atomicUnits(price.amount, asset.decimals),
      payTo,
      maxTimeoutSeconds: this.#timeoutSeconds,
      extra: {
        name: asset.name,
        version: asset.version,
        // A challenge for a card alone, with no order behind it, names none.
        ...(orderId === null ? {} : { [ORDER_ID_IN_EXTRA]: orderId }),
      },
    };
  }

  /**
   * The canonical address of one product, which a catalog listing is keyed on.
   * It is built from the configured base, never from the request: behind a
   * TLS-terminating proxy the request says `http://` and carries the caller's
   * query string, and two spellings would be two listings. The identifier goes
   * through the route table's substitution so it cannot add path segments.
   */
  resourceUrlFor(itemId: string): string {
    return `${this.#baseUrl}${expandPath(API_ROUTES.purchase_item.path, { item_id: itemId })}`;
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
    orderId: string | null,
    listed: {
      readonly itemId: string;
      readonly card: Card;
      readonly serviceName: string | null;
      readonly payoutWallet: string | null;
    },
    why?: string,
  ): string {
    const declared = bazaarDeclarationOf(listed.card, {
      url: this.resourceUrlFor(listed.itemId),
      serviceName: listed.serviceName,
    });

    // A parcel's listed price is for the goods alone, and its purchase is
    // priced with shipping to the address named; the agent is told which
    // number it is reading.
    const said =
      listed.card.fulfillment === "ship"
        ? [why, orderId === null ? PARCEL_LISTED : PARCEL_PRICED]
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
      accepts: [this.requirementsFor(price, orderId, listed.payoutWallet)],
      extensions: discoveryExtensionOf(declared),
    };
    return encodePaymentRequiredHeader(challenge);
  }

  receiptHeader(settlement: SettleResponse): string {
    return encodePaymentResponseHeader(settlement);
  }

  /**
   * The placeholder address the sandbox names where the merchant has set none.
   * Everywhere else this refuses; the two refusals differ because one is fixed
   * by the merchant and the other by the operator.
   */
  #sandboxPlaceholder(): string {
    if (!isSandboxFacilitator(this.#config.facilitatorUrl)) {
      throw new Error(
        "there is nowhere to send the money: the merchant who published this product has set no wallet to be paid at, and this gateway will not stand its own address in for theirs",
      );
    }
    const configured = this.#config.payTo;
    if (configured === null) {
      throw new Error(
        "there is nowhere to send the money: no payment address is configured, so no payment can be asked for",
      );
    }
    return configured;
  }

  #network(): `${string}:${string}` {
    return this.#config.network as `${string}:${string}`;
  }

  token(): TokenIdentity {
    return { network: this.#config.network, asset: getDefaultAsset(this.#network()).asset };
  }
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
    return digestOf({ ...chain, by: "authorization", payer, nonce });
  }

  const signature = asHex(signed.signature);
  if (signature !== null) {
    return digestOf({ ...chain, by: "signature", signature });
  }

  return digestOf({ ...chain, by: "payload", payload: canonical(signed) });
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
 * What an agent presented, if anything, and which order it says it is for.
 * `null` means no payment; `"unreadable"` means one that would not decode,
 * which the caller answers with a fresh challenge that says so, or the agent
 * cannot tell its own encoding is at fault.
 */
export function presentedPayment(headers: Record<string, string | string[] | undefined>):
  | {
      readonly raw: string;
      readonly payload: PaymentPayload;
      readonly orderId: string | null;
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

  const named = payload.accepted?.extra?.[ORDER_ID_IN_EXTRA];
  return { raw: header, payload, orderId: typeof named === "string" ? named : null };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const found = headers[name.toLowerCase()];
  return Array.isArray(found) ? found[0] : found;
}

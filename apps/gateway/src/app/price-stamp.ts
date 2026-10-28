import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const TOKEN_LIMIT = 4_096;
const FACTS_LIMIT = 1_048_576;
const STAMP_DOMAIN = "agentify:price-stamp:v1\0";
const OFFER_FIELDS = [
  "version",
  "priceId",
  "itemId",
  "merchantId",
  "integration",
  "cardDigest",
  "paramsDigest",
  "placeDigest",
  "amount",
  "currency",
  "source",
  "asOf",
  "quotedAt",
  "expiresAt",
  "network",
  "payTo",
  "asset",
  "assetName",
  "assetVersion",
  "maxTimeoutSeconds",
  "quoteReference",
] as const;
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.number().int().min(0).max(8_640_000_000_000_000);

const offerSchema = z
  .strictObject({
    version: z.literal(1),
    priceId: identifier,
    itemId: identifier,
    merchantId: identifier,
    integration: z.enum(["api", "woocommerce"]),
    cardDigest: digest,
    paramsDigest: digest,
    placeDigest: digest,
    amount: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,17})\.\d{2,6}$/)
      .refine((amount) => {
        const [whole = "0", fraction = ""] = amount.split(".");
        return BigInt(`${whole}${fraction.padEnd(6, "0")}`) >= 10_000n;
      }),
    currency: z.enum(["USD", "USDC"]),
    source: z.enum(["card_snapshot", "merchant_answer"]),
    asOf: instant,
    quotedAt: instant,
    expiresAt: instant,
    network: z.string().regex(/^eip155:[1-9]\d{0,15}$/),
    payTo: z.string().regex(/^0x[\da-fA-F]{40}$/),
    asset: z.string().regex(/^0x[\da-fA-F]{40}$/),
    assetName: z.string().min(1).max(128),
    assetVersion: z.string().min(1).max(32),
    quoteReference: z
      .string()
      .regex(/^[\x20-\x7e]{1,512}$/)
      .optional(),
    maxTimeoutSeconds: z.number().int().min(1).max(2_147_483_647),
  })
  .refine((offer) => offer.expiresAt > offer.quotedAt);

/** The public facts committed to by an offer, with private inputs represented only by keyed digests. */
export type PriceOffer = Readonly<z.infer<typeof offerSchema>>;

/** The gateway signs with its current key and may accept an outstanding offer under its previous key. */
export interface PriceStampKeys {
  readonly current: string;
  readonly previous?: string;
}

/** Signs an offer; malformed facts or a key shorter than 32 bytes are programming/configuration errors. */
export function stampPrice(offer: PriceOffer, key: string): string {
  const facts = offerSchema.parse(offer);
  // Positional encoding keeps the opaque offer within ordinary HTTP header budgets.
  const payload = Buffer.from(
    JSON.stringify(OFFER_FIELDS.map((field) => facts[field] ?? null)),
  ).toString("base64url");
  const token = `v1.${payload}.${macOf(payload, key).toString("base64url")}`;
  if (token.length > TOKEN_LIMIT) throw new Error("The stamped price exceeds its size limit.");
  return token;
}

/** Reads bounded syntax for an existing-order lookup. This does not authenticate any fact in the offer. */
export function decodePriceStamp(token: string): PriceOffer | null {
  return parsedStamp(token)?.offer ?? null;
}

/** Authenticates an offer without deciding its expiry; existing paid recovery has a different clock. */
export function verifyPriceStamp(
  token: string,
  keys: PriceStampKeys,
): { readonly offer: PriceOffer; readonly key: "current" | "previous" } | null {
  const parsed = parsedStamp(token);
  if (parsed === null) return null;
  if (timingSafeEqual(parsed.mac, macOf(parsed.payload, keys.current))) {
    return { offer: parsed.offer, key: "current" };
  }
  if (
    keys.previous !== undefined &&
    timingSafeEqual(parsed.mac, macOf(parsed.payload, keys.previous))
  ) {
    return { offer: parsed.offer, key: "previous" };
  }
  return null;
}

/** Digests canonical JSON; the key prevents guessing private inputs from a published offer's digest. */
export function priceFactsDigest(
  value: unknown,
  key: string,
  kind: "card" | "params" | "place",
): string {
  const written = canonicalJson(value);
  return createHmac("sha256", signingKey(key))
    .update(`agentify:price-facts:v1:${kind}\0`)
    .update(written)
    .digest("hex");
}

/** One question names one order across signatures, stamp keys and repeated HTTP requests. */
export function orderIdForPrice(
  offer: Pick<PriceOffer, "priceId" | "merchantId" | "itemId">,
): string {
  const identity = [
    identifier.parse(offer.priceId),
    identifier.parse(offer.merchantId),
    identifier.parse(offer.itemId),
  ];
  const bytes = createHash("sha256")
    .update("agentify:price-order:v1\0")
    .update(JSON.stringify(identity))
    .digest()
    .subarray(0, 16);
  // A domain-specific UUID uses version 8; the gateway's identifiers omit its dashes.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return `ord_${bytes.toString("hex")}`;
}

function macOf(payload: string, key: string): Buffer {
  return createHmac("sha256", signingKey(key)).update(STAMP_DOMAIN).update(payload).digest();
}

function signingKey(key: string): string {
  if (Buffer.byteLength(key) < 32) throw new Error("A price stamp key needs at least 32 bytes.");
  return key;
}

function parsedStamp(
  token: string,
): { readonly offer: PriceOffer; readonly payload: string; readonly mac: Buffer } | null {
  if (token.length > TOKEN_LIMIT) return null;
  const parts = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  const payload = parts?.[1];
  const mac = parts?.[2];
  if (payload === undefined || mac === undefined) return null;
  const bytes = Buffer.from(payload, "base64url");
  const signature = Buffer.from(mac, "base64url");
  if (bytes.toString("base64url") !== payload || signature.toString("base64url") !== mac) {
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!Array.isArray(decoded) || decoded.length !== OFFER_FIELDS.length) return null;
    const facts = Object.fromEntries(OFFER_FIELDS.map((field, index) => [field, decoded[index]]));
    if (facts.quoteReference === null) delete facts.quoteReference;
    const parsed = offerSchema.safeParse(facts);
    return parsed.success ? { offer: parsed.data, payload, mac: signature } : null;
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown): string {
  const visiting = new Set<object>();
  let remaining = FACTS_LIMIT;
  const spend = (text: string): string => {
    remaining -= Buffer.byteLength(text);
    if (remaining < 0) throw new Error("The price facts exceed their size limit.");
    return text;
  };
  const write = (held: unknown, depth: number): string => {
    if (depth > 64) throw new Error("The price facts exceed their nesting limit.");
    if (held === null || typeof held === "string" || typeof held === "boolean") {
      return spend(JSON.stringify(held));
    }
    if (typeof held === "number" && Number.isFinite(held)) return spend(JSON.stringify(held));
    if (typeof held !== "object" || held === null) {
      throw new Error("The price facts must be JSON values.");
    }
    if (visiting.has(held)) throw new Error("The price facts must not contain a cycle.");
    visiting.add(held);
    try {
      if (Array.isArray(held)) {
        spend("[]");
        return `[${Array.from(held)
          .map((entry, index) => `${index === 0 ? "" : spend(",")}${write(entry, depth + 1)}`)
          .join("")}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(held);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("The price facts must be JSON objects.");
      }
      spend("{}");
      const record = held as Readonly<Record<string, unknown>>;
      return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map(
          (key, index) =>
            `${index === 0 ? "" : spend(",")}${spend(JSON.stringify(key))}${spend(":")}${write(record[key], depth + 1)}`,
        )
        .join("")}}`;
    } finally {
      visiting.delete(held);
    }
  };
  return write(value, 0);
}

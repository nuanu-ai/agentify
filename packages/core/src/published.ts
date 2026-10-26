/**
 * The numbers the gateway runs that the portal, the landing and the dashboard
 * publish, and the words they are said in: the defaults of its configuration's
 * deadlines, its purchase door's limits and the commission its payout splits
 * take. A page writes one of these out from here rather than copying it. The
 * pages state the defaults, so a deployment that sets one of them in its
 * environment serves pages that no longer describe it. Other numbers Agentify
 * publishes, such as the SDK's or a shop connector's timeouts, live with the
 * code that runs them.
 *
 * Pure constants and pure functions only, importing nothing: the landing
 * bundles this module for the browser.
 */

/** How long we wait for the merchant to say what the goods cost. */
export const QUOTE_RESPONSE_MS = 5_000;
/** How long a price holds, and with it the unpaid order it was named for. */
export const QUOTE_TTL_MS = 30_000;
/** How long a handler has to answer one hand-over of an order. */
export const HANDLER_ANSWER_MS = 3_000;
/** How long the merchant has to answer a synchronous order with the goods, from the payment check. */
export const SYNC_RESPONSE_MS = 10_000;
/** The ceiling the agent is promised for a synchronous purchase, from the same moment. */
export const SYNC_BUDGET_MS = 20_000;
/** How long we wait to hear whether a charge went through, on a synchronous order. */
export const SETTLE_RESPONSE_MS = 10_000;
/** The same wait on an order charged before its goods. */
export const SETTLE_BEFORE_GOODS_MS = 15_000;
/** What a card that names no delivery deadline of its own is held to. */
export const DEFAULT_ASYNC_FULFILLMENT_MS = 86_400_000;
/** How many times in all an order is handed to the merchant's process. */
export const REDELIVERY_MAX_ATTEMPTS = 5;

/**
 * How many of one seller's purchases may be priced and waiting for payment at
 * once, counted at the birth of each; one beyond them is refused as
 * `seller_busy`. A constant rather than a setting, since a knob here either
 * lets anyone load a seller's shop with purchases nobody pays or stops the
 * seller's every sale.
 */
export const WAITING_FOR_PAYMENT_AT_MOST = 50;

/**
 * How many of a seller's paid orders may be taken on and left with nothing
 * delivered or closed before every new purchase of theirs is refused as
 * `seller_not_fulfilling`, and their cards leave the catalogue. A constant
 * rather than a setting, since a knob here could switch the guard off or stop
 * a seller's every sale.
 */
export const UNSERVED_AT_MOST = 10;

/**
 * How long a seller's own process may go without polling before their
 * purchases are refused and their cards left out of the catalogue: past it,
 * nobody is there to take an order up. Nothing is paused and nothing has to
 * be resumed; the first poll lets the next purchase through. A constant rather
 * than a setting: a knob here could switch the guard off, or refuse every sale
 * of a seller whose process is running.
 */
export const SILENT_AFTER_MS = 10 * 60_000;

/**
 * How long an attempt that lapsed unpaid is kept after it was last written:
 * long enough for its buyer or merchant to ask about a failed purchase, after
 * which nothing it records is anybody's money or goods.
 */
export const LAPSED_KEPT_MS = 30 * 86_400_000;

const ONES = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** A whole number from one to ninety-nine as a sentence writes it, such as "five" or "forty-eight". */
export function inWords(count: number): string {
  if (!Number.isInteger(count) || count < 1 || count > 99) {
    throw new Error(
      `cannot say ${count} in words: only whole numbers from one to ninety-nine are spelled out`,
    );
  }
  if (count < 20) return ONES[count] ?? "";
  const ones = ONES[count % 10] ?? "";
  const tens = TENS[Math.floor(count / 10)] ?? "";
  return ones === "" ? tens : `${tens}-${ones}`;
}

/** The ordinals that are not their number's word with "th" after it. */
const ORDINALS: Readonly<Record<string, string>> = {
  one: "first",
  two: "second",
  three: "third",
  five: "fifth",
  eight: "eighth",
  nine: "ninth",
  twelve: "twelfth",
};

/** A whole number from one to ninety-nine as a place in a row, such as "tenth" or "twenty-first". */
export function ordinalInWords(count: number): string {
  const words = inWords(count);
  const at = words.lastIndexOf("-") + 1;
  const last = words.slice(at);
  const ordinal = ORDINALS[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return `${words.slice(0, at)}${ordinal}`;
}

/** The units a published stretch of time is counted in. */
export type Unit = "second" | "minute" | "day";

const UNIT_MS: Readonly<Record<Unit, number>> = {
  second: 1_000,
  minute: 60_000,
  day: 86_400_000,
};

/** How many of the unit a stretch of time is, refused where it is no whole number of them. */
export function unitsIn(ms: number, unit: Unit): number {
  const count = ms / UNIT_MS[unit];
  if (!Number.isInteger(count)) {
    throw new Error(`${ms} ms is not a whole number of ${unit}s, so it cannot be said in ${unit}s`);
  }
  return count;
}

/** A stretch of time in words, counted in the unit its sentence names: "thirty seconds", "a day". */
export function durationInWords(ms: number, unit: Unit): string {
  const count = unitsIn(ms, unit);
  return count === 1 ? `a ${unit}` : `${inWords(count)} ${unit}s`;
}

/** Agentify's part of a payout split's total, and the total. */
export interface CommissionRate {
  readonly commissionAllocation: number;
  readonly totalAllocation: number;
}

/**
 * Agentify's share of every payment, on every network. The rate enters every
 * split's address, so changing it moves every merchant's money to new
 * addresses.
 */
export const COMMISSION_RATE: CommissionRate = {
  commissionAllocation: 1_000,
  totalAllocation: 1_000_000,
};

/** A percentage is said to six places at most, as many as USDC carries. */
const SCALE = 1_000_000n;

/**
 * A part of a split's total as a percentage, such as "0.1%". Throws where it
 * has no exact decimal within USDC's places, which no rate in the code has.
 */
export function percentOf(part: number, total: number): string {
  const scaled = BigInt(part) * 100n * SCALE;
  if (scaled % BigInt(total) !== 0n) {
    throw new Error(`${part} of ${total} has no exact percentage to say`);
  }
  const units = scaled / BigInt(total);
  const whole = units / SCALE;
  const fraction = (units % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? `${whole}%` : `${whole}.${fraction}%`;
}

/** Agentify's percentage of every sale and the merchant's, such as "0.1%" and "99.9%". */
export const percentagesOf = (
  rate: CommissionRate,
): { readonly commission: string; readonly share: string } => ({
  commission: percentOf(rate.commissionAllocation, rate.totalAllocation),
  share: percentOf(rate.totalAllocation - rate.commissionAllocation, rate.totalAllocation),
});

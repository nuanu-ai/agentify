/**
 * How a payment divides between the merchant and Agentify, said the way the
 * payout split divides it: in whole units of USDC's six places, each share
 * rounded down, so the two never add up to more than was paid. The split
 * divides what it holds when somebody pays it out, not each payment, so a
 * share of one payment is said as about that much and never as an exact sum.
 * The orders, the receipts and the shop's order lines all say it through this.
 */

/** The places USDC carries: its smallest unit is a millionth. */
const PLACES = 6;
const UNIT = 10n ** BigInt(PLACES);

/** The parts of a payout split's total that its two recipients receive. */
export interface SplitTerms {
  readonly merchantAllocation: number;
  readonly commissionAllocation: number;
  readonly totalAllocation: number;
}

/** Agentify's part of a payout split's total, and the total. */
export interface CommissionRate {
  readonly commissionAllocation: number;
  readonly totalAllocation: number;
}

/** Each share as a person reads it, with the currency. */
export interface Shares {
  readonly merchant: string;
  readonly commission: string;
}

/**
 * Throws on an amount with more places than USDC carries: no payment could
 * have been charged at it.
 */
const unitsOf = (amount: string): bigint => {
  const [whole = "", fraction = ""] = amount.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > PLACES) {
    throw new Error(`${amount} is not an amount USDC can be paid in`);
  }
  return BigInt(`${whole}${fraction.padEnd(PLACES, "0")}`);
};

/** At least as many places as the price was written with, and no trailing zero beyond them. */
const written = (units: bigint, places: number): string => {
  const digits = units.toString().padStart(PLACES + 1, "0");
  const whole = digits.slice(0, -PLACES);
  const fraction = digits.slice(-PLACES).replace(/0+$/, "").padEnd(places, "0");
  return fraction === "" ? whole : `${whole}.${fraction}`;
};

const said = (units: bigint, places: number, currency: string): string =>
  units === 0n
    ? `under ${written(1n, PLACES)} ${currency}`
    : `≈ ${written(units, places)} ${currency}`;

/**
 * The merchant's share and Agentify's of a payment of this price into a split
 * on these terms.
 */
export const sharesOf = (
  price: { readonly amount: string; readonly currency: string },
  terms: SplitTerms,
): Shares => {
  const paid = unitsOf(price.amount);
  const places = price.amount.split(".")[1]?.length ?? 0;
  const total = BigInt(terms.totalAllocation);
  return {
    merchant: said((paid * BigInt(terms.merchantAllocation)) / total, places, price.currency),
    commission: said((paid * BigInt(terms.commissionAllocation)) / total, places, price.currency),
  };
};

/** Agentify's percentage of every sale and the merchant's, such as "0.1%" and "99.9%". */
export const percentagesOf = (
  rate: CommissionRate,
): { readonly commission: string; readonly share: string } => ({
  commission: percentOf(rate.commissionAllocation, rate.totalAllocation),
  share: percentOf(rate.totalAllocation - rate.commissionAllocation, rate.totalAllocation),
});

/**
 * A part of a split's total as a percentage, such as "0.1%". Throws where it
 * has no exact decimal within USDC's places, which no rate in the code has.
 */
export const percentOf = (part: number, total: number): string => {
  const scaled = BigInt(part) * 100n * UNIT;
  if (scaled % BigInt(total) !== 0n) {
    throw new Error(`${part} of ${total} has no exact percentage to say`);
  }
  return `${written(scaled / BigInt(total), 0)}%`;
};

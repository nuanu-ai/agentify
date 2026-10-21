/**
 * Amounts as a WooCommerce shop writes them, and the merchant's rate that turns
 * them into the US dollars a buyer pays. A shop writes every total at its one
 * Number of decimals setting, none or two here, so an amount carries its
 * decimals in its own digits: "250000" is a rupiah amount at none, "25.00" a
 * dollar amount at two. Everything is counted in whole units of the last
 * digit, as integers, so no floating-point fraction ever decides a cent.
 */

/** The shop's Number of decimals the connector sells at. */
export type ShopDecimals = 0 | 2;

export const shopDecimalsOf = (setting: string): ShopDecimals | null =>
  setting === "0" ? 0 : setting === "2" ? 2 : null;

/**
 * WooCommerce keeps ".99" as typed and drops a trailing dot, so "5." never
 * arrives and is not a price here.
 */
export const TYPED_PRICE = /^(?=\.?\d)(\d*)(?:\.(\d+))?$/;

/**
 * WooCommerce keeps a price as typed, so `wc/v3` answers `"25"` and `"19.9"`
 * where the Store API and order totals write 25.00 and 19.90. The card, the
 * quote and the order are compared with those totals character for character,
 * so this is the one form they all carry. Padding, adding a leading zero, and
 * dropping leading zeros or zeros past the shop's decimals are exact; dropping
 * any other digit is rounding, so `"25.001"` is null rather than `"25.00"`.
 */
export const shopAmountOf = (typed: string, decimals: ShopDecimals): string | null => {
  const written = TYPED_PRICE.exec(typed);
  if (written === null) return null;
  // A whole part left empty, as in ".99", is the zero it stands for.
  const whole = (written[1] ?? "").replace(/^0+/, "") || "0";
  const fraction = written[2] ?? "";
  if (/[1-9]/.test(fraction.slice(decimals))) return null;
  return decimals === 0 ? whole : `${whole}.${fraction.slice(0, decimals).padEnd(decimals, "0")}`;
};

/** An amount counted in its smallest written unit; null where it is not at none or two decimals. */
export const minorOf = (amount: string): { minor: bigint; decimals: ShopDecimals } | null => {
  const written = /^(\d+)(?:\.(\d{2}))?$/.exec(amount);
  if (written === null) return null;
  return {
    minor: BigInt(`${written[1]}${written[2] ?? ""}`),
    decimals: written[2] === undefined ? 0 : 2,
  };
};

export const amountOfMinor = (minor: bigint, decimals: ShopDecimals): string => {
  if (decimals === 0) return minor.toString();
  const digits = minor.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
};

/** Goods and shipping, added only where both are written at the same decimals. */
export const sumOf = (one: string, other: string): string | null => {
  const left = minorOf(one);
  const right = minorOf(other);
  return left === null || right === null || left.decimals !== right.decimals
    ? null
    : amountOfMinor(left.minor + right.minor, left.decimals);
};

/**
 * Whether a total the shop recorded is the amount it was priced at, or one of
 * the shop's smallest written units either side of it: a cent where it writes
 * two decimals, a rupiah where it writes none. That is as far as WooCommerce's
 * own rounding of a cart and the order made from it was measured to part them.
 */
export const withinOneUnit = (recorded: string, priced: string): boolean => {
  const shop = minorOf(recorded);
  const bound = minorOf(priced);
  return (
    shop !== null &&
    bound !== null &&
    shop.decimals === bound.decimals &&
    shop.minor - bound.minor <= 1n &&
    bound.minor - shop.minor <= 1n
  );
};

/** A positive decimal, as an integer and the power of ten it is divided by. */
const exactOf = (decimal: string): { units: bigint; scale: bigint } | null => {
  const written = /^(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (written === null) return null;
  const fraction = written[2] ?? "";
  return { units: BigInt(`${written[1]}${fraction}`), scale: 10n ** BigInt(fraction.length) };
};

/**
 * How many units of the shop's currency one US dollar buys, as the merchant
 * typed it: digits, and a dot only before at most six more. A comma or a space
 * between thousands is refused rather than guessed at, because "18,000" and
 * "18.000" mean eighteen thousand in some countries and eighteen in others.
 */
export const rateWrittenAs = (typed: string): string | null => {
  const written = /^(\d*)(?:\.(\d{1,6}))?$/.exec(typed.trim());
  if (written === null || `${written[1]}${written[2] ?? ""}` === "") return null;
  const whole = (written[1] ?? "").replace(/^0+/, "") || "0";
  const rate = written[2] === undefined ? whole : `${whole}.${written[2]}`;
  return /[1-9]/.test(rate) ? rate : null;
};

/**
 * The shop's amount in US dollars at a rate, rounded up to the cent, so the
 * buyer pays at most a cent more than the exact conversion and the merchant
 * never receives less than their own price at their own rate. Null where the
 * amount is not one the shop writes or the rate is nothing.
 */
export const dollarsAt = (amount: string, rate: string): string | null => {
  const shop = minorOf(amount);
  const per = exactOf(rate);
  if (shop === null || per === null || per.units === 0n) return null;
  // amount / rate in cents: (minor / 10^decimals) / (units / scale) * 100.
  const numerator = shop.minor * per.scale * 100n;
  const denominator = per.units * 10n ** BigInt(shop.decimals);
  return amountOfMinor((numerator + denominator - 1n) / denominator, 2);
};

/** How far the merchant's rate stands from the reference, as the screen says it. */
export interface RateGap {
  /** More than the tenth either way past which the rate has to be typed again. */
  readonly far: boolean;
  /** "0.2% below", to one decimal; for reading, never for deciding. */
  readonly shown: string;
}

export const gapOf = (rate: string, reference: string): RateGap => {
  const mine = exactOf(rate);
  const theirs = exactOf(reference);
  if (mine === null || theirs === null || theirs.units === 0n) {
    return { far: false, shown: "not comparable" };
  }
  // Both over one denominator: mine = a / d, theirs = b / d.
  const a = mine.units * theirs.scale;
  const b = theirs.units * mine.scale;
  const apart = a > b ? a - b : b - a;
  const tenthsOfAPercent = (apart * 1000n + b / 2n) / b;
  const percent = `${tenthsOfAPercent / 10n}.${tenthsOfAPercent % 10n}%`;
  return {
    far: apart * 10n > b,
    shown: a === b ? "level with it" : `${percent} ${a > b ? "above" : "below"}`,
  };
};

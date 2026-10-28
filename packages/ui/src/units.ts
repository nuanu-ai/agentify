/**
 * A number and its unit kept on one line where a person reads them: "5 GB",
 * "30 days", "8.00 USD". The space between them becomes a no-break space, for
 * the HTML a person reads and nothing else. Whatever is stored, sent, mailed,
 * copied as data or read by an agent keeps the ordinary space it was written
 * with, and a search compares what was shown `asTyped`, so words typed with an
 * ordinary space still find it.
 */

const NO_BREAK = "\u00a0";

/**
 * The units the site writes after a number and those merchants' product names
 * carry: a spelled-out unit may open with a capital, as a product's title
 * often writes it, and an abbreviation is matched as it is written.
 */
const UNITS = [
  "ms",
  "s",
  "min",
  "h",
  "d",
  "[Ss]econds?",
  "[Mm]inutes?",
  "[Hh]ours?",
  "[Dd]ays?",
  "[Ww]eeks?",
  "[Mm]onths?",
  "[Yy]ears?",
  "[Nn]ights?",
  "USDC",
  "USD",
  "IDR",
  "TB",
  "GB",
  "MB",
  "KB",
  "GiB",
  "MiB",
  "KiB",
  "bytes",
  "Mbps",
  "mm",
  "cm",
  "kg",
  "g",
  "ml",
];

/**
 * A number that is not the tail of a word or of a longer number, `space`, and
 * a unit that is a whole word, as the source of a regular expression with the
 * `u` flag: "5 mines" holds no unit. Its groups are the number, the space and
 * the unit. The gallery's check reads a page's text by it, so the units it
 * measures are the ones joined here.
 */
export const numberThenUnit = (space: string): string =>
  String.raw`(?<![\p{L}\p{N}_.,])(\d(?:[\d.,]*\d)?)(${space})(${UNITS.join("|")})(?![\p{L}\p{N}_])`;

const NUMBER_THEN_UNIT = new RegExp(numberThenUnit(" "), "gu");

/** `text` with the space between each number and the unit after it made a no-break space. */
export const keepUnits = (text: string): string =>
  text.replace(NUMBER_THEN_UNIT, `$1${NO_BREAK}$3`);

/** A number and a unit the caller knows to be one, such as a shop's currency, joined as `keepUnits` joins them. */
export const withUnit = (number: string | number, unit: string): string =>
  `${number}${NO_BREAK}${unit}`;

/** `text` with every no-break space an ordinary one, as a person types it into a search. */
export const asTyped = (text: string): string => text.replaceAll(NO_BREAK, " ");

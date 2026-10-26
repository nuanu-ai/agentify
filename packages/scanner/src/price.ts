/**
 * Whether a page states a price, and where it says so.
 *
 * Structured data is read first, since it says what the amount and the
 * currency are: a JSON-LD offer, a microdata `itemprop="price"`, or the
 * `product:price:amount` and `og:price:amount` meta tags. Failing that, the
 * page's visible text is read for an amount written next to a currency
 * marker, before it or after it. Scripts, comments, template content and
 * other attributes are never read for a price, since a `$1` there is code or
 * markup rather than an offer the page shows.
 *
 * The markers are every ISO 4217 code the runtime knows and the symbols its
 * locale data writes for each currency, in English and in the language of the
 * currency's own country, plus the few that shops widely write and the locale
 * data does not. A marker such as `$` is shared by many currencies, so a price
 * found in the text names no currency.
 */

type PriceSignal = {
  source: "json-ld" | "microdata" | "meta" | "text";
  /** The amount and currency as stated in structured data, or the words of the visible text. */
  price: string;
};

/** What microdata or meta tags state, as written. */
export type MarkedPrice = { amount?: string; currency?: string };

const CODES: ReadonlySet<string> = new Set(Intl.supportedValuesOf("currency"));

// Markers shops widely write that the runtime's locale data does not.
const WRITTEN_BY_SHOPS = [
  // Japanese shops write 1,980円; the locale data writes ￥ and ¥.
  "円",
  // Chinese shops write 199元 beside ¥.
  "元",
  // Korean shops write 15,000원; the locale data writes ₩.
  "원",
  // Vietnamese shops write 150.000đ beside ₫.
  "đ",
  // Turkish shops write 149,90 TL; the locale data writes ₺.
  "TL",
  // Russian shops write 1 500 руб.; the locale data writes ₽.
  "руб",
  // Ukrainian shops write 1 200 грн; the locale data writes ₴.
  "грн",
  // Kenyan shops write KSh 1,500; the locale data writes Ksh.
  "KSh",
];

const LETTER = /\p{L}/u;
const isLetter = (char: string | undefined): boolean => char !== undefined && LETTER.test(char);
// Scripts with upper and lower case separate their words; a marker written
// in one does not run into a word. Japanese, Chinese and Korean attach the
// next word to 円, 元 or 원.
const CASED = /[\p{Lu}\p{Ll}\p{Lt}]/u;
const runsInto = (edge: string | undefined, next: string | undefined): boolean =>
  edge !== undefined && next !== undefined && CASED.test(edge) && CASED.test(next);

// A marker without the invisible marks some locales write into it, its spaces
// made plain, and without a closing dot after a letter, which the reader
// accepts after any marker that ends in a letter: kr. and kr, Rs. and Rs.
const normalized = (marker: string): string => {
  const plain = marker
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 1 && plain.endsWith(".") && isLetter(plain.at(-2))
    ? plain.slice(0, -1)
    : plain;
};

const markersFromLocaleData = (): Set<string> => {
  const regions = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const markers = new Set<string>(CODES);
  for (const code of CODES) {
    // A code's first two letters name its country, except for the X codes,
    // which belong to no country.
    const region = code.slice(0, 2);
    const locales = ["en"];
    if (!region.startsWith("X") && regions.of(region))
      locales.push(`${new Intl.Locale(`und-${region}`).maximize().language}-${region}`);
    for (const locale of locales)
      for (const currencyDisplay of ["symbol", "narrowSymbol"] as const) {
        const symbol = new Intl.NumberFormat(locale, {
          style: "currency",
          currency: code,
          currencyDisplay,
        })
          .formatToParts(1)
          .find((part) => part.type === "currency")?.value;
        if (symbol) markers.add(normalized(symbol));
      }
  }
  for (const marker of WRITTEN_BY_SHOPS) markers.add(marker);
  markers.delete("");
  return markers;
};

// An amount in any locale's grammar: digits of any script, grouped by a
// comma, a dot, an apostrophe or the Arabic and full-width separators, or by
// a space before three digits, and a decimal part that may be a dash, as in
// 1'200.– or 5,-.
const AMOUNT =
  /\p{Nd}+(?:[.,'\u2019\u066b\u066c\uff0c]\p{Nd}+|[ \u00a0\u202f\u2009]\p{Nd}{3}(?!\p{Nd}))*(?:[.,](?:--?|\u2013|\u2014))?/gu;
// A run of digits longer than any price is written with is not taken for an
// amount, which also keeps what the evidence quotes short.
const LONGEST_AMOUNT = 24;

const firstAmount = (text: string): string | undefined => {
  AMOUNT.lastIndex = 0;
  const amount = AMOUNT.exec(text)?.[0];
  return amount && amount.length <= LONGEST_AMOUNT ? amount : undefined;
};

// Each marker's lengths by its last or its first character, the longest
// first, so a number next to no marker's character costs one lookup.
const lengthsBy = (
  markers: ReadonlySet<string>,
  edge: (marker: string) => string,
): Map<string, number[]> => {
  const lengths = new Map<string, number[]>();
  for (const marker of markers) {
    const key = edge(marker);
    const known = lengths.get(key) ?? [];
    if (!known.includes(marker.length)) known.push(marker.length);
    lengths.set(key, known);
  }
  for (const known of lengths.values()) known.sort((a, b) => b - a);
  return lengths;
};

type Markers = {
  all: ReadonlySet<string>;
  byLast: Map<string, number[]>;
  byFirst: Map<string, number[]>;
};
// Building the table takes tens of milliseconds, so it is built for the first
// price looked for in a page's text, not by every process that imports the
// scanner.
let markers: Markers | undefined;
const table = (): Markers => {
  if (!markers) {
    const all = markersFromLocaleData();
    markers = {
      all,
      byLast: lengthsBy(all, (marker) => marker.charAt(marker.length - 1)),
      byFirst: lengthsBy(all, (marker) => marker.charAt(0)),
    };
  }
  return markers;
};
const NONE: number[] = [];

// The marker that ends at `end`, the longest first, that does not begin
// inside a word.
const markerBefore = (text: string, end: number): string | undefined => {
  const { all, byLast } = table();
  for (const length of byLast.get(text.charAt(end - 1)) ?? NONE) {
    const marker = text.slice(end - length, end);
    if (length <= end && all.has(marker) && !runsInto(marker[0], text[end - length - 1]))
      return marker;
  }
  return undefined;
};

// The marker that begins at `start`, the longest first, that does not run
// into a word.
const markerAfter = (text: string, start: number): string | undefined => {
  const { all, byFirst } = table();
  for (const length of byFirst.get(text.charAt(start)) ?? NONE) {
    const marker = text.slice(start, start + length);
    if (all.has(marker) && !runsInto(marker.at(-1), text[start + length])) return marker;
  }
  return undefined;
};

// Markers that are also everyday words, abbreviations or units where shops
// write them. ALL, TOP, TRY, CUP, PEN, MAD, GEL, SOS, BOB, MOP, CAD, BAM and
// ZAR are English words or names; PHP is a programming language, COP a
// climate conference, AWG a wire gauge, AMD and NAD makers of processors and
// amplifiers, RON a fuel's octane rating, SAR a phone's radiation rate and
// CRC a checksum. Ft is feet in a title-cased name, kn is knots, and Le is a
// French article.
const WORDS = new Set(
  "ALL TOP TRY CUP PEN MAD GEL SOS BOB MOP CAD BAM ZAR PHP COP AWG AMD NAD RON SAR CRC Ft kn Le".split(
    " ",
  ),
);

// A marker of one Latin letter, such as R for the rand or Q for the quetzal,
// is also a size, a model or an initial, and two Latin capitals such as FC,
// KM or RM are an abbreviation as often. Such a marker, and one that is a
// word, counts only next to an amount written the way money is, with its
// thousands grouped or a decimal part of two or three digits; one letter
// counts only right before it, where the countries that use it write it.
const oneLetter = (marker: string): boolean => /^[A-Za-z]$/.test(marker);
const wordLike = (marker: string): boolean =>
  oneLetter(marker) || /^[A-Z]{2}$/.test(marker) || WORDS.has(marker);
const MONEY =
  /^\p{Nd}{1,3}(?:[.,'\u2019\u066b\u066c\uff0c \u00a0\u202f\u2009]\p{Nd}{2,3})+(?:[.,](?:--?|\u2013|\u2014))?$|^\p{Nd}+[.,](?:\p{Nd}{2,3}|--?|\u2013|\u2014)$/u;
// A marker of Latin letters next to a year is a date or an edition: Sale 2024
// USD, WORLD CUP 2026.
const LATIN = /^\p{Script=Latin}+$/u;
const YEAR = /^(?:19|20)\d{2}$/;
// Japanese, Chinese and Korean shops write 円, 元 and 원 after the amount; before
// a number they end a word, as in 고객지원 1588 or 公元2024.
const AFTER_ONLY = new Set(["円", "元", "원"]);

const counts = (marker: string, amount: string): boolean =>
  !(wordLike(marker) && !MONEY.test(amount)) && !(LATIN.test(marker) && YEAR.test(amount));

/**
 * The first amount in the visible text written next to a currency marker:
 * Rp 150.000, 5,00 €, CHF 1'200.–, ₹1,20,000, USD 0.01. An amount followed by
 * a percent sign is a share.
 */
export const textPrice = (text: string): PriceSignal | undefined => {
  AMOUNT.lastIndex = 0;
  for (let match = AMOUNT.exec(text); match; match = AMOUNT.exec(text)) {
    const amount = match[0];
    const start = match.index;
    const end = start + amount.length;
    if (amount.length > LONGEST_AMOUNT) continue;
    const next = text[end] === " " ? text[end + 1] : text[end];
    if (next === "%" || next === "\u066a" || next === "\uff05") continue;
    const spaced = text[start - 1] === " " ? start - 1 : start;
    const before = text[spaced - 1] === "." && isLetter(text[spaced - 2]) ? spaced - 1 : spaced;
    const prefix = markerBefore(text, before);
    if (
      prefix &&
      !AFTER_ONLY.has(prefix) &&
      !(oneLetter(prefix) && before !== spaced) &&
      counts(prefix, amount)
    )
      return { source: "text", price: text.slice(before - prefix.length, end) };
    const after = text[end] === " " ? end + 1 : end;
    const suffix = markerAfter(text, after);
    if (suffix && !oneLetter(suffix) && counts(suffix, amount))
      return { source: "text", price: text.slice(start, after + suffix.length) };
  }
  return undefined;
};

const stated = (
  source: PriceSignal["source"],
  amount: unknown,
  currency: unknown,
): PriceSignal | undefined => {
  const value =
    typeof amount === "number" && Number.isFinite(amount)
      ? String(amount)
      : typeof amount === "string"
        ? firstAmount(amount)
        : undefined;
  if (value === undefined) return undefined;
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  return { source, price: CODES.has(code) ? `${value} ${code}` : value };
};

const PRICE_KEYS = ["price", "lowPrice", "highPrice"];

/** A price an offer in the JSON-LD states, at any depth of its scripts' values. */
export const jsonLdPrice = (values: readonly unknown[]): PriceSignal | undefined => {
  const pending: unknown[] = [...values];
  for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    for (const key of PRICE_KEYS) {
      const found = stated("json-ld", record[key], record.priceCurrency);
      if (found) return found;
    }
    pending.push(...Object.values(record));
  }
  return undefined;
};

export const markedPrice = (
  source: "microdata" | "meta",
  marked: MarkedPrice,
): PriceSignal | undefined => stated(source, marked.amount, marked.currency);

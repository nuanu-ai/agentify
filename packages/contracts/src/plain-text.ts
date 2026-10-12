/**
 * Plain text: what the words on a card are written in.
 *
 * A card's title, its description and the title of each field it declares are
 * read by a buying program exactly as written, and nothing between the
 * merchant and the agent renders HTML. So text that reads as markup or as a
 * character reference is refused rather than cleaned: cleaning would make an
 * agent read words the merchant never wrote, and the merchant would never learn
 * that their source is broken.
 *
 * Only what reads as markup or a reference is refused, not text that merely
 * shares a character with it: `Tea & coffee`, `5 < 10`, `a -> b`, `AT&T`,
 * `R&D;`, `List< String >`, `<jane@example.com>`, `x<y` and
 * `Map<String, Integer>` all pass.
 */

/**
 * Whether a piece of text is one line, as a title is, or may run to several, as
 * a description may.
 */
export type TextLines = "one line" | "several lines";

/**
 * Markup: an HTML comment's opening, or a tag.
 *
 * A tag is an angle bracket, an optional slash, a name that begins with a
 * letter (joined by a colon or a hyphen, as in `<o:p>`), and the bracket's
 * close. A quoted attribute value may carry either bracket; where quotation
 * marks do not pair, the tag is read to the first closing bracket. A digit, a
 * space, an `@` or a `:/` after the bracket is not a name, so `<3`,
 * `List< String >` and `<https://example.com>` are not tags.
 *
 * The scan must stay linear in the length of the text: a quotation mark that
 * could be read two ways would make it exponential on short inputs, and the
 * tests hold it on both.
 */
const MARKUP =
  /<!--|<\/?[A-Za-z][A-Za-z0-9]*(?:[:-][A-Za-z0-9]+)*(?:(?:[\t\n\f\r /](?:[^<>"']|"[^"]*"|'[^']*')*)?>|[\t\n\f\r /][^<>]*>)/g;

/**
 * A character reference: an ampersand, a number or a name of at least two
 * characters, and a semicolon. `AT&T`, `A&B` and `R&D;` are text; `&eacute;`
 * and `&foo;` are both refused, whether or not HTML knows the name.
 */
const REFERENCE = /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);/g;

/**
 * Control characters: C0, DEL and C1. A description may carry a line feed,
 * U+000A, and nothing else from this range; a carriage return is refused there
 * too, because `\r\n` is a second spelling of the same break. A title is one
 * line and carries no line break at all.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const CONTROL_IN_ONE_LINE = /[\u0000-\u001F\u007F-\u009F]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const CONTROL_IN_LINES = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

/**
 * The names a merchant knows the commonest control characters by. A carriage
 * return in a description is nearly always half of a `\r\n` from a Windows
 * form, so the finding names the line feed a description does take.
 */
const CONTROL_NAMES: Readonly<Record<TextLines, Readonly<Record<string, string>>>> = {
  "one line": { "\t": "a tab", "\n": "a line break", "\r": "a carriage return" },
  "several lines": {
    "\t": "a tab",
    "\r": "a carriage return; a description breaks its lines with a line feed, U+000A, alone",
  },
};

/** The longest piece of the text quoted back in a finding; where one is cut, the finding says so. */
const QUOTED_AT_MOST = 40;

const codeOf = (character: string): string =>
  `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * DEL and C1, which `JSON.stringify` leaves as they are. Unescaped, a control
 * character inside a quoted tag would reach the merchant's terminal as itself,
 * and U+009B starts an escape sequence there.
 */
const UNESCAPED_BY_JSON = /[\u007F-\u009F]/g;

/**
 * A piece of the text as a finding quotes it: in quotation marks, with every
 * control character escaped, and cut where it is long. The cut never splits a
 * surrogate pair, which would quote half a character.
 */
const quoted = (fragment: string): string => {
  const whole = fragment.length <= QUOTED_AT_MOST;
  const head = whole ? fragment : fragment.slice(0, QUOTED_AT_MOST).replace(/[\uD800-\uDBFF]$/, "");
  const shown = JSON.stringify(head).replace(
    UNESCAPED_BY_JSON,
    (character) => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
  return whole ? shown : `${shown}… (cut short)`;
};

/** A control character as a finding names it: by its code, never printed. */
const namedIn =
  (lines: TextLines) =>
  (character: string): string => {
    const name = CONTROL_NAMES[lines][character];
    return name === undefined ? codeOf(character) : `${codeOf(character)} (${name})`;
  };

/**
 * One kind of thing that is not plain text, said once for all the places it
 * occurs: how many there are, and where the first of them is.
 *
 * The position counts from one in UTF-16 code units, the same units a
 * description's length is counted in, so an emoji counts as two and the number
 * can run ahead of what an editor shows.
 */
const found = (
  text: string,
  pattern: RegExp,
  one: string,
  many: string,
  shown: (fragment: string) => string,
): string | null => {
  const matches = [...text.matchAll(pattern)];
  const first = matches[0];
  if (first === undefined) return null;

  const where = `${shown(first[0])} at character ${first.index + 1}`;
  return matches.length === 1
    ? `${one}, ${where}`
    : `${many} in ${matches.length} places, the first ${where}`;
};

/**
 * What in this text is not plain text: one phrase for each kind found
 * (markup, character references, control characters), or an empty list when
 * all of it is plain.
 *
 * Each phrase says what was found, how often, and where the first is, as in
 * `HTML markup in 4 places, the first "<p>" at character 1`, and never prints
 * a control character. Pass `"one line"` for a title and `"several lines"` for
 * a description, which may carry line feeds.
 */
export const notPlainTextIn = (text: string, lines: TextLines): readonly string[] =>
  [
    found(text, MARKUP, "HTML markup", "HTML markup", quoted),
    found(text, REFERENCE, "an HTML character reference", "HTML character references", quoted),
    found(
      text,
      lines === "one line" ? CONTROL_IN_ONE_LINE : CONTROL_IN_LINES,
      "a control character",
      "control characters",
      namedIn(lines),
    ),
  ].filter((phrase): phrase is string => phrase !== null);

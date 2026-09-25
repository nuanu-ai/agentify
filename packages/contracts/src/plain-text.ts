/**
 * Plain text: what the words on a card are written in.
 *
 * A card's title, its description and the title of each field it declares are
 * read by a buying program exactly as they were written. Nothing between the
 * merchant and the agent renders HTML, so markup reaches the agent as markup —
 * `<p>Valid for twelve months.</p>` is read with its angle brackets, and
 * `Coffee &#038; Brunch` with its number — and a discovery catalog that does
 * render HTML would swallow some of it and show the rest. Either way the words
 * an agent acts on are not the words the merchant meant.
 *
 * The door refuses such text rather than cleaning it, and that choice is the
 * whole of this file. Cleaning would make an agent read text the merchant never
 * wrote: stripping a tag can join two sentences, decoding a reference is a
 * guess about which table it came from, and dropping an invisible character
 * changes a string somebody may be matching on. And the merchant would never
 * learn that their text was being rewritten, so the source stays broken for
 * every other place it goes. A refusal that names what it found and where is
 * the version of this a merchant can act on. A shop connector whose source is
 * HTML turns it into text on its own side, before the door, and asks this same
 * rule whether it succeeded.
 *
 * What is refused is what reads as markup or as a reference, and nothing that
 * merely shares a character with them. An ampersand between words, a
 * comparison and an arrow are text: `Tea & coffee`, `5 < 10`, `a -> b` and
 * `AT&T` all pass. So do an address in angle brackets, `<jane@example.com>`,
 * and a space after the bracket, `List< String >`, because an HTML parser reads
 * neither as a tag.
 *
 * The rule is the publish door's and not the reader's. A card stored before it
 * may carry anything it refuses, and every answer that carries a stored card is
 * held to its contract on the way out — so a rule applied on reading would turn
 * one old row into a failed catalog for every agent and a merchant who cannot
 * see the card they are meant to fix.
 */

/**
 * Whether a piece of text is one line, as a title is, or may run to several, as
 * a description may.
 */
export type TextLines = "one line" | "several lines";

/**
 * Markup: an HTML comment's opening, or a tag.
 *
 * A comment is refused on its opening alone, because nobody writing prose
 * writes `<!--`, and matching on to the close would cost a scan to the end of
 * the text for every opening in it.
 *
 * A tag is what an HTML parser reads as one: an angle bracket, an optional
 * slash, a name that begins with a letter, and then the bracket's close — at
 * once, after a slash, or after whitespace and whatever attributes follow. The
 * name may carry a colon or a hyphen between letters and digits, which is how
 * `<o:p>`, the tag a word processor leaves in pasted text, and a custom element
 * are written. What it does not take is the rest of what can follow a bracket:
 * a digit, a space, an `@` or a `:/`, which is why `<3`, `List< String >` and
 * `<https://example.com>` are text. The close has to be there, so `x<y` is text
 * as well.
 *
 * Every quantifier is bounded by the next angle bracket, so the scan is linear
 * in the length of the text however it is written.
 */
const MARKUP = /<!--|<\/?[A-Za-z][A-Za-z0-9]*(?:[:-][A-Za-z0-9]+)*(?:[\t\n\f\r /][^<>]*)?>/g;

/**
 * A character reference: an ampersand, a name or a number, and a semicolon.
 *
 * The semicolon is what separates a reference from an ampersand in prose —
 * `AT&T` and `A&B` are text. A name is refused whether or not HTML knows it,
 * because the only reader who would decode it is one that renders HTML, and
 * a name it does not know it shows as written.
 */
const REFERENCE = /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g;

/**
 * Control characters: C0, DEL and C1. A description may carry a line feed,
 * U+000A, and nothing else from this range.
 *
 * A line feed is the one line break every reader agrees on, and a description
 * is prose of up to five hundred characters that may run to paragraphs. A
 * carriage return is refused there with the rest, because `\r\n` is a second
 * spelling of the same break and a carriage return on its own sends a terminal
 * back to the start of the line it is printing. A title and a field's title are
 * one line, so they carry no line break at all. The rest of the range shows
 * nothing, and a character that shows nothing makes two strings that look
 * identical and are not.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const CONTROL_IN_ONE_LINE = /[\u0000-\u001F\u007F-\u009F]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const CONTROL_IN_LINES = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

/** The names a merchant knows the commonest control characters by. */
const CONTROL_NAMES: Readonly<Record<string, string>> = {
  "\t": "a tab",
  "\n": "a line break",
  "\r": "a carriage return",
};

/**
 * The longest piece of the text quoted back in a finding.
 *
 * A tag can carry an address of any length, and a finding is a line a person
 * reads; forty characters is enough to recognise the tag by. Where one is cut,
 * the finding says so.
 */
const QUOTED_AT_MOST = 40;

/** A piece of the text as a finding quotes it: in quotation marks, cut where it is long. */
const quoted = (fragment: string): string =>
  fragment.length <= QUOTED_AT_MOST
    ? JSON.stringify(fragment)
    : `${JSON.stringify(fragment.slice(0, QUOTED_AT_MOST))}… (cut short)`;

/** A control character as a finding names it: by its code, never printed. */
const named = (character: string): string => {
  const code = `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
  const name = CONTROL_NAMES[character];
  return name === undefined ? code : `${code} (${name})`;
};

/**
 * One kind of thing that is not plain text, said once for all the places it
 * occurs: how many there are, and the first of them, where it is.
 *
 * The position counts from one, in the same units a description's length is
 * counted in, so a merchant is sent to the character their editor would show.
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
 * What in this text is not plain text, one phrase for each kind of thing found
 * — markup, character references, control characters — and nothing when all of
 * it is.
 *
 * Each phrase says what was found, how often, and where the first of it is, as
 * in `HTML markup in 4 places, the first "<p>" at character 1`, and quotes
 * nothing it would have to print as a control character. It is the one
 * definition of plain text: the publish door refuses a card with it, and a
 * connector that turns a shop's HTML into text asks it whether it succeeded.
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
      named,
    ),
  ].filter((phrase): phrase is string => phrase !== null);

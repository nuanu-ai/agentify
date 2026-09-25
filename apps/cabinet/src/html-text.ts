/**
 * A shop's HTML as the plain text a card carries, for any connector whose
 * source writes its products in HTML.
 *
 * A card's words are plain text, and the publish door refuses markup,
 * character references and control characters rather than cleaning them
 * (`packages/contracts/src/plain-text.ts` says what counts and why). A shop is
 * the other way round: WooCommerce sends a product's name and prose as HTML,
 * with paragraphs in `<p>`, the editor's block comments, and punctuation that
 * wptexturize and convert_chars turned into numbered references. So the
 * connector does the reading the door will not do, on its own side, and hands
 * the door the text the shop's own page shows a person.
 *
 * It reads HTML the way a shop writes it, not every way a browser tolerates
 * it. WordPress writes a bracket in prose as `&lt;`, so a bare bracket in its
 * HTML is a tag. Where one is not — `<jane@example.com>` in hand-written HTML,
 * which a browser would read as an element and hide — it stays in the text,
 * and the door's rule decides what it is.
 *
 * What comes out is held to one promise: it passes the door's rule, or the
 * converter says what in it does not. The second case is real and it is not a
 * failure of reading. A shop page that shows `<header>` because the merchant
 * wrote `&lt;header&gt;`, or shows `&#038;` because they typed it, shows
 * exactly that to a person, and the card would say the same — so the connector
 * names the product and what it found rather than send a card the door will
 * refuse in words about markup the merchant never wrote as markup.
 *
 * Every step here is linear in the length of the page. The page comes from a
 * shop its merchant controls and this runs in the same process as the
 * gateway, so a pattern that backtracked on a crafted page would stall every
 * merchant's sales, not only one merchant's import. Each pattern below stops
 * at the next angle bracket, at the close of a quoted value, or at the end of
 * the page, and the tests hold it at a quarter of a megabyte.
 */

import { notPlainTextIn } from "@nuanu-ai/agentify-contracts";
import { decodeHTML } from "entities";

/**
 * The text of a piece of HTML, and whether it is plain text as the door means
 * it — with what is not, in the door's own words, when it is not.
 */
export type HtmlAsText =
  | { readonly plain: true; readonly text: string }
  | { readonly plain: false; readonly text: string; readonly found: readonly string[] };

/**
 * The elements a browser puts on a line of their own.
 *
 * Everything not on this list is inline and leaves no gap behind it. The list
 * is short because the mistake it prevents is one-directional: a block element
 * missing from it joins two sentences into one word, which a reader notices,
 * while an inline element wrongly on it leaves a space before a comma, which
 * nobody does.
 */
const BREAKS_THE_LINE = new Set([
  "p",
  "div",
  "br",
  "hr",
  "li",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "tr",
  "td",
  "th",
  "table",
  "thead",
  "tbody",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "section",
  "article",
  "header",
  "footer",
  "figure",
  "figcaption",
]);

/**
 * What follows a tag's name up to its closing bracket.
 *
 * Attributes with their quoted values paired first, because a value in
 * quotation marks may carry either bracket, as the alt text a block editor
 * writes into an image does. Where the tag cannot be read that way — a
 * quotation mark that opens no value, like the apostrophe in `alt=Mom's` —
 * everything up to the first closing bracket, so a stray mark never hides the
 * tag it sits in. One definition, used for every tag below, so a hidden block
 * and an ordinary tag cannot come to read their attributes differently.
 *
 * Linear however it is written: outside quotation marks both readings stop at
 * the next angle bracket, a quoted value stops at its own closing mark, and a
 * quotation mark is read one way only at any point in the first reading.
 */
const ATTRIBUTES = `(?:(?:[^<>"']|"[^"]*"|'[^']*')*|[^<>]*)>`;

/**
 * Everything in a page that is not its text, in the order a browser meets it.
 *
 * One pattern with four branches rather than four passes, because the order is
 * the meaning: a comment inside a script is script, and a tag inside a comment
 * is comment, and only a left-to-right reading of the page gets both right.
 *
 * The branches, in the order they are tried at each position:
 *
 * - A comment, `<!-- … -->`, including the ones a block editor puts around
 *   every block. One that is never closed runs to the end of the page, and
 *   `<!-->` and `<!--->` are empty comments, as they are in a browser.
 * - A `<script>`, `<style>` or `<template>` block, removed whole with its
 *   contents, which a browser does not show either. Stripping only the tags
 *   would put a stylesheet into the description of a product.
 * - A tag, with its name captured so a block element can leave a space behind.
 *   The name has to be followed by whitespace, a slash or the close, which is
 *   what keeps it from trading characters with the attributes after it.
 * - A declaration or a processing instruction, `<!DOCTYPE …>` and `<?xml …?>`,
 *   which a browser reads as a comment.
 *
 * A bracket that begins none of these — `5 < 10`, `x<y` — is text, and stays.
 */
const NOT_TEXT = new RegExp(
  [
    String.raw`<!--(?:-?>|[\s\S]*?(?:-->|$))`,
    String.raw`<(script|style|template)(?=[\s/>])${ATTRIBUTES}[\s\S]*?(?:<\/\1\s*>|$)`,
    String.raw`<\/?([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])${ATTRIBUTES}`,
    "<[!?][^<>]*>",
  ].join("|"),
  "gi",
);

/**
 * Characters that show nothing and are not space: C0 other than the
 * whitespace a browser collapses, DEL and C1.
 *
 * They reach the text as the shop wrote them, or decoded from a numbered
 * reference — `&#7;` is a bell, and `&#0;` would have been a NUL, which a
 * Postgres document cannot even hold, had HTML not already defined it as the
 * replacement character. A page shows none of them, so the text carries none.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const SHOWS_NOTHING = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g;

/**
 * A piece of a shop's HTML as the text its page shows, on one line.
 *
 * The markup goes first, then the references are read, and only then is the
 * text judged. In that order a tag the merchant wrote out as text,
 * `&lt;header&gt;`, becomes the text `<header>` rather than a tag to strip —
 * which is what the page shows. References are read the way a browser reads
 * them, against HTML's whole list of names and its rules for numbers, because
 * a name left undecoded is a reference the door refuses, and a product
 * refused for `&eacute;` would be refused for nothing the merchant could see
 * on their own page.
 *
 * Whitespace is collapsed, because a card's description is read by a program
 * and displayed in a catalogue, where the paragraphs of a shop page have
 * nowhere to go; what would otherwise cross is the newline the editor put
 * between two `<p>` elements, counted against the length limit as a character
 * the merchant cannot see. A non-breaking space collapses with the rest.
 */
export const plainTextOfHtml = (html: string): HtmlAsText => {
  const withoutMarkup = html.replace(
    NOT_TEXT,
    (_whole: string, hidden: string | undefined, tag: string | undefined) => {
      // A block the browser hides becomes a space, so that "a<style>…</style>b"
      // does not become one word. A tag that ends a line becomes a space and a
      // tag inside a line becomes nothing, because the two are not the same
      // edit: "code <em>by email</em>." with every tag spaced out reads "code by
      // email ." — a space before a full stop, in prose a stranger's agent is
      // about to read. A comment or a declaration is nothing.
      if (hidden !== undefined) return " ";
      if (tag !== undefined) return BREAKS_THE_LINE.has(tag.toLowerCase()) ? " " : "";
      return "";
    },
  );
  const text = decodeHTML(withoutMarkup).replace(SHOWS_NOTHING, "").replace(/\s+/g, " ").trim();

  const found = notPlainTextIn(text, "one line");
  return found.length === 0 ? { plain: true, text } : { plain: false, text, found };
};

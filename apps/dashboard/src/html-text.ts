/**
 * A shop's HTML as the plain text a card carries. The publish step refuses
 * markup, character references and control characters rather than cleaning them
 * (`packages/contracts/src/plain-text.ts` says what counts), while WooCommerce
 * sends names and prose as HTML with block comments and numbered references; so
 * the connector reads the HTML on its side and hands over the text the shop's
 * page shows a person. WordPress writes a bracket in prose as `&lt;`, so a bare
 * bracket is a tag; where it is not, it stays in the text and the contract's
 * rule decides.
 *
 * The result passes the contract's rule, or says what in it does not: a page
 * that shows `<header>` because the merchant typed `&lt;header&gt;` shows
 * exactly that, and the product is named rather than sent to be refused for
 * markup the merchant never wrote as markup.
 *
 * Every step is linear in the length of the page. The page comes from a shop
 * its merchant controls and this runs in the gateway's process, so a pattern
 * that backtracked on a crafted page would stall every merchant's sales. Each
 * pattern stops at the next angle bracket, the close of a quoted value, or the
 * end of the page, and the tests hold it at a quarter of a megabyte.
 */

import { notPlainTextIn } from "@nuanu-ai/agentify-contracts";
import { decodeHTML } from "entities";

/** With what is not plain, in the contract's own words, when it is not. */
export type HtmlAsText =
  | { readonly plain: true; readonly text: string }
  | { readonly plain: false; readonly text: string; readonly found: readonly string[] };

/**
 * Everything else is inline. A block element missing from this list joins two
 * sentences into one word, while an inline element wrongly on it only leaves a
 * space before a comma, so the list errs short.
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
 * Quoted values are paired first, because a quoted value may carry either
 * bracket (as image alt text does). Where that reading fails, as on the
 * apostrophe in `alt=Mom's`, everything up to the first closing bracket, so a
 * stray mark never hides its tag. Linear either way: outside quotes both
 * readings stop at the next angle bracket, and a quote is read one way only at
 * any point.
 */
const ATTRIBUTES = `(?:(?:[^<>"']|"[^"]*"|'[^']*')*|[^<>]*)>`;

/**
 * One pattern rather than four passes, because order is meaning: a comment
 * inside a script is script and a tag inside a comment is comment. Tried in
 * order at each position: a comment (an unclosed one runs to the end; `<!-->`
 * and `<!--->` are empty, as in a browser); a `<script>`, `<style>` or
 * `<template>` block, removed with its contents; a tag, its name captured so a
 * block element leaves a space, and followed by whitespace, a slash or the
 * close so it cannot trade characters with its attributes; a declaration or
 * processing instruction. A bracket that begins none of these (`5 < 10`) is
 * text.
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
 * Characters that show nothing and are not space: C0 other than collapsible
 * whitespace, DEL and C1. They arrive raw or decoded from a numbered reference,
 * and a page shows none of them.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const SHOWS_NOTHING = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g;

/**
 * Markup goes first, then references are decoded, then the text is judged, so
 * `&lt;header&gt;` becomes the text `<header>` as the page shows it. References
 * are decoded against HTML's whole list of names and its rules for numbers,
 * since an undecoded `&eacute;` would be refused for nothing the merchant can
 * see.
 *
 * Whitespace is collapsed, non-breaking space included: the newline between two
 * `<p>` elements would otherwise count against the length limit as a character
 * nobody can see.
 */
export const plainTextOfHtml = (html: string): HtmlAsText => {
  const withoutMarkup = html.replace(
    NOT_TEXT,
    (_whole: string, hidden: string | undefined, tag: string | undefined) => {
      // A hidden block becomes a space, so "a<style>…</style>b" stays two
      // words. A tag ending a line becomes a space and a tag inside a line
      // becomes nothing, or "code <em>by email</em>." would read "code by email
      // ." in prose an agent reads.
      if (hidden !== undefined) return " ";
      if (tag !== undefined) return BREAKS_THE_LINE.has(tag.toLowerCase()) ? " " : "";
      return "";
    },
  );
  const text = decodeHTML(withoutMarkup).replace(SHOWS_NOTHING, "").replace(/\s+/g, " ").trim();

  const found = notPlainTextIn(text, "one line");
  return found.length === 0 ? { plain: true, text } : { plain: false, text, found };
};

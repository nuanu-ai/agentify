/**
 * A page's text with the markup taken out, since the tests assert what a person
 * can see. Entities are decoded after tags are stripped, ampersand last:
 * decoded first, a literal `&lt;` would become a bracket and be stripped as
 * markup. A tag becomes a space so words do not fuse, except `<wbr>`, for which
 * a browser draws no space. A script goes out whole, source included.
 */
import { DRAWN_FOR } from "../html.js";

export const readable = (html: string): string =>
  html
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replaceAll(/<wbr\s*\/?>/gi, "")
    .replaceAll(/<[^>]*>/g, " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/g, " ")
    .trim();

export interface ServedButton {
  readonly tag: string;
  readonly label: string;
  readonly attributes: ReadonlyMap<string, string>;
}

/**
 * A page must never serve this button `disabled`: nothing can lift the
 * attribute where the script did not run, and the control asking for a new link
 * would be dead for somebody already locked out. Returns the attributes rather
 * than a verdict, so the test says what it asserts.
 */
export const waitingButton = (html: string): ServedButton => {
  const found = html.match(/<button([^>]*\bdata-link-wait="[^"]*"[^>]*)>([^<]*)<\/button>/);
  if (found === null) throw new Error("this page serves no button with a wait on it");
  const [tag = "", written = "", label = ""] = found;
  const attributes = new Map<string, string>();
  for (const [, name = "", value] of written.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
    attributes.set(name, value ?? "");
  }
  return { tag, label, attributes };
};

/**
 * Read apart from the rest of the page, because the missing-name banner and the
 * paragraph about connecting say words these tests look for; asked of the whole
 * page, a test would pass for an Import line that said neither.
 */
export const importFormOf = (html: string): string =>
  /<form[^>]*action="[^"]*\/woocommerce\/import"[^>]*>[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";

/**
 * A test's browser that posts without a page in front of it sends the mark of
 * the last page it was shown, as a real browser's form would.
 */
export const shownMarkIn = (html: string): string | undefined =>
  new RegExp(`name="${DRAWN_FOR}" value="([^"]*)"`).exec(html)?.[1];

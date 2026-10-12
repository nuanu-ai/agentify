/**
 * A page's text with the markup taken out, since the tests assert what a person
 * can see. Entities are decoded after tags are stripped, ampersand last:
 * decoded first, a literal `&lt;` would become a bracket and be stripped as
 * markup. A tag becomes a space so words do not fuse, except `<wbr>` and a
 * comment, for which a browser draws no space; React puts a comment between two
 * runs of text it drew separately. A script goes out whole, source included.
 */
import { DRAWN_FOR } from "../drawn-for.js";

export const readable = (html: string): string =>
  html
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replaceAll(/<!--[\s\S]*?-->/g, "")
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

export interface ServedForm {
  readonly method: string;
  readonly action: string;
  /** Each input that carries a name, with the value it was served with. */
  readonly fields: ReadonlyMap<string, string>;
}

/**
 * The forms on a page as a browser reads them, whatever order their attributes
 * are written in: a test about where a form posts and what it carries should
 * not break when the markup is drawn by another hand.
 */
export const formsIn = (html: string): ServedForm[] =>
  [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(([, written = "", inside = ""]) => {
    const attribute = (tag: string, name: string): string | undefined =>
      new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i").exec(tag)?.[1];
    const fields = new Map<string, string>();
    for (const [, input = ""] of inside.matchAll(/<input\b([^>]*)>/gi)) {
      const name = attribute(input, "name");
      if (name !== undefined) fields.set(name, attribute(input, "value") ?? "");
    }
    return {
      method: (attribute(written, "method") ?? "get").toLowerCase(),
      action: attribute(written, "action") ?? "",
      fields,
    };
  });

/** The one form on a page that sends this method to this address, if there is one. */
export const formTo = (html: string, method: string, action: string): ServedForm | undefined =>
  formsIn(html).find((form) => form.method === method && form.action === action);

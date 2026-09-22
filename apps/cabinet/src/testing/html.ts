/**
 * A page read the way a person reads it, with the markup taken out.
 *
 * The cabinet's tests are about what a merchant can see and do, not about
 * class names, so what they assert against is the text of the page rather than
 * its tags. This is how that text is got, and it lives here because two test
 * files wanted the same thing and each had written it out — two copies of one
 * decoding order, either of which could be corrected without the other.
 *
 * The order is the decision in it. Entities are decoded after the tags are
 * stripped, and the ampersand last of all: decoded first, a page carrying the
 * literal text `&lt;` would come out as a bracket, the bracket would be
 * stripped as if it were markup, and a test would report tags on a page that
 * has none.
 *
 * A tag becomes a space, so that two elements' words do not fuse into one that
 * nobody can read — with `<wbr>` the one exception, because it is defined as a
 * place a line may break and nothing else. A browser draws no space for it and
 * a reader copying the text gets none, so a space here would be this helper
 * disagreeing with every browser about what is on the page.
 *
 * A script goes out whole, element and source together, because a script's
 * source is not text anybody reads and this function's whole promise is the
 * text somebody reads. No test turns on it: every assertion about a page's
 * words happens to ask about words the one script on the cabinet's pages does
 * not contain. It is here so that the promise holds for the next question
 * asked, not because it is holding anything up today.
 */
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

/** A control as the browser was handed it: its attributes and its words. */
export interface ServedButton {
  readonly tag: string;
  readonly label: string;
  readonly attributes: ReadonlyMap<string, string>;
}

/**
 * The button on a page that carries a wait, exactly as it was served.
 *
 * What is being asked about it is almost always the same thing: whether the
 * HTML says `disabled`. It must not, on any of these pages, because nothing on
 * a page whose script did not run can lift that attribute — the one control
 * that asks for a new link would be dead in the browser of somebody who is
 * already locked out of their cabinet. The wait is an attribute for the same
 * reason: read by the script, ignored by everything else.
 *
 * Two test files ask, the one that renders the screen and the one that drives
 * the server, so the reading is written once. It returns the attributes rather
 * than an answer, so that a test says what it is asserting.
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

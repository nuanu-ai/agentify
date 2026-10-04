/**
 * Reading the text a scanned site writes, in time that grows with its length
 * and no faster.
 *
 * The checks once read HTML, JSON-LD, sitemaps and llms.txt with regular
 * expressions shaped like `<link\b[^>]*rel=…[^>]*hreflang=…`. A backtracking
 * engine retries such a pattern from every `<link` it meets, and when no `>`
 * follows, each retry walks the rest of the page. 20,000 bytes of unclosed
 * `<link rel="alternate" ` took seconds and the cost grew with the cube of
 * the size; the other expressions grew with its square, which at the 2 MiB of
 * a page and the 5 MiB of a sitemap the fetch admits comes to minutes or an
 * hour. The evaluation is synchronous, so while it ran the scan's deadline
 * timer could not fire and every other scan in the worker waited.
 *
 * What is read here is found with indexOf, from left to right. A reader looks
 * for an opening and then for what closes it. When nothing closes it, nothing
 * after it can be closed either, and the reader stops. When an opening leads
 * nowhere, the reader moves past the text that attempt covered instead of
 * retrying inside it. A regular expression is still used on site text where
 * its attempts cannot add up past the text's length: a fixed word; one
 * repeated character class followed by nothing the class could also match,
 * such as `\s+`; a pattern whose every attempt is a few characters long, as
 * the price pattern's is; or one whose attempt stops where the next attempt
 * would begin, as the Adyen pattern's does at the next `checkoutshopper-`.
 *
 * The readers find what those expressions found. One of their details is
 * kept on purpose: a quoted value the expressions read, such as an href, runs
 * to its closing quote even past a `>`. Pages do write that, in templates
 * such as `<a href='<#=item.url #>'>` on Amazon's home page.
 */

/**
 * The text with A to Z lowered and nothing else changed, so it keeps its
 * length and every index into it is an index into the text. A pattern with
 * the i flag and without the u flag matches an ASCII letter only against the
 * same ASCII letter in either case, so looking for a lower-case word in this
 * copy finds what that pattern found.
 */
export const asciiLower = (text: string): string =>
  text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

const isWordCode = (code: number): boolean =>
  (code >= 48 && code <= 57) ||
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code === 95;

export const isQuote = (code: number): boolean => code === 34 || code === 39;

/**
 * Where `<name` next begins at or after `from` as a whole tag name, which is
 * what `<name\b` matches, or -1. `lower` is the text through asciiLower.
 */
export const findTag = (lower: string, name: string, from: number): number => {
  const opening = `<${name}`;
  for (let at = lower.indexOf(opening, from); at !== -1; at = lower.indexOf(opening, at + 1))
    if (!isWordCode(lower.charCodeAt(at + opening.length))) return at;
  return -1;
};

/** Where the first " or ' at or after `from` is, or -1. */
export const nextQuote = (text: string, from: number): number => {
  for (let at = from; at < text.length; at += 1) if (isQuote(text.charCodeAt(at))) return at;
  return -1;
};

export type Span = { start: number; end: number };

/**
 * The next `<name` tag at or after `from`, as the span of what follows its
 * name up to its first `>`, or up to the end of the text when no `>` follows.
 */
export const nextTag = (lower: string, name: string, from: number): Span | undefined => {
  const open = findTag(lower, name, from);
  if (open === -1) return undefined;
  const start = open + name.length + 1;
  const close = lower.indexOf(">", start);
  return { start, end: close === -1 ? lower.length : close };
};

/**
 * Each value written right after `prefix` between quotes, where the prefix
 * and its opening quote lie within `within`, a span that ends at a `>` or at
 * the end of the text: a quote of either kind, and everything up to the next
 * quote of either kind wherever it is, as `["'][^"']*["']` reads it. A value
 * with no closing quote is left out. `at` is where the prefix begins; the
 * value is the span, the index of its closing quote being its end.
 *
 * A value ends at the first quote after its opening one, so the values of
 * different opening quotes never share a character, and no stretch of the
 * text is walked for two of them.
 */
export const quotedValues = (
  lower: string,
  prefix: string,
  within: Span,
): (Span & { at: number })[] => {
  const tag = lower.slice(within.start, within.end);
  const values: (Span & { at: number })[] = [];
  for (let found = tag.indexOf(prefix); found !== -1; found = tag.indexOf(prefix, found + 1)) {
    const quote = within.start + found + prefix.length;
    if (!isQuote(lower.charCodeAt(quote))) continue;
    const end = nextQuote(lower, quote + 1);
    if (end !== -1) values.push({ at: within.start + found, start: quote + 1, end });
  }
  return values;
};

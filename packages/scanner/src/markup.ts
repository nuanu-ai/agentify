/**
 * Readers of the text a scanned site writes, in time linear in its length.
 *
 * Evaluation is synchronous: while it runs, the scan's deadline timer cannot
 * fire and every other scan in the worker waits. A backtracking expression
 * such as `<link\b[^>]*rel=…` retries from every opening it meets, which on a
 * 2 MiB page of unclosed tags runs for minutes. So a reader walks the text
 * with indexOf, left to right, and stops when an opening finds no closer,
 * since nothing after it can close either. When an opening leads nowhere, the
 * reader resumes past the text that attempt covered instead of retrying inside
 * it: a reader that retried at the next character would be quadratic. A
 * regular expression is safe on
 * site text only where its attempts cannot add up past the text's length: a
 * fixed word, one repeated class followed by nothing the class could also
 * match, such as `\s+`, a pattern a few characters long, or one whose attempt
 * stops where the next would begin.
 *
 * A quoted value, such as an href, runs to its closing quote even past a `>`
 * on purpose: templates such as `<a href='<#=item.url #>'>` on Amazon's home
 * page write that.
 */

/**
 * The text with A to Z lowered and nothing else changed, so it keeps its
 * length and every index into it is an index into the text.
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
 * Each value written right after `prefix` between quotes, where the prefix and
 * its opening quote lie within `within`. A value runs from a quote of either
 * kind to the next quote of either kind, even past `within`; one with no
 * closing quote is left out. `at` is where the prefix begins. Values never
 * share a character, so no stretch of the text is walked twice.
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

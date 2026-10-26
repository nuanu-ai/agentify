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
 */

/**
 * The text with A to Z lowered and nothing else changed, so it keeps its
 * length and every index into it is an index into the text.
 */
export const asciiLower = (text: string): string =>
  text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

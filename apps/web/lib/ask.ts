/**
 * A question a page asks the site again and again, such as where a scan
 * stands, and what one answer says about asking it once more. A refusal in the
 * shape the site's own routes answer in decides by its `retryable`, and its
 * wait, where it names one, is the least the page waits. A refusal in no shape
 * the page knows decides by its status: a client error other than a timeout or
 * a rate limit is the same answer the next time, so asking ends. Everything
 * else, an answer that never arrived, a server's or a proxy's error, a success
 * the page cannot read, is worth asking again later.
 */

import { refusalIn } from "./api-answers";

export type Asked<Answer> =
  | Readonly<{ kind: "answered"; answer: Answer }>
  | Readonly<{ kind: "ended" }>
  | Readonly<{ kind: "later"; waitSeconds: number | null; words: string | null }>;

const WORTH_REPEATING = new Set([408, 425, 429]);

const later = { kind: "later", waitSeconds: null, words: null } as const;

/** Asks once and reads a success with `read`, which returns null for an answer the page cannot use. */
export async function ask<Answer>(
  url: string,
  init: RequestInit,
  read: (answer: unknown) => Answer | null,
): Promise<Asked<Answer>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    return later;
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const answer = read(body);
    return answer === null ? later : { kind: "answered", answer };
  }
  const refusal = refusalIn(body);
  if (refusal !== null) {
    return refusal.retryable
      ? { kind: "later", waitSeconds: refusal.retry_after_seconds ?? null, words: refusal.message }
      : { kind: "ended" };
  }
  const clientError = response.status >= 400 && response.status < 500;
  return clientError && !WORTH_REPEATING.has(response.status) ? { kind: "ended" } : later;
}

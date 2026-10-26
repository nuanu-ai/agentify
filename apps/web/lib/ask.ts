/**
 * A question a page asks the site again and again, such as where a scan
 * stands, and what one answer says about asking it once more. Only a refusal
 * in the shape the site's own routes answer in can end the asking, by its
 * `retryable`; where it names a wait, that is the least the page waits.
 * Anything else, an answer that never arrived, a refusal in no shape of the
 * site's (something in front of the site answered), a success the page cannot
 * read, says nothing about the scan, so the page asks again later.
 */

import { refusalIn } from "./api-answers";

export type Asked<Answer> =
  | Readonly<{ kind: "answered"; answer: Answer }>
  | Readonly<{ kind: "ended" }>
  | Readonly<{ kind: "later"; waitSeconds: number | null; words: string | null }>;

const later = { kind: "later", waitSeconds: null, words: null } as const;

/**
 * Seconds to wait after `failures` answers in a row asked the page to come
 * back later: doubling from two to half a minute, and never less than the
 * wait the answer named.
 */
export const waitAfter = (failures: number, named: number | null = null) =>
  Math.max(named ?? 0, Math.min(2 * 2 ** (failures - 1), 30));

/**
 * Asks once and reads a success with `read`, which is handed the body (null
 * where there is none or it is not JSON) and the status, and returns null for
 * an answer the page cannot use.
 */
export async function ask<Answer>(
  url: string,
  init: RequestInit,
  read: (answer: unknown, status: number) => Answer | null,
): Promise<Asked<Answer>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    return later;
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const answer = read(body, response.status);
    return answer === null ? later : { kind: "answered", answer };
  }
  const refusal = refusalIn(body);
  if (refusal === null) return later;
  return refusal.retryable
    ? { kind: "later", waitSeconds: refusal.retry_after_seconds ?? null, words: refusal.message }
    : { kind: "ended" };
}

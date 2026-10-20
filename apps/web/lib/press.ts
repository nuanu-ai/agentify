/**
 * A press that asks the site to change something, and what the page can tell
 * of its outcome. Only a refusal in the shape the site's own routes answer in
 * says the press was refused, in the route's words. An answer that never
 * arrived, or one the page cannot read (a reply cut off, a proxy's error
 * page), is "unknown": the site may have done what was asked before the answer
 * was lost, so the page must not say it was not done.
 */

import type { ApiErrorEnvelope } from "@agentify/scanner-contracts";

import { refusalIn } from "./api-answers";

export type PressOutcome<Answer> =
  | Readonly<{ kind: "done"; answer: Answer }>
  | Readonly<{ kind: "refused"; refusal: ApiErrorEnvelope["error"] }>
  | Readonly<{ kind: "unknown" }>;

/**
 * Sends the press and reads its answer with `read`, which returns null for a
 * success answer the page cannot use; that counts as unknown too.
 */
export async function press<Answer>(
  url: string,
  init: RequestInit,
  read: (answer: unknown) => Answer | null,
): Promise<PressOutcome<Answer>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    return { kind: "unknown" };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const answer = read(body);
    return answer === null ? { kind: "unknown" } : { kind: "done", answer };
  }
  const refusal = refusalIn(body);
  return refusal === null ? { kind: "unknown" } : { kind: "refused", refusal };
}

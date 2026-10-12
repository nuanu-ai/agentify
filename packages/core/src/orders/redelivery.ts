/**
 * Whether an undelivered order gets another delivery, and after how long.
 *
 * A handler answers with a fulfillment, a refusal or an acceptance. Anything
 * else (an exception, a dead process, a broken connection) is no answer, and
 * the order is delivered again. A temporary failure must therefore be thrown
 * rather than refused: a refusal is final and closes the order.
 *
 * Delivery stops when the policy's attempts are spent or, sooner, when the next
 * attempt would land past the mode's deadline, since the worker never starts
 * the handler after it. There is no jitter and no clock, so the same numbers
 * always replay to the same decision.
 *
 * The attempt count is published to merchants as the gateway's setting; the
 * pauses between attempts are not, and nobody sizes anything against them.
 */

import type { RedeliveryPolicy } from "./model.js";

export type RedeliveryDecision =
  | { readonly retry: true; readonly attempt: number; readonly delayMs: number }
  | { readonly retry: false; readonly reason: "attempts_exhausted" | "past_deadline" };

export type RedeliveryQuestion = {
  /** How many deliveries have been made so far. */
  readonly attempts: number;
  readonly now: number;
  /** When the mode's own deadline runs out, or null when none is running. */
  readonly deadlineAt: number | null;
  readonly policy: RedeliveryPolicy;
};

export function nextRedelivery(question: RedeliveryQuestion): RedeliveryDecision {
  const { attempts, now, deadlineAt, policy } = question;

  if (attempts >= policy.maxAttempts) {
    return { retry: false, reason: "attempts_exhausted" };
  }

  const growth = policy.baseDelayMs * policy.factor ** Math.max(attempts - 1, 0);
  const delayMs = Math.min(growth, policy.maxDelayMs);

  if (deadlineAt !== null && now + delayMs >= deadlineAt) {
    return { retry: false, reason: "past_deadline" };
  }

  return { retry: true, attempt: attempts + 1, delayMs };
}

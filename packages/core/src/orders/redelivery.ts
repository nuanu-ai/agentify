/**
 * Whether an undelivered order gets another delivery, and after how long.
 *
 * A handler answers with a fulfillment, a refusal or an acceptance. Anything
 * else (an exception, a dead process, a broken connection) is no answer, and
 * the order is delivered again. A temporary failure must therefore be thrown
 * rather than refused: a refusal is final and closes the order.
 *
 * The pauses grow from the policy's first one to its ceiling. Delivery stops
 * when the next attempt would land past the policy's window, counted from the
 * order's first hand-over, or, sooner, past the mode's deadline, since the
 * worker never starts the handler after it. There is no jitter and no clock,
 * so the same numbers always replay to the same decision.
 */

import type { RedeliveryPolicy } from "./model.js";

export type RedeliveryDecision =
  | { readonly retry: true; readonly attempt: number; readonly delayMs: number }
  | { readonly retry: false; readonly reason: "past_window" | "past_deadline" };

export type RedeliveryQuestion = {
  /** How many deliveries have been made so far. */
  readonly attempts: number;
  readonly now: number;
  /** When the order first reached its merchant, or null where no hand-over is recorded yet. */
  readonly firstHandedOverAt: number | null;
  /** When the mode's own deadline runs out, or null when none is running. */
  readonly deadlineAt: number | null;
  readonly policy: RedeliveryPolicy;
};

export function nextRedelivery(question: RedeliveryQuestion): RedeliveryDecision {
  const { attempts, now, firstHandedOverAt, deadlineAt, policy } = question;

  const growth = policy.baseDelayMs * policy.factor ** Math.max(attempts - 1, 0);
  const delayMs = Math.min(growth, policy.maxDelayMs);

  if (deadlineAt !== null && now + delayMs >= deadlineAt) {
    return { retry: false, reason: "past_deadline" };
  }
  if (now + delayMs >= (firstHandedOverAt ?? now) + policy.windowMs) {
    return { retry: false, reason: "past_window" };
  }

  return { retry: true, attempt: attempts + 1, delayMs };
}

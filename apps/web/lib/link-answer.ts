/**
 * The browser's side of a refused verification link.
 *
 * The form used to count sixty seconds of its own and print its own sentence
 * about "too many requests", neither of which came from what the server
 * answered; a person who had asked once read that they had asked too often.
 * The wait and the words both live in the answer now, and this file only
 * reads them out. An answer with no wait in it leaves the button working —
 * the screen does not fill the gap with a number of its own.
 */

import { apiErrorEnvelopeSchema } from "@agentify/scanner-contracts";

export const LINK_ANSWER_FALLBACK = "Verification email is temporarily unavailable. Please retry.";

export function linkAnswerFailure(payload: unknown): Readonly<{
  message: string;
  waitSeconds: number;
}> {
  const parsed = apiErrorEnvelopeSchema.safeParse(payload);
  if (!parsed.success) return { message: LINK_ANSWER_FALLBACK, waitSeconds: 0 };
  return {
    message: parsed.data.error.message,
    waitSeconds: parsed.data.error.retry_after_seconds ?? 0,
  };
}

/** The remaining wait on a button, in the unit a person reads at a glance. */
export function waitLabel(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)}m`;
}

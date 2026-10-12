/**
 * The browser's side of a refused verification link: the wait and the words
 * come from the server's answer, never from the form. An answer with no wait
 * leaves the button working rather than showing a number of its own.
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

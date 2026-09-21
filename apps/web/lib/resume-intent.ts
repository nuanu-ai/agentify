export type ResumeIntent = "copy-prompt" | "download-md";

const RESUME_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

export function resumeIntentKey(scanId: string) {
  return `agentify:resume-intent:${scanId}`;
}

export function serializeResumeIntent(intent: ResumeIntent, now: number) {
  return JSON.stringify({ intent, expires_at: now + RESUME_INTENT_TTL_MS });
}

export function parseResumeIntent(
  raw: string | null,
  now: number,
): ResumeIntent | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as {
      intent?: unknown;
      expires_at?: unknown;
    };
    if (
      (value.intent === "copy-prompt" || value.intent === "download-md") &&
      typeof value.expires_at === "number" &&
      value.expires_at > now
    )
      return value.intent;
  } catch {
    return null;
  }
  return null;
}

export function rememberResumeIntent(scanId: string, intent: ResumeIntent) {
  try {
    window.localStorage.setItem(
      resumeIntentKey(scanId),
      serializeResumeIntent(intent, Date.now()),
    );
  } catch {
    return;
  }
}

export function takeResumeIntent(scanId: string): ResumeIntent | null {
  try {
    const key = resumeIntentKey(scanId);
    const intent = parseResumeIntent(
      window.localStorage.getItem(key),
      Date.now(),
    );
    window.localStorage.removeItem(key);
    return intent;
  } catch {
    return null;
  }
}

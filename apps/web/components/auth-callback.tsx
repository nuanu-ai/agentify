"use client";

import { authFinalizeResponseSchema } from "@agentify/scanner-contracts";
import { useRouter } from "next/navigation";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { linkAnswerFailure, waitLabel } from "../lib/link-answer";
import styles from "./auth-callback.module.css";
import { Brand } from "./brand";
import { TURNSTILE_TOKEN_EVENT, TurnstileChallenge } from "./turnstile-challenge";

type CallbackState =
  | "loading"
  | "ready"
  | "verifying"
  | "recovery"
  | "recovery-sending"
  | "recovery-sent"
  | "recovery-unavailable"
  | "error"
  | "unavailable";

type SessionLookupFallback = "ready" | "recovery";
type CapturedEntry =
  | Readonly<{ kind: "link"; state: string; token: string }>
  | Readonly<{ kind: "recovery"; state?: string }>
  | Readonly<{ kind: "error" }>;

export function sessionLookupResult(
  payload: unknown,
  fallback: SessionLookupFallback,
): Readonly<{ reportUrl: string }> | Readonly<{ state: SessionLookupFallback }> {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "report_url" in payload &&
    typeof payload.report_url === "string" &&
    /^\/report\/[0-9a-f-]+$/i.test(payload.report_url)
  ) {
    return { reportUrl: payload.report_url };
  }
  return { state: fallback };
}

export function AuthCallback({ turnstileSiteKey }: Readonly<{ turnstileSiteKey: string | null }>) {
  const router = useRouter();
  const [state, setState] = useState<CallbackState>("loading");
  const [link, setLink] = useState<{ state: string; token: string }>();
  const [recoveryState, setRecoveryState] = useState<string>();
  // What the door answered when it refused, and the wait it named. The screen
  // repeats the words and holds the button for the seconds, so that pressing
  // it again cannot spend an hour's links on refusals. Both belong to the
  // address that was asked about: typing another one drops them.
  const [recoveryNotice, setRecoveryNotice] = useState<string>();
  const [recoveryWait, setRecoveryWait] = useState(0);
  const [email, setEmail] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const capturedEntry = useRef<CapturedEntry | undefined>(undefined);
  const sessionLookup = useRef<AbortController | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: this runs once, on mount: it reads the callback token out of the URL and replaces the history entry, and a second run would find nothing there
  useEffect(() => {
    const capture = (reuseCaptured: boolean) => {
      sessionLookup.current?.abort();
      setState("loading");
      let entry = reuseCaptured ? capturedEntry.current : undefined;
      if (!entry) {
        const fragment = new URLSearchParams(window.location.hash.slice(1));
        const query = new URLSearchParams(window.location.search);
        const callbackState = fragment.get("state");
        const token = fragment.get("token");
        const legacyState = query.get("state");
        const recoveryRequested = query.get("recover") === "1";
        entry =
          callbackState && token
            ? { kind: "link", state: callbackState, token }
            : (legacyState && /^[A-Za-z0-9_-]{43}$/.test(legacyState)) || recoveryRequested
              ? { kind: "recovery", state: legacyState ?? undefined }
              : { kind: "error" };
        capturedEntry.current = entry;
        window.history.replaceState({}, "", "/auth/callback");
      }
      if (entry.kind === "link") {
        setLink({ state: entry.state, token: entry.token });
        startSessionLookup(entry.state, "ready");
        return;
      }
      if (entry.kind === "recovery") {
        setRecoveryState(entry.state);
        startSessionLookup(entry.state, "recovery");
        return;
      }
      setLink(undefined);
      setState("error");
    };
    capture(true);
    const recapture = () => {
      capturedEntry.current = undefined;
      capture(false);
    };
    window.addEventListener("hashchange", recapture);
    return () => {
      sessionLookup.current?.abort();
      window.removeEventListener("hashchange", recapture);
    };
  }, []);

  useEffect(() => {
    if (recoveryWait <= 0) return;
    const timer = window.setTimeout(
      () => setRecoveryWait((value) => Math.max(0, value - 1)),
      1_000,
    );
    return () => window.clearTimeout(timer);
  }, [recoveryWait]);

  useEffect(() => {
    const receive = (event: Event) => {
      const token = (event as CustomEvent<unknown>).detail;
      setTurnstileToken(typeof token === "string" ? token : null);
    };
    window.addEventListener(TURNSTILE_TOKEN_EVENT, receive);
    return () => window.removeEventListener(TURNSTILE_TOKEN_EVENT, receive);
  }, []);

  function startSessionLookup(stateHint: string | undefined, fallback: SessionLookupFallback) {
    sessionLookup.current?.abort();
    const controller = new AbortController();
    sessionLookup.current = controller;
    void checkExistingSession(stateHint, fallback, controller.signal);
  }

  async function checkExistingSession(
    stateHint: string | undefined,
    fallback: SessionLookupFallback,
    signal: AbortSignal,
  ) {
    try {
      const response = await fetch("/api/v2/auth/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "session",
          ...(stateHint ? { state: stateHint } : {}),
        }),
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      if (signal.aborted) return;
      if (response.ok && response.status === 200) {
        const payload: unknown = await response.json();
        if (signal.aborted) return;
        const result = sessionLookupResult(payload, fallback);
        if ("reportUrl" in result) {
          window.location.replace(result.reportUrl);
          return;
        }
      }
    } catch {
      if (signal.aborted) return;
      // The email recovery form remains available when session lookup fails.
    }
    if (signal.aborted) return;
    setState(fallback);
  }

  async function confirm() {
    if (!link || (state !== "ready" && state !== "unavailable")) return;
    setState("verifying");
    try {
      const response = await fetch("/api/v2/auth/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(link),
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status >= 500) {
        setState("unavailable");
        return;
      }
      if (!response.ok) {
        if (response.status === 401) {
          setRecoveryState(undefined);
          setState("loading");
          startSessionLookup(link.state, "recovery");
          return;
        }
        setLink(undefined);
        setState("error");
        return;
      }
      const payload = authFinalizeResponseSchema.safeParse(await response.json());
      if (!payload.success) throw new Error("verification_unavailable");
      router.replace(payload.data.report_url);
    } catch {
      setState("unavailable");
    }
  }

  async function requestRecovery(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      (state !== "recovery" && state !== "recovery-unavailable") ||
      !email ||
      recoveryWait > 0 ||
      (turnstileSiteKey && !turnstileToken)
    )
      return;
    setRecoveryNotice(undefined);
    setRecoveryWait(0);
    setState("recovery-sending");
    try {
      const response = await fetch("/api/v2/auth/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "email",
          email,
          ...(recoveryState ? { state: recoveryState } : {}),
          turnstile_token: turnstileToken,
        }),
        credentials: "same-origin",
        cache: "no-store",
      });
      setTurnstileToken(null);
      if (response.ok) {
        setState("recovery-sent");
        return;
      }
      if (response.status >= 500) {
        setState("recovery-unavailable");
        return;
      }
      const failure = linkAnswerFailure(await response.json().catch(() => null));
      setRecoveryNotice(failure.message);
      setRecoveryWait(failure.waitSeconds);
      setState("recovery");
    } catch {
      setTurnstileToken(null);
      setState("recovery-unavailable");
    }
  }

  return (
    <main className={styles.page}>
      <Brand />
      <section aria-live="polite" className={styles.card}>
        {state === "loading" ? (
          <>
            <span aria-hidden="true" className={styles.spinner} />
            <h1>Checking report access…</h1>
          </>
        ) : state === "ready" || state === "unavailable" ? (
          <>
            <h1>
              {state === "ready" ? "Confirm your email" : "Verification is temporarily unavailable"}
            </h1>
            <p>
              {state === "ready"
                ? "Confirm to open your private report."
                : "Try again. If the link has already been used, request a fresh link for your saved report."}
            </p>
            <button
              className="button button-primary"
              type="button"
              onClick={() => void confirm()}
              disabled={!link}
            >
              {state === "ready" ? "Open my report" : "Try again"}
            </button>
          </>
        ) : state === "verifying" || state === "recovery-sending" ? (
          <>
            <span aria-hidden="true" className={styles.spinner} />
            <h1>{state === "verifying" ? "Confirming your email…" : "Requesting a fresh link…"}</h1>
            <p>
              {state === "verifying"
                ? "We are opening your private report."
                : "This may take a moment."}
            </p>
          </>
        ) : state === "recovery" || state === "recovery-unavailable" ? (
          <>
            <h1>Recover your private report</h1>
            {state === "recovery-unavailable" ? (
              <p role="alert">
                Email delivery is temporarily unavailable. Complete a fresh challenge and try again
                shortly.
              </p>
            ) : recoveryNotice ? (
              <p role="alert">{recoveryNotice}</p>
            ) : null}
            <p>
              Enter the email used for the report. If it matches a saved report, we’ll send a fresh
              verification link.
            </p>
            <form className={styles.form} onSubmit={requestRecovery}>
              <label htmlFor="report-recovery-email">Email</label>
              <input
                autoComplete="email"
                id="report-recovery-email"
                name="email"
                onChange={(event) => {
                  setEmail(event.target.value);
                  setRecoveryNotice(undefined);
                  setRecoveryWait(0);
                }}
                required
                type="email"
                value={email}
              />
              {turnstileSiteKey ? (
                <TurnstileChallenge action="report_recovery" siteKey={turnstileSiteKey} />
              ) : null}
              <button
                className="button button-primary"
                disabled={recoveryWait > 0 || Boolean(turnstileSiteKey && !turnstileToken)}
                type="submit"
              >
                {recoveryWait > 0
                  ? `Try again in ${waitLabel(recoveryWait)}`
                  : "Send verification link"}
              </button>
            </form>
          </>
        ) : state === "recovery-sent" ? (
          <>
            <h1>Check your email</h1>
            <p>
              If this email has a saved report, a fresh verification link is on its way. The link
              expires in one hour.
            </p>
          </>
        ) : (
          <>
            <h1>This verification link cannot be used</h1>
            <p>
              It may have expired or already been used. Request a fresh link for your saved report.
            </p>
            <a className="button button-primary" href="/auth/callback?recover=1">
              Recover a saved report
            </a>
          </>
        )}
      </section>
    </main>
  );
}

"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { authFinalizeResponseSchema } from "@agentify/scanner-contracts";
import {
  clearReportCabinetHandoff,
  rememberReportCabinetHandoff,
} from "../lib/client/report-cabinet-handoff";
import { Brand } from "./brand";
import {
  TURNSTILE_TOKEN_EVENT,
  TurnstileChallenge,
} from "./turnstile-challenge";
import styles from "./auth-callback.module.css";

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

export function AuthCallback({
  turnstileSiteKey,
}: Readonly<{ turnstileSiteKey: string | null }>) {
  const router = useRouter();
  const [state, setState] = useState<CallbackState>("loading");
  const [link, setLink] = useState<{ state: string; token: string }>();
  const [recoveryState, setRecoveryState] = useState<string>();
  const [email, setEmail] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    const capture = () => {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const query = new URLSearchParams(window.location.search);
      const callbackState = fragment.get("state");
      const token = fragment.get("token");
      const legacyState = query.get("state");
      const recoveryRequested = query.get("recover") === "1";
      window.history.replaceState({}, "", "/auth/callback");
      if (callbackState && token) {
        setLink({ state: callbackState, token });
        setState("ready");
        return;
      }
      if (
        (legacyState && /^[A-Za-z0-9_-]{43}$/.test(legacyState)) ||
        recoveryRequested
      ) {
        const stateHint = legacyState ?? undefined;
        setRecoveryState(stateHint);
        void checkExistingSession(stateHint);
        return;
      }
      setLink(undefined);
      setState("error");
    };
    if (!initialized.current) {
      initialized.current = true;
      capture();
    }
    window.addEventListener("hashchange", capture);
    return () => window.removeEventListener("hashchange", capture);
  }, []);

  useEffect(() => {
    const receive = (event: Event) => {
      const token = (event as CustomEvent<unknown>).detail;
      setTurnstileToken(typeof token === "string" ? token : null);
    };
    window.addEventListener(TURNSTILE_TOKEN_EVENT, receive);
    return () => window.removeEventListener(TURNSTILE_TOKEN_EVENT, receive);
  }, []);

  async function checkExistingSession(stateHint?: string) {
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
      });
      if (response.ok && response.status === 200) {
        const payload: unknown = await response.json();
        if (
          typeof payload === "object" &&
          payload !== null &&
          "report_url" in payload &&
          typeof payload.report_url === "string" &&
          payload.report_url.startsWith("/report/")
        ) {
          window.location.replace(payload.report_url);
          return;
        }
      }
    } catch {
      // The email recovery form remains available when session lookup fails.
    }
    setState("recovery");
  }

  async function confirm() {
    if (!link || (state !== "ready" && state !== "unavailable")) return;
    clearReportCabinetHandoff();
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
          setRecoveryState(link.state);
          await checkExistingSession(link.state);
          return;
        }
        setLink(undefined);
        setState("error");
        return;
      }
      const payload = authFinalizeResponseSchema.safeParse(
        await response.json(),
      );
      if (!payload.success) throw new Error("verification_unavailable");
      if (
        payload.data.cabinet_action_url &&
        !rememberReportCabinetHandoff(
          payload.data.report_url,
          payload.data.cabinet_action_url,
          window.location.origin,
        )
      ) {
        clearReportCabinetHandoff();
      }
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
      (turnstileSiteKey && !turnstileToken)
    )
      return;
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
      setState(
        response.ok
          ? "recovery-sent"
          : response.status >= 500
            ? "recovery-unavailable"
            : "recovery",
      );
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
              {state === "ready"
                ? "Confirm your email"
                : "Verification is temporarily unavailable"}
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
            <h1>
              {state === "verifying"
                ? "Confirming your email…"
                : "Requesting a fresh link…"}
            </h1>
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
                Email delivery is temporarily unavailable. Complete a fresh
                challenge and try again shortly.
              </p>
            ) : null}
            <p>
              Enter the email used for the report. If it matches a saved report,
              we’ll send a fresh verification link.
            </p>
            <form className={styles.form} onSubmit={requestRecovery}>
              <label htmlFor="report-recovery-email">Email</label>
              <input
                autoComplete="email"
                id="report-recovery-email"
                name="email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
              {turnstileSiteKey ? (
                <TurnstileChallenge
                  action="report_recovery"
                  siteKey={turnstileSiteKey}
                />
              ) : null}
              <button
                className="button button-primary"
                disabled={Boolean(turnstileSiteKey && !turnstileToken)}
                type="submit"
              >
                Send verification link
              </button>
            </form>
          </>
        ) : state === "recovery-sent" ? (
          <>
            <h1>Check your email</h1>
            <p>
              If this email has a saved report, a fresh verification link is on
              its way. The link expires in one hour.
            </p>
          </>
        ) : (
          <>
            <h1>This verification link cannot be used</h1>
            <p>
              It may have expired or already been used. Request a fresh link for
              your saved report.
            </p>
            <a
              className="button button-primary"
              href="/auth/callback?recover=1"
            >
              Recover a saved report
            </a>
          </>
        )}
      </section>
    </main>
  );
}

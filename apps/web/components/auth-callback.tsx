"use client";

import React, { useEffect, useRef, useState } from "react";

import { authFinalizeResponseSchema } from "@agentify/scanner-contracts";
import { Brand } from "./brand";
import styles from "./auth-callback.module.css";

type CallbackState = "ready" | "verifying" | "error" | "unavailable";

export function AuthCallback() {
  const [state, setState] = useState<CallbackState>("ready");
  const [link, setLink] = useState<{ state: string; token: string }>();
  const initialized = useRef(false);

  useEffect(() => {
    const capture = () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const callbackState = params.get("state");
      const token = params.get("token");
      window.history.replaceState({}, "", "/auth/callback");
      if (!callbackState || !token) {
        setLink(undefined);
        setState("error");
      } else {
        setLink({ state: callbackState, token });
        setState("ready");
      }
    };
    if (!initialized.current) {
      initialized.current = true;
      capture();
    }
    window.addEventListener("hashchange", capture);
    return () => window.removeEventListener("hashchange", capture);
  }, []);

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
        setLink(undefined);
        setState("error");
        return;
      }
      const payload = authFinalizeResponseSchema.safeParse(
        await response.json(),
      );
      if (!payload.success) throw new Error("verification_unavailable");
      window.location.replace(payload.data.report_url);
    } catch {
      setState("unavailable");
    }
  }

  return (
    <main className={styles.page}>
      <Brand />
      <section aria-live="polite" className={styles.card}>
        {state === "ready" || state === "unavailable" ? (
          <>
            <h1>
              {state === "ready"
                ? "Confirm your email"
                : "Verification is temporarily unavailable"}
            </h1>
            <p>
              {state === "ready"
                ? "Confirm to open your private report."
                : "Try again. If the link has already been used, return to your scan and request a new one."}
            </p>
            <button
              className="button button-primary"
              type="button"
              onClick={() => void confirm()}
              disabled={!link}
            >
              {state === "ready" ? "Confirm email" : "Try again"}
            </button>
          </>
        ) : state === "verifying" ? (
          <>
            <span aria-hidden="true" className={styles.spinner} />
            <h1>Confirming your email…</h1>
            <p>We are opening your private report.</p>
          </>
        ) : (
          <>
            <h1>This verification link cannot be used</h1>
            <p>
              It may have expired or already been used. Return to the original
              scan and request a new link.
            </p>
            <a className="button button-primary" href="/owner">
              Start a new scan
            </a>
          </>
        )}
      </section>
    </main>
  );
}

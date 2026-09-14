"use client";

import React, { useEffect, useState } from "react";

import { finalizeAuthCallbackSession } from "../lib/auth-callback-flow";
import { createSupabaseBrowserClient } from "../lib/supabase-browser";
import { Brand } from "./brand";
import styles from "./auth-callback.module.css";

type CallbackState = "verifying" | "error";

export function AuthCallback() {
  const [state, setState] = useState<CallbackState>("verifying");

  useEffect(() => {
    let active = true;
    const finalize = async () => {
      try {
        const callbackState = new URLSearchParams(window.location.search).get(
          "state",
        );
        if (!callbackState) throw new Error("callback_state_missing");
        const supabase = createSupabaseBrowserClient();
        const reportUrl = await finalizeAuthCallbackSession({
          callbackState,
          client: supabase,
        });
        window.history.replaceState({}, "", "/auth/callback");
        window.location.replace(reportUrl);
      } catch {
        window.history.replaceState({}, "", "/auth/callback");
        if (active) setState("error");
      }
    };
    void finalize();
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className={styles.page}>
      <Brand />
      <section aria-live="polite" className={styles.card}>
        {state === "verifying" ? (
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

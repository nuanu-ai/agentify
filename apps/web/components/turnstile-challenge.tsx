"use client";

import { useEffect, useRef } from "react";
import type { TurnstileAction } from "../lib/server/turnstile";
import styles from "./turnstile-challenge.module.css";

export const TURNSTILE_TOKEN_EVENT = "agentify:turnstile-token";

export function TurnstileChallenge({
  siteKey,
  action,
}: Readonly<{ siteKey: string | null; action: TurnstileAction }>) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;
    const callbackName = `agentifyTurnstile_${crypto.randomUUID().replaceAll("-", "")}`;
    const windowRecord = window as unknown as Record<string, unknown>;
    windowRecord[callbackName] = (token: string) => {
      window.dispatchEvent(new CustomEvent(TURNSTILE_TOKEN_EVENT, { detail: token }));
    };
    containerRef.current.dataset.sitekey = siteKey;
    containerRef.current.dataset.callback = callbackName;
    containerRef.current.dataset.action = action;
    containerRef.current.dataset.retry = "auto";
    containerRef.current.dataset.refreshExpired = "auto";
    containerRef.current.className = "cf-turnstile";
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
    return () => {
      delete windowRecord[callbackName];
      script.remove();
    };
  }, [action, siteKey]);

  return (
    <div className={styles.challenge}>
      {siteKey ? (
        <div data-sitekey={siteKey} ref={containerRef} />
      ) : (
        <p>Challenge is not configured in this environment. Retry from a configured deployment.</p>
      )}
    </div>
  );
}

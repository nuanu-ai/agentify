"use client";

import React, { useEffect, useRef } from "react";

import styles from "./turnstile-challenge.module.css";

export const TURNSTILE_TOKEN_EVENT = "b2a:turnstile-token";

export function TurnstileChallenge({
  siteKey,
}: Readonly<{ siteKey: string | null }>) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;
    const callbackName = `b2aTurnstile_${crypto.randomUUID().replaceAll("-", "")}`;
    const windowRecord = window as unknown as Record<string, unknown>;
    windowRecord[callbackName] = (token: string) => {
      window.dispatchEvent(
        new CustomEvent(TURNSTILE_TOKEN_EVENT, { detail: token }),
      );
    };
    containerRef.current.dataset.sitekey = siteKey;
    containerRef.current.dataset.callback = callbackName;
    containerRef.current.dataset.action = "scan";
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
  }, [siteKey]);

  return (
    <div className={styles.challenge}>
      {siteKey ? (
        <div data-sitekey={siteKey} ref={containerRef} />
      ) : (
        <p>
          Challenge is not configured in this environment. Retry from a
          configured deployment.
        </p>
      )}
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import React, {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type { Segment } from "@agentify/scanner-contracts";

import { captureLandingAttribution } from "../lib/attribution-client";
import { savePendingScan } from "../lib/pending-scan";
import { validateSubmittedUrl } from "../lib/url-input";
import styles from "./url-scan-form.module.css";

type FormState = "default" | "submitting" | "error";

export function showSchemeHint(url: string) {
  return url.length === 0;
}

export function UrlScanForm({
  cta,
  segment,
  variant,
  compact = false,
}: Readonly<{
  cta: string;
  segment: Segment;
  variant: string;
  compact?: boolean;
}>) {
  const router = useRouter();
  const inputId = useId();
  const [url, setUrl] = useState("");
  const [state, setState] = useState<FormState>("default");
  const [message, setMessage] = useState("");
  const idempotencyKey = useRef("");
  const submitting = state === "submitting";

  useEffect(() => {
    router.prefetch("/scan/pending");
  }, [router]);

  function submitScan() {
    const validation = validateSubmittedUrl(url);
    if (!validation.ok) {
      setState("error");
      setMessage(validation.message);
      return;
    }

    idempotencyKey.current ||= crypto.randomUUID();
    const attributionSource = {
      pathname: window.location.pathname,
      search: window.location.search,
    };
    try {
      savePendingScan(window.sessionStorage, {
        url: url.trim(),
        segment,
        variant,
        idempotencyKey: idempotencyKey.current,
        landingPath: attributionSource.pathname,
        landingSearch: attributionSource.search,
      });
    } catch {
      setState("error");
      setMessage(
        "This browser blocked private scan storage. Allow site storage and retry.",
      );
      return;
    }

    setState("submitting");
    setMessage("Opening your private scan…");
    void captureLandingAttribution(segment, variant, attributionSource);
    router.push(`/scan/pending?segment=${segment}`);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!submitting) submitScan();
  }

  function onUrlChange(value: string) {
    setUrl(value);
    setState("default");
    setMessage("");
    idempotencyKey.current = "";
  }

  return (
    <div className={styles.wrapper}>
      <form
        className={`${styles.form} ${compact ? styles.compact : ""}`}
        noValidate
        onSubmit={onSubmit}
      >
        <label className="sr-only" htmlFor={inputId}>
          Website URL
        </label>
        <div className={styles.inputWrap}>
          {showSchemeHint(url) ? (
            <span aria-hidden="true">https://</span>
          ) : null}
          <input
            aria-describedby={`${inputId}-status`}
            autoCapitalize="none"
            autoComplete="url"
            disabled={submitting}
            id={inputId}
            inputMode="url"
            name="url"
            onChange={(event) => onUrlChange(event.target.value)}
            placeholder="yoursite.com"
            spellCheck={false}
            value={url}
          />
        </div>
        <button
          className="button button-primary"
          disabled={submitting}
          type="submit"
        >
          {submitting ? "Opening scan…" : `${cta} →`}
        </button>
      </form>
      <div
        aria-live="polite"
        className={`${styles.status} ${state === "error" ? styles.error : ""}`}
        id={`${inputId}-status`}
      >
        {message}
      </div>
    </div>
  );
}

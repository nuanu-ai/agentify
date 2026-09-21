"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  apiErrorEnvelopeSchema,
  createScanResponseSchema,
} from "@agentify/scanner-contracts";

import { captureLandingAttribution } from "../lib/attribution-client";
import {
  clearPendingScan,
  readPendingScan,
  type PendingScanRequest,
} from "../lib/pending-scan";
import { Brand } from "./brand";
import styles from "./pending-scan-experience.module.css";
import {
  TURNSTILE_TOKEN_EVENT,
  TurnstileChallenge,
} from "./turnstile-challenge";

type StartState =
  "starting" | "challenge" | "hard-limit" | "busy" | "error" | "missing";

const PHASES = [
  "Accepting the private scan",
  "Checking safe access to the site",
  "Reading public website signals",
  "Preparing the diagnostic report",
] as const;

export function PendingScanExperience({
  turnstileSiteKey,
}: Readonly<{ turnstileSiteKey: string | null }>) {
  const [request, setRequest] = useState<PendingScanRequest | null>(null);
  const [state, setState] = useState<StartState>("starting");
  const [message, setMessage] = useState(
    "Your request is secure. The live scan will start as soon as it is accepted.",
  );
  const started = useRef(false);
  const challengeRetried = useRef(false);

  const startScan = useCallback(
    async (pending: PendingScanRequest, turnstileToken?: string) => {
      setState("starting");
      setMessage(
        "Your request is secure. The live scan will start as soon as it is accepted.",
      );
      try {
        await captureLandingAttribution(pending.segment, pending.variant, {
          pathname: pending.landingPath,
          search: pending.landingSearch,
        });
        const response = await fetch("/api/v1/scans", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": pending.idempotencyKey,
          },
          body: JSON.stringify({
            url: pending.url,
            segment: pending.segment,
            landing_variant: pending.variant,
            turnstile_token: turnstileToken ?? null,
          }),
        });
        const payload: unknown = await response.json().catch(() => null);
        const accepted = createScanResponseSchema.safeParse(payload);
        if (response.ok && accepted.success) {
          clearPendingScan(window.sessionStorage);
          const fragment = new URLSearchParams({
            access_token: accepted.data.access_token,
          });
          window.location.replace(
            `/scan/${encodeURIComponent(accepted.data.scan_id)}?segment=${pending.segment}#${fragment.toString()}`,
          );
          return;
        }

        const code = readErrorCode(payload);
        if (code === "challenge_required") {
          challengeRetried.current = false;
          setState("challenge");
          setMessage(
            "Complete the privacy-preserving challenge to continue this scan.",
          );
          return;
        }
        if (code === "hard_rate_limit") {
          setState("hard-limit");
          setMessage(
            "This network or target reached the hard scan limit. Try again later.",
          );
          return;
        }
        if (code === "temporarily_busy") {
          setState("busy");
          setMessage(
            "The scanner is at capacity. No scan was promised; please retry shortly.",
          );
          return;
        }

        setState("error");
        setMessage(
          readErrorMessage(payload) ??
            "The scan could not be accepted. Please retry.",
        );
      } catch {
        setState("busy");
        setMessage(
          "The scanner cannot be reached right now. Please retry shortly.",
        );
      }
    },
    [],
  );

  useEffect(() => {
    const pending = readPendingScan(window.sessionStorage);
    if (!pending) {
      setState("missing");
      setMessage(
        "This private scan request is missing or expired. Return to the scanner and submit the site again.",
      );
      return;
    }
    setRequest(pending);
    if (started.current) return;
    started.current = true;
    void startScan(pending);
  }, [startScan]);

  useEffect(() => {
    if (state !== "challenge" || !request) return;
    const listener = (event: Event) => {
      if (challengeRetried.current) return;
      const token = (event as CustomEvent<unknown>).detail;
      if (typeof token !== "string" || !token) return;
      challengeRetried.current = true;
      void startScan(request, token);
    };
    window.addEventListener(TURNSTILE_TOKEN_EVENT, listener);
    return () => window.removeEventListener(TURNSTILE_TOKEN_EVENT, listener);
  }, [request, startScan, state]);

  const starting = state === "starting";
  return (
    <main className={styles.page}>
      <div className={styles.brandWrap}>
        <Brand />
      </div>
      <section className={styles.card}>
        <header className={styles.header}>
          <span>Private website diagnostic</span>
          <span className={styles.status}>
            {starting ? "starting" : state.replace("-", " ")}
          </span>
        </header>
        <div className={styles.body}>
          <span className="eyebrow">Scan progress</span>
          <h1>
            {starting ? "Your report is getting ready" : "Scan needs attention"}
          </h1>
          <p aria-live="polite" className={styles.message} role="status">
            {message}
          </p>
          {starting ? (
            <ol className={styles.phases}>
              {PHASES.map((phase, index) => (
                <li key={phase}>
                  <span aria-hidden="true" className={styles.phaseIcon}>
                    {index + 1}
                  </span>
                  <span>{phase}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {state === "challenge" ? (
            <div className={styles.challenge}>
              <TurnstileChallenge action="scan" siteKey={turnstileSiteKey} />
            </div>
          ) : null}
          {!starting && state !== "challenge" ? (
            <div className={styles.actions}>
              {request && state !== "hard-limit" ? (
                <button
                  className="button button-primary"
                  onClick={() => void startScan(request)}
                  type="button"
                >
                  Retry scan
                </button>
              ) : null}
              <Link className="button button-secondary" href="/">
                Enter another website
              </Link>
            </div>
          ) : null}
        </div>
      </section>
      <nav aria-label="Scan help" className={styles.helpLinks}>
        <Link href="/scanner">Scanner identity</Link>
        <Link href="/methodology">Methodology</Link>
        <Link href="/privacy">Privacy</Link>
      </nav>
    </main>
  );
}

function readErrorCode(payload: unknown): string | null {
  const parsed = apiErrorEnvelopeSchema.safeParse(payload);
  return parsed.success ? parsed.data.error.code : null;
}

function readErrorMessage(payload: unknown): string | null {
  const parsed = apiErrorEnvelopeSchema.safeParse(payload);
  return parsed.success ? parsed.data.error.message : null;
}

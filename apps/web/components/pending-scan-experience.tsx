import { useCallback, useEffect, useRef, useState } from "react";

import { acceptedScanIn } from "../lib/api-answers";
import { captureLandingAttribution } from "../lib/attribution-client";
import { clearPendingScan, type PendingScanRequest, readPendingScan } from "../lib/pending-scan";
import { press } from "../lib/press";
import styles from "./pending-scan-experience.module.css";
import { SiteFooter, SiteTop } from "./site-chrome";
import { SiteLink } from "./site-link";
import { TURNSTILE_TOKEN_EVENT, TurnstileChallenge } from "./turnstile-challenge";

type StartState =
  | "starting"
  | "challenge"
  | "hard-limit"
  | "busy"
  | "unreachable"
  | "error"
  | "missing";

/**
 * What the page calls each state: its heading, and the word beside the
 * panel's name, short enough to stay on that line on a small phone.
 */
const SAID: Readonly<Record<StartState, { label: string; title: string }>> = {
  starting: { label: "starting", title: "Your report is getting ready" },
  challenge: { label: "waiting", title: "Confirm you are a person" },
  "hard-limit": { label: "limit", title: "Too many scans for now" },
  busy: { label: "busy", title: "The scanner is busy" },
  unreachable: { label: "no reply", title: "The scanner did not answer" },
  error: { label: "failed", title: "The scan could not start" },
  missing: { label: "no scan", title: "No scan request in this tab" },
};

/**
 * The time on the visitor's own clock when a wait ends, rounded up to the
 * minute so it never names a moment before the scanner frees up; with the
 * day when that is not today.
 */
function freeAt(waitSeconds: number): string {
  const at = new Date(Math.ceil((Date.now() + waitSeconds * 1000) / 60_000) * 60_000);
  const today = at.toDateString() === new Date().toDateString();
  return at.toLocaleString([], {
    ...(today ? {} : { weekday: "short" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PendingScanExperience({
  turnstileSiteKey,
}: Readonly<{ turnstileSiteKey: string | null }>) {
  const [request, setRequest] = useState<PendingScanRequest | null>(null);
  const [state, setState] = useState<StartState>("starting");
  const [message, setMessage] = useState("Starting as soon as it is accepted.");
  const [retryable, setRetryable] = useState(true);
  const started = useRef(false);
  const challengeRetried = useRef(false);

  const startScan = useCallback(async (pending: PendingScanRequest, turnstileToken?: string) => {
    setState("starting");
    setMessage("Starting as soon as it is accepted.");
    setRetryable(true);
    await captureLandingAttribution(pending.segment, pending.variant, {
      pathname: pending.landingPath,
      search: pending.landingSearch,
    });
    const outcome = await press(
      "/api/v1/scans",
      {
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
      },
      acceptedScanIn,
    );
    if (outcome.kind === "done") {
      clearPendingScan(window.sessionStorage);
      const fragment = new URLSearchParams({
        access_token: outcome.answer.access_token,
      });
      window.location.replace(
        `/scan/${encodeURIComponent(outcome.answer.scan_id)}?segment=${pending.segment}#${fragment.toString()}`,
      );
      return;
    }
    if (outcome.kind === "unknown") {
      // The retry carries the same idempotency key, so a scan this browser's
      // session started is answered again; a first visit whose cookie was lost
      // with the answer starts another, which is harmless.
      setState("unreachable");
      setMessage(
        "No answer came back, so we cannot tell whether the scan started. Retry: you get that scan if it did, or a new one.",
      );
      return;
    }

    const { code } = outcome.refusal;
    if (code === "challenge_required") {
      challengeRetried.current = false;
      setState("challenge");
      setMessage("Complete the challenge to continue.");
      return;
    }
    if (code === "hard_rate_limit") {
      setState("hard-limit");
      const wait = outcome.refusal.retry_after_seconds;
      setMessage(
        wait === undefined
          ? "Scans from this network or for this website are used up for now. Try again later."
          : `Scans from this network or for this website are used up until ${freeAt(wait)}.`,
      );
      return;
    }
    if (code === "temporarily_busy") {
      setState("busy");
      // Busy is also the answer to a repeat whose scan already exists.
      setMessage(
        `${outcome.refusal.message} Retry shortly: you get the scan if it started, or a new one.`,
      );
      return;
    }

    // A refusal says whether the same request could succeed later; an address
    // the scanner refuses never will.
    setState("error");
    setRetryable(outcome.refusal.retryable);
    setMessage(outcome.refusal.message);
  }, []);

  useEffect(() => {
    const pending = readPendingScan(window.sessionStorage);
    if (!pending) {
      setState("missing");
      setMessage("This tab holds no scan request, or it has expired. Enter the website again.");
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
    <>
      <SiteTop />
      <main className="message-page" id="main">
        <section className="message-panel">
          <div className="message-meta">
            <span>Private website diagnostic</span>
            <span className={styles.status} data-state={state}>
              {SAID[state].label}
            </span>
          </div>
          <h1>{SAID[state].title}</h1>
          <p aria-live="polite" role="status">
            {message}
          </p>
          {state === "challenge" ? (
            <div className="message-actions">
              <TurnstileChallenge action="scan" siteKey={turnstileSiteKey} />
            </div>
          ) : null}
          {!starting && state !== "challenge" ? (
            <div className="message-actions">
              {request && state !== "hard-limit" && retryable ? (
                <button
                  className="button button-primary"
                  onClick={() => void startScan(request)}
                  type="button"
                >
                  Retry scan
                </button>
              ) : null}
              <SiteLink className="button button-secondary" to="/">
                Enter another website
              </SiteLink>
            </div>
          ) : null}
        </section>
      </main>
      <SiteFooter>
        <a href="/docs/scanner/methodology">Methodology</a>
      </SiteFooter>
    </>
  );
}

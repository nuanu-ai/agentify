import { useCallback, useEffect, useRef, useState } from "react";

import { acceptedScanIn } from "../lib/api-answers";
import { captureLandingAttribution } from "../lib/attribution-client";
import { clearPendingScan, type PendingScanRequest, readPendingScan } from "../lib/pending-scan";
import { press } from "../lib/press";
import { Brand } from "./brand";
import styles from "./pending-scan-experience.module.css";
import { SiteDoors } from "./site-chrome";
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
 * What the page calls each state: its heading, and the word beside the card's
 * name, short enough to stay on that line on a small phone.
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
        "No answer came back, so we cannot tell whether the scan started. Retrying is safe: you get the scan that started, or a new one.",
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
      setMessage("This network or target reached the hard scan limit. Try again later.");
      return;
    }
    if (code === "temporarily_busy") {
      setState("busy");
      setMessage(
        "The scanner could not take this scan just now. No scan was started; please retry shortly.",
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
      setMessage("This scan request is missing or expired. Submit the site again.");
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
        <SiteDoors />
      </div>
      <section className={styles.card}>
        <header className={styles.header}>
          <span>Private website diagnostic</span>
          <span className={styles.status} data-state={state}>
            {SAID[state].label}
          </span>
        </header>
        <div className={styles.body}>
          <h1>{SAID[state].title}</h1>
          <p aria-live="polite" className={styles.message} role="status">
            {message}
          </p>
          {state === "challenge" ? (
            <div className={styles.challenge}>
              <TurnstileChallenge action="scan" siteKey={turnstileSiteKey} />
            </div>
          ) : null}
          {!starting && state !== "challenge" ? (
            <div className={styles.actions}>
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
        </div>
      </section>
      <nav aria-label="Scan help" className={styles.helpLinks}>
        <a href="/docs/scanner">Scanner identity</a>
        <a href="/docs/scanner/methodology">Methodology</a>
        <SiteLink to="/privacy">Privacy</SiteLink>
      </nav>
    </main>
  );
}

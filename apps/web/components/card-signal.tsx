import { Suspense, useEffect, useRef, useState } from "react";

import {
  CARD_SIGNAL_DISCLOSURES,
  type CardSignalState as CardSignalStatus,
  canLoadStripeSdk,
} from "../lib/card-signal-ui";
import { press } from "../lib/press";
import styles from "./card-signal.module.css";
import { lazyPart } from "./lazy-part";

// Stripe's own scripts load at the step that shows its card form, once the
// visitor agreed and the provider's setup is ready, never with the report.
const StripeCardStep = lazyPart(() =>
  import("./card-signal-stripe-form").then((module) => module.StripeCardStep),
);

type SetupResponse = Readonly<{
  signal_id: string;
  status: CardSignalStatus;
  client_secret: string | null;
  adapter: "local" | "stripe";
}>;

const SIGNAL_STATES: readonly string[] = [
  "not_started",
  "setup_pending",
  "attached",
  "detached",
  "failed",
];

function setupIn(answer: unknown): SetupResponse | null {
  if (typeof answer !== "object" || answer === null) return null;
  const setup = answer as Record<string, unknown>;
  return typeof setup.signal_id === "string" &&
    statusIn(setup) !== null &&
    (setup.client_secret === null || typeof setup.client_secret === "string") &&
    (setup.adapter === "local" || setup.adapter === "stripe")
    ? (setup as SetupResponse)
    : null;
}

function statusIn(answer: unknown): CardSignalStatus | null {
  const status = (answer as { status?: unknown } | null)?.status;
  return typeof status === "string" && SIGNAL_STATES.includes(status)
    ? (status as CardSignalStatus)
    : null;
}

export function CardSignal({
  scanId,
  className,
  enabled,
  adapter,
  publishableKey,
  initialSignal,
  signedInAs,
}: Readonly<{
  scanId: string;
  className?: string;
  enabled: boolean;
  adapter: "local" | "stripe";
  publishableKey: string | null;
  /** The address the report page was loaded for, named with the setup. */
  signedInAs: string;
  initialSignal?: {
    signalId: string;
    status: CardSignalStatus;
    clientSecret: string | null;
  };
}>) {
  const [consented, setConsented] = useState(Boolean(initialSignal));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<CardSignalStatus>(initialSignal?.status ?? "not_started");
  const [signalId, setSignalId] = useState<string | undefined>(initialSignal?.signalId);
  const [clientSecret, setClientSecret] = useState<string | undefined>(
    initialSignal?.clientSecret ?? undefined,
  );
  const [message, setMessage] = useState(
    initialSignal?.status === "attached"
      ? "Card saved after verified provider confirmation."
      : initialSignal?.status === "detached"
        ? "Card removed and verified with the provider."
        : initialSignal?.status === "setup_pending"
          ? "Setup restored. Waiting for provider confirmation."
          : "",
  );
  const [confirmingDetach, setConfirmingDetach] = useState(false);
  // Set once the site has said this page was loaded for somebody other than
  // who is signed in now; from then on the page offers only a reload.
  const [stale, setStale] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());
  const stripeStep =
    canLoadStripeSdk({ consented, clientSecret, adapter, publishableKey }) &&
    publishableKey !== null &&
    clientSecret !== undefined &&
    status === "setup_pending";

  useEffect(() => {
    if (status !== "setup_pending" || !signalId) return;
    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const response = await fetch(`/api/v1/card-signals/${signalId}`, {
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as {
          status?: CardSignalStatus;
        } | null;
        if (cancelled || !response.ok || !payload?.status) return;
        if (payload.status === "attached" || payload.status === "detached") {
          setStatus(payload.status);
          setMessage(
            payload.status === "attached"
              ? "Card saved after verified provider confirmation."
              : "Card removed and verified with the provider.",
          );
        }
      } catch {
        // The report stays usable while provider confirmation is delayed.
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      if (attempts >= 40) {
        window.clearInterval(timer);
        return;
      }
      void poll();
    }, 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [signalId, status]);

  if (!enabled) return null;

  function refusedWith(refusal: Readonly<{ code: string; message: string }>) {
    setMessage(refusal.message);
    if (refusal.code === "page_not_matched") setStale(true);
  }

  async function prepareCard() {
    if (!consented) return;
    setBusy(true);
    setMessage("Preparing the secure card form…");
    const outcome = await press(
      "/api/v1/card-signals/setup-intents",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: JSON.stringify({
          scan_id: scanId,
          card_signal_consent: true,
          signed_in_as: signedInAs,
        }),
      },
      setupIn,
    );
    setBusy(false);
    if (outcome.kind !== "done") {
      setStatus("failed");
      if (outcome.kind === "refused") refusedWith(outcome.refusal);
      else
        setMessage(
          "No answer came back, so we cannot tell whether the card form was prepared. Try again: no card is saved until you enter one.",
        );
      return;
    }
    const setup = outcome.answer;
    setSignalId(setup.signal_id);
    setStatus(setup.status);
    if (setup.client_secret) setClientSecret(setup.client_secret);
    setMessage(
      setup.status === "attached"
        ? "Card saved after verified provider confirmation."
        : setup.status === "detached"
          ? "Card removed and verified with the provider."
          : "Secure card form ready.",
    );
  }

  async function confirmLocal() {
    if (!signalId) return;
    setBusy(true);
    setStatus("setup_pending");
    setMessage("Waiting for signed provider confirmation…");
    const outcome = await press(
      `/api/v1/card-signals/${signalId}/local-confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signed_in_as: signedInAs }),
      },
      statusIn,
    );
    setBusy(false);
    if (outcome.kind === "done") {
      setStatus(outcome.answer);
      setMessage(
        outcome.answer === "attached"
          ? "Card saved after verified provider confirmation."
          : "Waiting for signed provider confirmation…",
      );
      return;
    }
    if (outcome.kind === "refused") {
      setStatus("failed");
      refusedWith(outcome.refusal);
      return;
    }
    // Still waiting, so the page goes on asking the provider's state.
    setMessage(
      "No answer came back, so we cannot tell whether the confirmation went through. Reload this page to see whether the card is saved.",
    );
  }

  async function detach() {
    if (!signalId) return;
    setBusy(true);
    setMessage("Removing the card and checking provider state…");
    const outcome = await press(
      `/api/v1/card-signals/${signalId}/payment-method`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signed_in_as: signedInAs }),
      },
      (answer) => (statusIn(answer) === "detached" ? "detached" : null),
    );
    setBusy(false);
    if (outcome.kind === "done") {
      setStatus("detached");
      setConfirmingDetach(false);
      setMessage("Card removed and verified with the provider.");
      return;
    }
    if (outcome.kind === "refused") refusedWith(outcome.refusal);
    else
      setMessage(
        "No answer came back, so we cannot tell whether the card was removed. Reload this page: it shows whether the card is still saved.",
      );
  }

  if (stale)
    return (
      <section className={className} id="card-signal">
        <p aria-live="polite" className={styles.status}>
          {message}
        </p>
        <p>
          {/* Drawn only after a press, in the browser, so the address is there. */}
          <a href={window.location.href}>Reload this page</a>
        </p>
      </section>
    );

  return (
    <section className={className} id="card-signal">
      <p className={styles.kicker}>Optional signal, not a checkout</p>
      <h2>Would you consider buying help later?</h2>
      <p className={styles.free}>$0 now.</p>
      <ul className={styles.disclosures}>
        {CARD_SIGNAL_DISCLOSURES.map((disclosure) => (
          <li key={disclosure}>{disclosure}</li>
        ))}
      </ul>

      {status === "not_started" || status === "failed" ? (
        <div className={styles.consent}>
          <label>
            <input
              checked={consented}
              onChange={(event) => setConsented(event.target.checked)}
              type="checkbox"
            />
            <span>
              I explicitly agree to save a card as an interest signal under the terms above.
            </span>
          </label>
          <button
            className="button button-secondary"
            disabled={!consented || busy}
            onClick={() => void prepareCard()}
            type="button"
          >
            {busy
              ? "Preparing…"
              : status === "failed"
                ? "Try again"
                : "Continue to secure card form"}
          </button>
        </div>
      ) : null}

      {stripeStep ? (
        <Suspense fallback={null}>
          <StripeCardStep
            clientSecret={clientSecret}
            onFailure={(failure) => {
              setStatus("failed");
              setMessage(failure);
            }}
            onPending={() => {
              setStatus("setup_pending");
              setMessage("Card submitted. Waiting for signed provider confirmation…");
            }}
            publishableKey={publishableKey}
          />
        </Suspense>
      ) : null}

      {clientSecret && adapter === "local" && status === "setup_pending" ? (
        <div className={styles.localForm}>
          <p>Local deterministic adapter. No card data is collected.</p>
          <button
            className="button button-secondary"
            disabled={busy}
            onClick={() => void confirmLocal()}
            type="button"
          >
            {busy ? "Confirming…" : "Simulate provider confirmation"}
          </button>
        </div>
      ) : null}

      {status === "attached" ? (
        <div className={styles.attached}>
          <strong>Card saved</strong>
          {!confirmingDetach ? (
            <button
              className="button button-secondary"
              onClick={() => setConfirmingDetach(true)}
              type="button"
            >
              Remove card
            </button>
          ) : (
            <div className={styles.detachConfirm}>
              <span>Remove this saved card now?</span>
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={() => void detach()}
                type="button"
              >
                {busy ? "Removing…" : "Yes, remove card"}
              </button>
              <button
                className={styles.textButton}
                disabled={busy}
                onClick={() => setConfirmingDetach(false)}
                type="button"
              >
                Keep card
              </button>
            </div>
          )}
        </div>
      ) : null}

      {status === "detached" ? <strong className={styles.detached}>Card removed</strong> : null}
      <p aria-live="polite" className={styles.status}>
        {message}
      </p>
    </section>
  );
}

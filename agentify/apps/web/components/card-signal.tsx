"use client";

import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js/pure";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  CARD_SIGNAL_DISCLOSURES,
  canLoadStripeSdk,
} from "../lib/card-signal-ui";
import styles from "./card-signal.module.css";

type CardSignalStatus =
  "not_started" | "setup_pending" | "attached" | "detached" | "failed";

type SetupResponse = Readonly<{
  signal_id: string;
  status: CardSignalStatus;
  client_secret: string | null;
  adapter: "local" | "stripe";
}>;

export function CardSignal({
  scanId,
  enabled,
  adapter,
  publishableKey,
  initialSignal,
}: Readonly<{
  scanId: string;
  enabled: boolean;
  adapter: "local" | "stripe";
  publishableKey: string | null;
  initialSignal?: {
    signalId: string;
    status: CardSignalStatus;
    clientSecret: string | null;
  };
}>) {
  const [consented, setConsented] = useState(Boolean(initialSignal));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<CardSignalStatus>(
    initialSignal?.status ?? "not_started",
  );
  const [signalId, setSignalId] = useState<string | undefined>(
    initialSignal?.signalId,
  );
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
  const idempotencyKey = useRef(crypto.randomUUID());
  const stripePromise = useMemo(
    () =>
      canLoadStripeSdk({
        consented,
        clientSecret,
        adapter,
        publishableKey,
      }) && publishableKey
        ? loadStripe(publishableKey)
        : null,
    [adapter, clientSecret, consented, publishableKey],
  );

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

  async function prepareCard() {
    if (!consented) return;
    setBusy(true);
    setMessage("Preparing the secure card form…");
    try {
      const response = await fetch("/api/v1/card-signals/setup-intents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: JSON.stringify({
          scan_id: scanId,
          card_signal_consent: true,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        SetupResponse | { error?: { message?: string } } | null;
      if (!response.ok || !payload || !("signal_id" in payload)) {
        throw new Error(
          payload && "error" in payload
            ? payload.error?.message
            : "The card form is temporarily unavailable.",
        );
      }
      setSignalId(payload.signal_id);
      setStatus(payload.status);
      if (payload.client_secret) setClientSecret(payload.client_secret);
      setMessage(
        payload.status === "attached"
          ? "Card saved after verified provider confirmation."
          : payload.status === "detached"
            ? "Card removed and verified with the provider."
            : "Secure card form ready.",
      );
    } catch (error) {
      setStatus("failed");
      setMessage(
        error instanceof Error
          ? error.message
          : "The card form is temporarily unavailable. Your report is unaffected.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmLocal() {
    if (!signalId) return;
    setBusy(true);
    setStatus("setup_pending");
    setMessage("Waiting for signed provider confirmation…");
    try {
      const response = await fetch(
        `/api/v1/card-signals/${signalId}/local-confirm`,
        { method: "POST" },
      );
      const payload = (await response.json().catch(() => null)) as {
        status?: CardSignalStatus;
      } | null;
      if (!response.ok || !payload?.status)
        throw new Error("Local provider confirmation failed.");
      setStatus(payload.status);
      setMessage(
        payload.status === "attached"
          ? "Card saved after verified provider confirmation."
          : "Waiting for signed provider confirmation…",
      );
    } catch {
      setStatus("failed");
      setMessage(
        "Card confirmation failed. Your report and waitlist are unaffected.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function detach() {
    if (!signalId) return;
    setBusy(true);
    setMessage("Removing the card and checking provider state…");
    try {
      const response = await fetch(
        `/api/v1/card-signals/${signalId}/payment-method`,
        { method: "DELETE" },
      );
      const payload = (await response.json().catch(() => null)) as {
        status?: CardSignalStatus;
      } | null;
      if (!response.ok || payload?.status !== "detached")
        throw new Error("Provider removal could not be verified.");
      setStatus("detached");
      setConfirmingDetach(false);
      setMessage("Card removed and verified with the provider.");
    } catch {
      setMessage(
        "Removal could not be verified, so the card is not marked removed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.panel} id="card-signal">
      <div className={styles.heading}>
        <div>
          <span className="eyebrow">Optional signal · not a checkout</span>
          <h2>Would you consider buying help later?</h2>
        </div>
        <strong>$0 now</strong>
      </div>
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
              I explicitly agree to save a card as an interest signal under the
              terms above.
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

      {clientSecret &&
      adapter === "stripe" &&
      stripePromise &&
      status === "setup_pending" ? (
        <Elements
          options={{
            clientSecret,
            appearance: {
              theme: "stripe",
              // Stripe Elements renders in an iframe and cannot read our CSS
              // custom properties, so these mirror --accent / --radius-control
              // by value. Keep in sync with globals.css.
              variables: { colorPrimary: "#0f736e", borderRadius: "12px" },
            },
          }}
          stripe={stripePromise}
        >
          <StripeCardForm
            onFailure={(failure) => {
              setStatus("failed");
              setMessage(failure);
            }}
            onPending={() => {
              setStatus("setup_pending");
              setMessage(
                "Card submitted. Waiting for signed provider confirmation…",
              );
            }}
          />
        </Elements>
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

      {status === "detached" ? (
        <strong className={styles.detached}>Card removed</strong>
      ) : null}
      <p aria-live="polite" className={styles.status}>
        {message}
      </p>
    </section>
  );
}

function StripeCardForm({
  onFailure,
  onPending,
}: Readonly<{
  onFailure: (message: string) => void;
  onPending: () => void;
}>) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    const result = await stripe.confirmSetup({
      elements,
      confirmParams: {
        return_url: `${window.location.href.split("#")[0]}#card-signal`,
      },
      redirect: "if_required",
    });
    setSubmitting(false);
    if (result.error) {
      onFailure(
        result.error.message ??
          "Card confirmation failed. Your report is unaffected.",
      );
      return;
    }
    onPending();
  }

  return (
    <form
      className={styles.stripeForm}
      onSubmit={(event) => void submit(event)}
    >
      <PaymentElement />
      <button
        className="button button-secondary"
        disabled={!stripe || !elements || submitting}
        type="submit"
      >
        {submitting ? "Submitting…" : "Save card as a $0 signal"}
      </button>
    </form>
  );
}

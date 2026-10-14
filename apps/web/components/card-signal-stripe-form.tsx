import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js/pure";
import { type FormEvent, useMemo, useState } from "react";

import styles from "./card-signal.module.css";

/** Stripe's card form for a setup the provider has made ready, saving the card as a $0 signal. */
export function StripeCardStep({
  clientSecret,
  onFailure,
  onPending,
  publishableKey,
}: Readonly<{
  clientSecret: string;
  onFailure: (message: string) => void;
  onPending: () => void;
  publishableKey: string;
}>) {
  const stripe = useMemo(() => loadStripe(publishableKey), [publishableKey]);
  return (
    <Elements
      options={{
        clientSecret,
        appearance: {
          theme: "stripe",
          // Stripe Elements renders in an iframe and cannot read our CSS
          // custom properties, so these mirror --accent / --radius-control
          // by value. Keep in sync with @agentify/visual/tokens.css.
          variables: { colorPrimary: "#0f736e", borderRadius: "12px" },
        },
      }}
      stripe={stripe}
    >
      <StripeCardForm onFailure={onFailure} onPending={onPending} />
    </Elements>
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
      onFailure(result.error.message ?? "Card confirmation failed. Your report is unaffected.");
      return;
    }
    onPending();
  }

  return (
    <form className={styles.stripeForm} onSubmit={(event) => void submit(event)}>
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

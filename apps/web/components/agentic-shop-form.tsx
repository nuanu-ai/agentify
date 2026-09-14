"use client";

import React, { useEffect, useRef, useState, type FormEvent } from "react";
import styles from "../app/agentic-shop/shop.module.css";

export function AgenticShopForm() {
  const key = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "success" | "error">(
    "idle",
  );
  const [message, setMessage] = useState("");
  const feedback = useRef<HTMLDivElement>(null);

  useEffect(() => setReady(true), []);

  useEffect(() => {
    if (state !== "success" && state !== "error") return;
    // Wait for React to commit the replacement success card before focusing it.
    feedback.current?.focus({ preventScroll: true });
    feedback.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [state]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === "sending") return;
    const data = new FormData(event.currentTarget);
    key.current ??= crypto.randomUUID();
    setState("sending");
    setMessage("");
    try {
      const response = await fetch("/api/v1/merchant-applications", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key.current,
        },
        body: JSON.stringify({
          businessName: data.get("businessName"),
          website: data.get("website"),
          email: data.get("email"),
          category: data.get("category"),
          country: data.get("country"),
          offer: data.get("offer"),
          consent: data.get("consent") === "on",
          companyFax: data.get("companyFax"),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409 || response.status === 400)
          key.current = null;
        throw new Error(
          result.error?.message ||
            "We couldn’t save your application. Please try again.",
        );
      }
      if (response.status !== 202 || result.status !== "received") {
        throw new Error(
          "We couldn’t confirm your application was saved. Please try again.",
        );
      }
      setState("success");
    } catch (error) {
      setState("error");
      setMessage(
        error instanceof Error && error.name !== "TimeoutError"
          ? error.message
          : "The connection took too long. Please try again; we’ll avoid creating a duplicate.",
      );
    }
  }

  if (state === "success")
    return (
      <div
        className={styles.formSuccess}
        ref={feedback}
        tabIndex={-1}
        role="status"
      >
        <span className={styles.successMark} aria-hidden="true">
          ✓
        </span>
        <p className={styles.eyebrow}>Application received</p>
        <h3>
          You’ve made
          <br />
          the first move.
        </h3>
        <p>
          Your application has been saved for review. We’ll use the email you
          provided to discuss fit and next steps.
        </p>
        <p className={styles.formFootnote}>
          This is an application, not a confirmed merchant connection or payment
          service.
        </p>
        <a href="#how-it-works" className={styles.textLink}>
          Explore the process <span aria-hidden="true">→</span>
        </a>
      </div>
    );

  return (
    <form
      onSubmit={submit}
      method="post"
      className={styles.form}
      aria-label="Merchant application"
    >
      <div className={styles.formHeader}>
        <h3>Tell us what you sell.</h3>
        <span>Start with one offer.</span>
      </div>
      <label>
        Business name
        <input
          name="businessName"
          autoComplete="organization"
          placeholder="Your business"
          required
          minLength={2}
          maxLength={120}
        />
      </label>
      <label>
        Website or business page
        <input
          name="website"
          type="url"
          autoComplete="url"
          placeholder="https://your-business.com"
          required
          maxLength={500}
        />
      </label>
      <label>
        Work email
        <input
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@your-business.com"
          required
          maxLength={254}
        />
      </label>
      <div className={styles.formRow}>
        <label>
          What do you sell?
          <select name="category" required defaultValue="">
            <option value="" disabled>
              Select a category
            </option>
            <option value="retail">Products & retail</option>
            <option value="hospitality">Hotels & accommodation</option>
            <option value="food">Food & restaurants</option>
            <option value="experiences">Experiences & tickets</option>
            <option value="services">Local services & wellness</option>
            <option value="digital">Digital products & services</option>
            <option value="other">Something else</option>
          </select>
        </label>
        <label>
          Business country
          <input
            name="country"
            autoComplete="country-name"
            placeholder="e.g. Indonesia"
            required
            minLength={2}
            maxLength={80}
          />
        </label>
      </div>
      <label>
        Your first offer <span className={styles.optional}>(optional)</span>
        <textarea
          name="offer"
          placeholder="A day pass, a room, a product, a service…"
          rows={3}
          maxLength={1200}
        />
      </label>
      <div className={styles.honeypot} aria-hidden="true">
        <label>
          Company fax
          <input name="companyFax" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <label className={styles.checkbox}>
        <input type="checkbox" name="consent" required />
        <span>
          I agree to the{" "}
          <a href="/agentic-shop/privacy">application privacy notice</a> and to
          being contacted about this application.
        </span>
      </label>
      <div
        ref={feedback}
        tabIndex={-1}
        role={state === "error" ? "alert" : "status"}
        className={state === "error" ? styles.formError : styles.formStatus}
      >
        {state === "error"
          ? message
          : state === "sending"
            ? "Saving your application…"
            : ""}
      </div>
      <button
        type="submit"
        className={styles.primary}
        disabled={!ready || state === "sending"}
      >
        {state === "sending" ? "Sending…" : "Apply to connect"}
        <span aria-hidden="true">↗</span>
      </button>
      <noscript>Please enable JavaScript to send your application.</noscript>
      <p className={styles.formFootnote}>
        We’ll discuss fit and terms before any connection goes live.
      </p>
    </form>
  );
}

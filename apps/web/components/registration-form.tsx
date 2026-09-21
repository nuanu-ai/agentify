"use client";

import React, {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { registrationResponseSchema } from "@agentify/scanner-contracts";

import styles from "./registration-form.module.css";

type RegistrationState = "idle" | "sending" | "sent" | "error";

export function registrationSubmitLabel(
  state: RegistrationState,
  resendCooldown: number,
) {
  if (state === "sending") return "Sending…";
  if (state === "sent" && resendCooldown > 0)
    return `Resend link in ${resendCooldown}s`;
  if (state === "sent") return "Resend secure link";
  return "Email me a secure link";
}

export function sentConfirmationCopy(email: string) {
  const followUp = "Open it in this browser to unlock the prompt and report.";
  if (!email)
    return `If the address can receive mail, a secure confirmation link has been sent. ${followUp}`;
  return `We sent a secure link to ${email} (if the address can receive mail). ${followUp}`;
}

export function RegistrationForm({ scanId }: Readonly<{ scanId: string }>) {
  const emailId = useId();
  const phoneId = useId();
  const [state, setState] = useState<RegistrationState>("idle");
  const [message, setMessage] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);
  const registrationStarted = useRef(false);

  function markRegistrationStarted() {
    if (registrationStarted.current) return;
    registrationStarted.current = true;
    window.dispatchEvent(
      new CustomEvent("agentify:analytics-event", {
        detail: { name: "registration_started", scanId },
      }),
    );
  }

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = window.setTimeout(
      () => setResendCooldown((value) => Math.max(0, value - 1)),
      1_000,
    );
    return () => window.clearTimeout(timer);
  }, [resendCooldown]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = sessionStorage.getItem(`agentify:scan-token:${scanId}`);
    if (!token) {
      setState("error");
      setMessage(
        "Open the original private scan link before requesting the report.",
      );
      return;
    }
    const form = new FormData(event.currentTarget);
    setState("sending");
    const response = await fetch(
      `/api/v2/scans/${encodeURIComponent(scanId)}/registrations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: form.get("email"),
          phone: form.get("phone"),
          role: form.get("role"),
          site_is_mine: form.get("site_is_mine") === "on",
          marketing_email_opt_in: form.get("marketing_email_opt_in") === "on",
          dataset_reuse_acknowledged:
            form.get("dataset_reuse_acknowledged") === "on",
        }),
      },
    );
    const parsed = registrationResponseSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (response.ok && parsed.success) {
      setState("sent");
      setResendCooldown(60);
      setSentTo(
        typeof form.get("email") === "string" ? String(form.get("email")) : "",
      );
      setMessage("");
    } else {
      setState("error");
      setMessage(
        response.status === 429
          ? "Too many verification requests. Please try again later."
          : "Verification email is temporarily unavailable. Please retry.",
      );
    }
  }

  return (
    <form
      className={styles.form}
      onFocusCapture={markRegistrationStarted}
      onSubmit={(event) => void submit(event)}
    >
      {state === "sent" ? (
        <div className={styles.sent} aria-live="polite">
          <strong>Check your inbox</strong>
          <p>{sentConfirmationCopy(sentTo)}</p>
        </div>
      ) : null}
      <div>
        <label htmlFor={emailId}>Email</label>
        <input
          id={emailId}
          name="email"
          type="email"
          autoComplete="email"
          required
        />
      </div>
      <div>
        <label htmlFor={phoneId}>Phone</label>
        <input
          autoComplete="tel"
          id={phoneId}
          inputMode="tel"
          name="phone"
          pattern="\+[1-9][0-9 ()-]{7,20}"
          placeholder="+1 415 555 0123"
          required
          type="tel"
        />
        <span className={styles.hint}>
          Include the country code. We store it as contact information; only
          your email is verified.
        </span>
      </div>
      <div>
        <label htmlFor={`${emailId}-role`}>Your role</label>
        <select
          id={`${emailId}-role`}
          name="role"
          defaultValue="business_owner"
          required
        >
          <option value="business_owner">Business owner</option>
          <option value="commerce_lead">Commerce lead</option>
          <option value="developer">Developer / agency</option>
          <option value="other">Other</option>
        </select>
      </div>
      <label className={styles.check}>
        <input name="site_is_mine" type="checkbox" /> I own or manage this site.
      </label>
      <label className={styles.check}>
        <input name="dataset_reuse_acknowledged" type="checkbox" required /> I
        acknowledge the scanner data notice.
      </label>
      <label className={styles.check}>
        <input name="marketing_email_opt_in" type="checkbox" /> Send optional
        product research updates.
      </label>
      <button
        className="button button-primary"
        disabled={
          state === "sending" || (state === "sent" && resendCooldown > 0)
        }
        type="submit"
      >
        {registrationSubmitLabel(state, resendCooldown)}
      </button>
      {message && state === "error" ? (
        <p className={styles.error} aria-live="polite">
          {message}
        </p>
      ) : null}
    </form>
  );
}

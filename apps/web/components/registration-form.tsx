"use client";

import { registrationResponseSchema } from "@agentify/scanner-contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { linkAnswerFailure, waitLabel } from "../lib/link-answer";
import styles from "./registration-form.module.css";

type RegistrationState = "idle" | "sending" | "sent" | "error";

/**
 * The wait is the server's to name. This button used to count sixty seconds
 * of its own after a send, which was a guess at the cabinet's minute and told
 * a person nothing about the wall actually in front of them.
 */
export function registrationSubmitLabel(state: RegistrationState, resendWait: number) {
  if (state === "sending") return "Sending…";
  if (resendWait > 0) return `Try again in ${waitLabel(resendWait)}`;
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
  const [resendWait, setResendWait] = useState(0);
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
    if (resendWait <= 0) return;
    const timer = window.setTimeout(() => setResendWait((value) => Math.max(0, value - 1)), 1_000);
    return () => window.clearTimeout(timer);
  }, [resendWait]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = sessionStorage.getItem(`agentify:scan-token:${scanId}`);
    if (!token) {
      setState("error");
      setMessage("Open the original private scan link before requesting the report.");
      return;
    }
    const form = new FormData(event.currentTarget);
    setState("sending");
    const response = await fetch(`/api/v2/scans/${encodeURIComponent(scanId)}/registrations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: form.get("email"),
        phone: form.get("phone") || undefined,
        role: form.get("role"),
        site_is_mine: form.get("site_is_mine") === "on",
        marketing_email_opt_in: form.get("marketing_email_opt_in") === "on",
        dataset_reuse_acknowledged: form.get("dataset_reuse_acknowledged") === "on",
      }),
    });
    const payload: unknown = await response.json().catch(() => null);
    const parsed = registrationResponseSchema.safeParse(payload);
    if (response.ok && parsed.success) {
      setState("sent");
      setResendWait(0);
      setSentTo(typeof form.get("email") === "string" ? String(form.get("email")) : "");
      setMessage("");
    } else {
      const failure = linkAnswerFailure(payload);
      setState("error");
      setMessage(failure.message);
      setResendWait(failure.waitSeconds);
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
        <input id={emailId} name="email" type="email" autoComplete="email" required />
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
          type="tel"
        />
        <span className={styles.hint}>
          Optional. Include the country code if you add one. We store it as contact information;
          only your email is verified.
        </span>
      </div>
      <div>
        <label htmlFor={`${emailId}-role`}>Your role</label>
        <select id={`${emailId}-role`} name="role" defaultValue="business_owner" required>
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
        <input name="dataset_reuse_acknowledged" type="checkbox" required /> I acknowledge the
        scanner data notice.
      </label>
      <label className={styles.check}>
        <input name="marketing_email_opt_in" type="checkbox" /> Send optional product research
        updates.
      </label>
      <button
        className="button button-primary"
        disabled={state === "sending" || resendWait > 0}
        type="submit"
      >
        {registrationSubmitLabel(state, resendWait)}
      </button>
      {message && state === "error" ? (
        <p className={styles.error} aria-live="polite">
          {message}
        </p>
      ) : null}
    </form>
  );
}

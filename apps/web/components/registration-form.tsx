import { registrationResponseSchema } from "@agentify/scanner-contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { linkAnswerFailure, waitLabel } from "../lib/link-answer";
import { useVisitor } from "../lib/visitor";
import styles from "./registration-form.module.css";

type RegistrationState = "idle" | "sending" | "sent" | "opening" | "error";

/** The wait is the server's to name; the button never counts down a guess of its own. */
export function registrationSubmitLabel(state: RegistrationState, resendWait: number) {
  if (state === "sending" || state === "opening") return "Sending…";
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

/**
 * The ask for the full report. A stranger types an address and gets a link. A
 * signed-in person is shown the address the report will be filed under before
 * the press, and their ask carries no address, is filed at once and sends
 * nothing. A page that cannot tell who is visiting offers no ask rather than
 * take an address over a session it could not see.
 */
export function RegistrationForm({ scanId }: Readonly<{ scanId: string }>) {
  const visitor = useVisitor();
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
    const signedIn = visitor.status === "signed_in";
    setState("sending");
    const response = await fetch(`/api/v2/scans/${encodeURIComponent(scanId)}/registrations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...(signedIn ? {} : { email: form.get("email") }),
        phone: form.get("phone") || undefined,
        role: form.get("role"),
        site_is_mine: form.get("site_is_mine") === "on",
        marketing_email_opt_in: form.get("marketing_email_opt_in") === "on",
        dataset_reuse_acknowledged: form.get("dataset_reuse_acknowledged") === "on",
      }),
    });
    const payload: unknown = await response.json().catch(() => null);
    const parsed = registrationResponseSchema.safeParse(payload);
    if (response.ok && parsed.success && parsed.data.status === "report_ready") {
      setState("opening");
      window.location.assign(parsed.data.report_url);
      return;
    }
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

  if (visitor.status === "loading")
    return (
      <p aria-live="polite" className={styles.hint}>
        Checking who is visiting…
      </p>
    );
  if (visitor.status === "unknown")
    return (
      <p aria-live="polite" className={styles.error}>
        We cannot tell who is visiting right now, so the full report cannot be asked for. Try again
        in a moment.
      </p>
    );
  const signedIn = visitor.status === "signed_in";

  return (
    <form
      className={styles.form}
      onFocusCapture={markRegistrationStarted}
      onSubmit={(event) => void submit(event)}
    >
      {signedIn ? (
        <p className={styles.lead}>
          You are signed in, so the report will be filed under <strong>{visitor.email}</strong> and
          open here without a message.
        </p>
      ) : (
        <p className={styles.lead}>We email you a secure link to open it. Phone is optional.</p>
      )}
      {state === "sent" ? (
        <div className={styles.sent} aria-live="polite">
          <strong>Check your inbox</strong>
          <p>{sentConfirmationCopy(sentTo)}</p>
        </div>
      ) : null}
      {signedIn ? null : (
        <div>
          <label htmlFor={emailId}>Email</label>
          <input id={emailId} name="email" type="email" autoComplete="email" required />
        </div>
      )}
      <div>
        <label htmlFor={phoneId}>
          Phone <span className={styles.optional}>optional</span>
        </label>
        <input
          aria-describedby={`${phoneId}-hint`}
          autoComplete="tel"
          id={phoneId}
          inputMode="tel"
          name="phone"
          pattern="\+[1-9][0-9 ()-]{7,20}"
          placeholder="+1 415 555 0123"
          type="tel"
        />
        <span className={styles.hint} id={`${phoneId}-hint`}>
          With the country code. We store it as contact information; only your email is verified.
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
        <input name="site_is_mine" type="checkbox" />
        <span>I own or manage this site.</span>
      </label>
      <label className={styles.check}>
        <input name="dataset_reuse_acknowledged" type="checkbox" required />
        <span>
          I acknowledge the{" "}
          <a href="/privacy" rel="noopener" target="_blank">
            scanner data notice
          </a>
          .
        </span>
      </label>
      <label className={styles.check}>
        <input name="marketing_email_opt_in" type="checkbox" />
        <span>Send optional product research updates.</span>
      </label>
      <button
        className="button button-primary"
        disabled={state === "sending" || state === "opening" || resendWait > 0}
        type="submit"
      >
        {signedIn && resendWait === 0 && state !== "opening"
          ? "Open the full report"
          : registrationSubmitLabel(state, resendWait)}
      </button>
      {message && state === "error" ? (
        <p className={styles.error} aria-live="polite">
          {message}
        </p>
      ) : null}
    </form>
  );
}

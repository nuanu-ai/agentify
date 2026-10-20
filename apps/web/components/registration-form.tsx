import { registrationResponseSchema } from "@agentify/scanner-contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { waitLabel } from "../lib/link-answer";
import { press } from "../lib/press";
import { useVisitor } from "../lib/visitor";
import styles from "./registration-form.module.css";

type RegistrationState = "idle" | "sending" | "sent" | "opening" | "error" | "stale";

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
 * the press, and their ask is filed at once and sends nothing. Every ask names
 * the address the page showed or was typed into it: the session can change in
 * another tab while this page stays open, and the route refuses an ask naming
 * an address other than the one signed in now. A page that cannot tell who is
 * visiting offers no ask rather than take an address over a session it could
 * not see.
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
    const email = signedIn ? visitor.email : String(form.get("email") ?? "");
    setState("sending");
    setMessage("");
    const outcome = await press(
      `/api/v2/scans/${encodeURIComponent(scanId)}/registrations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          phone: form.get("phone") || undefined,
          role: form.get("role"),
          site_is_mine: form.get("site_is_mine") === "on",
          marketing_email_opt_in: form.get("marketing_email_opt_in") === "on",
          dataset_reuse_acknowledged: form.get("dataset_reuse_acknowledged") === "on",
        }),
      },
      (answer) => {
        const parsed = registrationResponseSchema.safeParse(answer);
        return parsed.success ? parsed.data : null;
      },
    );
    if (outcome.kind === "done" && outcome.answer.status === "report_ready") {
      setState("opening");
      window.location.assign(outcome.answer.report_url);
      return;
    }
    if (outcome.kind === "done") {
      setState("sent");
      setResendWait(0);
      setSentTo(email);
      return;
    }
    if (outcome.kind === "refused") {
      setState(outcome.refusal.code === "signed_in_as_another_address" ? "stale" : "error");
      setMessage(outcome.refusal.message);
      setResendWait(outcome.refusal.retry_after_seconds ?? 0);
      return;
    }
    setState("error");
    setMessage(
      signedIn
        ? `No answer came back, so we cannot tell whether the report was filed under ${email}. Press “Open the full report” again: if it was filed, the same report opens.`
        : `No answer came back, so we cannot tell whether a link was sent to ${email}. Check your inbox; if no link arrives in a few minutes, ask again.`,
    );
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
  // The site has said this page was loaded for somebody other than who is
  // signed in now, so the page offers only a reload.
  if (state === "stale")
    return (
      <div>
        <p aria-live="polite" className={styles.error}>
          {message}
        </p>
        <p>
          {/* Drawn only after a press, in the browser, so the address is there. */}
          <a href={window.location.href}>Reload this page</a>
        </p>
      </div>
    );

  return (
    <form
      className={styles.form}
      onFocusCapture={markRegistrationStarted}
      onSubmit={(event) => void submit(event)}
    >
      {/* A link comes back to a signed-in form only when the session ended
          before the press, and the site took it as a stranger's. */}
      {signedIn && state === "sent" ? (
        <p className={styles.lead}>
          You are no longer signed in, so we emailed a secure link to{" "}
          <strong>{visitor.email}</strong> instead.
        </p>
      ) : signedIn ? (
        <p className={styles.lead}>
          You are signed in, so the report will be filed under <strong>{visitor.email}</strong> and
          open here without a message.
        </p>
      ) : (
        <p className={styles.lead}>We email you a secure link to open it.</p>
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
        {signedIn &&
        resendWait === 0 &&
        state !== "sending" &&
        state !== "opening" &&
        state !== "sent"
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

import { useVisitor } from "@agentify/ui";
import { useState } from "react";
import { press } from "../lib/press";
import { READING_SIGN_IN } from "../lib/reading-sign-in";

type Action = "unsubscribe" | "access" | "deletion";

/** How a request for a copy stands once the press is answered, as the route says it. */
type Copy =
  | Readonly<{ status: "sent"; sent_to: string; fresh: boolean; minutes_ago: number }>
  | Readonly<{
      status: "pending";
      sent_to: string;
      outcome: "refused" | "no_answer" | "in_progress";
      within_minutes: number;
    }>
  | Readonly<{ status: "unconfirmed"; sent_to: string }>
  | Readonly<{ status: "too_large"; sent_to: string }>
  | Readonly<{ status: "deleted"; sent_to: string }>;

type Done = "requested" | "completed" | "unsubscribed" | Copy;

const isWhole = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

function copyIn(answer: Record<string, unknown>): Copy | null {
  if (typeof answer.sent_to !== "string") return null;
  if (answer.status === "sent" && typeof answer.fresh === "boolean" && isWhole(answer.minutes_ago))
    return answer as Copy;
  if (
    answer.status === "pending" &&
    (answer.outcome === "refused" ||
      answer.outcome === "no_answer" ||
      answer.outcome === "in_progress") &&
    isWhole(answer.within_minutes)
  )
    return answer as Copy;
  return answer.status === "unconfirmed" ||
    answer.status === "too_large" ||
    answer.status === "deleted"
    ? (answer as Copy)
    : null;
}

function doneIn(answer: unknown): Done | null {
  if (typeof answer !== "object" || answer === null) return null;
  const read = answer as Record<string, unknown>;
  if (read.type === "access") return copyIn(read);
  const status = read.status;
  return status === "requested" || status === "completed" || status === "unsubscribed"
    ? status
    : null;
}

const minutes = (count: number): string => (count === 1 ? "1 minute" : `${count} minutes`);

/** What the page says of a request for a copy, from how it stands. */
function copySaid(copy: Copy, privacyEmail: string): string {
  const writeAfter = `If nothing has arrived by then, write to ${privacyEmail}.`;
  if (copy.status === "sent")
    return copy.fresh
      ? `A copy of your data was emailed to ${copy.sent_to} just now. It is a JSON file attached to the message.`
      : `A copy was emailed to ${copy.sent_to} ${copy.minutes_ago === 0 ? "less than a minute" : minutes(copy.minutes_ago)} ago, so it was not sent again. It is the JSON file attached to that message, and you can ask for a new one ten minutes after it was sent.`;
  if (copy.status === "unconfirmed")
    return `No try to email the copy to ${copy.sent_to} was confirmed by the mail service, so we cannot tell whether it arrived. If it has not, write to ${privacyEmail}, or ask again later.`;
  if (copy.status === "too_large")
    return `The copy of the data held for ${copy.sent_to} is too large to send by email, so nothing was sent. Write to ${privacyEmail} for it.`;
  if (copy.status === "deleted")
    return `The data held for ${copy.sent_to} was deleted while the copy was being made, so there is nothing more to send. We cannot tell whether a copy made before the deletion reached you.`;
  const within = minutes(copy.within_minutes);
  if (copy.outcome === "refused")
    return `The mail service did not take the copy just now. It is tried again automatically for the next ${within}, and goes to ${copy.sent_to} as soon as a try works. ${writeAfter}`;
  if (copy.outcome === "no_answer")
    return `No answer came back from sending the copy, so we cannot tell whether it reached ${copy.sent_to}. It is tried again automatically for the next ${within}, and at most one copy arrives. ${writeAfter}`;
  return `A copy for ${copy.sent_to} is already being sent. Tries go on for the next ${within}. ${writeAfter}`;
}

/**
 * What a press whose answer never came, or could not be read, is told: the
 * site may have done it, so the words say how to find out. Unsubscribing only
 * sets a date, and a copy is not mailed twice within ten minutes, so pressing
 * either again is harmless.
 */
function unansweredFor(action: Action, email: string): string {
  if (action === "deletion")
    return `No answer came back, so we cannot tell whether the deletion went through. Reload this page to find out: if it did, your reports are gone and the page asks you to sign in. If it still shows ${email} as signed in, press Delete my data again, and the answer says whether anything is left to delete.`;
  if (action === "access")
    return `No answer came back, so we cannot tell whether a copy was emailed to ${email}. Pressing again is safe: a copy sent in the last ten minutes is not sent again.`;
  return "No answer came back, so we cannot tell whether this went through. Pressing again is safe: the same request is recorded once.";
}

/**
 * The account requests a person makes about their own address, as lines and
 * buttons of the page's message panel.
 *
 * Every press names the address the page was loaded for: a person can sign out
 * and back in as another address while this page stays open, and the press
 * would otherwise act on whoever the cookie names now. The routes refuse a
 * press that names another address, or none.
 */
export function AccountActions(
  props: Readonly<{ mode: "unsubscribe" }> | Readonly<{ mode: "data"; privacyEmail: string }>,
) {
  const { mode } = props;
  const visitor = useVisitor();
  const [message, setMessage] = useState("");
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);
  const [busy, setBusy] = useState(false);
  // Set once the site has said this page was loaded for somebody other than
  // who is signed in now; from then on the page offers only a reload.
  const [stale, setStale] = useState(false);
  if (visitor.status === "loading") return <p aria-busy="true">Finding out who is signed in…</p>;
  if (visitor.status === "unknown")
    return <p>We cannot tell who is visiting right now. Reload this page in a moment.</p>;
  if (visitor.status === "signed_out")
    return (
      <>
        <p>Sign in with the address your reports were sent to, then come back to this page.</p>
        <a className="button button-primary" href={READING_SIGN_IN}>
          Sign in
        </a>
      </>
    );
  const email = visitor.email;
  async function act(action: Action) {
    const endpoint =
      action === "unsubscribe" ? "/api/v1/account/unsubscribe" : "/api/v1/account/data-request";
    setBusy(true);
    const outcome = await press(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "unsubscribe"
            ? { signed_in_as: email }
            : { type: action, signed_in_as: email },
        ),
      },
      doneIn,
    );
    setBusy(false);
    if (outcome.kind === "done") {
      setConfirmingDeletion(false);
      if (typeof outcome.answer === "object") {
        setMessage(copySaid(outcome.answer, props.mode === "data" ? props.privacyEmail : ""));
        return;
      }
      setMessage(
        outcome.answer === "completed"
          ? "Deletion completed. Your reports, shares, and personal data were anonymized; your sign-in was removed unless it holds a seller dashboard."
          : action === "deletion"
            ? "Report access is closed. Deletion was requested and will finish automatically."
            : "Unsubscribed from marketing email.",
      );
      return;
    }
    if (outcome.kind === "refused") {
      setMessage(outcome.refusal.message);
      if (outcome.refusal.code === "page_not_matched") setStale(true);
      return;
    }
    setMessage(unansweredFor(action, email));
  }
  if (stale)
    return (
      <>
        <p aria-live="polite">{message}</p>
        <p>
          {/* Drawn only after a press, in the browser, so the address is there. */}
          <a href={window.location.href}>Reload this page</a>
        </p>
      </>
    );
  return (
    <>
      <p>
        Signed in as <strong>{email}</strong>.
      </p>
      {mode === "unsubscribe" ? (
        <div className="message-actions">
          <button
            className="button button-primary"
            disabled={busy}
            onClick={() => void act("unsubscribe")}
            type="button"
          >
            Unsubscribe from marketing
          </button>
        </div>
      ) : confirmingDeletion ? (
        <>
          <p>
            For {email}, this closes report access and public shares and anonymizes your data for
            good. Your sign-in goes too, unless it holds a seller dashboard.
          </p>
          <div className="message-actions">
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => void act("deletion")}
              type="button"
            >
              {busy ? "Deleting…" : "Confirm deletion"}
            </button>
            <button
              className="button button-secondary"
              disabled={busy}
              onClick={() => setConfirmingDeletion(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="message-actions">
          <button
            className="button button-primary"
            disabled={busy}
            onClick={() => void act("access")}
            type="button"
          >
            {busy ? "Sending…" : "Request data access"}
          </button>
          {/* Irreversible, so never the primary press until it is confirmed. */}
          <button
            className="button button-secondary"
            onClick={() => setConfirmingDeletion(true)}
            type="button"
          >
            Delete my data
          </button>
        </div>
      )}
      <p aria-live="polite" className="message-answer">
        {message}
      </p>
    </>
  );
}

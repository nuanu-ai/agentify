import { useVisitor } from "@agentify/ui";
import { useState } from "react";
import { press } from "../lib/press";

type Action = "unsubscribe" | "access" | "deletion";
type Done = "requested" | "completed" | "unsubscribed";

function doneIn(answer: unknown): Done | null {
  const status = (answer as { status?: unknown } | null)?.status;
  return status === "requested" || status === "completed" || status === "unsubscribed"
    ? status
    : null;
}

/**
 * What a press whose answer never came, or could not be read, is told: the
 * site may have done it, so the words say how to find out. Asking for access
 * and unsubscribing only set a date, so pressing again is harmless.
 */
function unansweredFor(action: Action, email: string): string {
  if (action === "deletion")
    return `No answer came back, so we cannot tell whether the deletion went through. Reload this page to find out: if it did, your reports are gone and the page asks you to sign in. If it still shows ${email} as signed in, press Delete my data again, and the answer says whether anything is left to delete.`;
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
export function AccountActions({ mode }: { mode: "unsubscribe" | "data" }) {
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
        <a className="button button-primary" href="/dashboard/sign-in">
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
      setMessage(
        outcome.answer === "completed"
          ? "Deletion completed. Your reports, shares, and personal data were anonymized; your sign-in was removed unless it holds a seller dashboard."
          : action === "deletion"
            ? "Report access is closed. Deletion was requested and will finish automatically."
            : action === "unsubscribe"
              ? "Unsubscribed from marketing email."
              : "Request recorded.",
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
            className="button button-secondary"
            disabled={busy}
            onClick={() => void act("access")}
            type="button"
          >
            Request data access
          </button>
          <button
            className="button button-primary"
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

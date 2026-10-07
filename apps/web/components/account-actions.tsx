"use client";

import { useState } from "react";

import { useVisitor } from "../lib/visitor";

/** What a press that got no answer the page can read is told. */
const NOTHING_CHANGED = "Nothing was changed, because the site did not answer. Try again shortly.";

/**
 * The account requests a person makes about their own address.
 *
 * They say which address they act for and send it with every press, because
 * people sign out to come back as another address (ADR-0026 §3): this page,
 * loaded for the first, can still be open when the second signs in, and its
 * press would otherwise act on whoever the cookie names now. The routes refuse
 * a press that names another address, or none. With nobody signed in, or
 * nobody able to tell, there is nothing here to press.
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
    return (
      <p>
        We cannot tell who is visiting right now, so there is nothing to press here yet. Reload this
        page shortly.
      </p>
    );
  if (visitor.status === "signed_out")
    return (
      <p>
        <a href="/dashboard/sign-in">Sign in</a> with the address your reports were sent to, then
        come back to this page.
      </p>
    );
  const email = visitor.email;
  async function act(action: "unsubscribe" | "access" | "deletion") {
    const endpoint =
      action === "unsubscribe" ? "/api/v1/account/unsubscribe" : "/api/v1/account/data-request";
    setBusy(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "unsubscribe"
            ? { signed_in_as: email }
            : { type: action, signed_in_as: email },
        ),
      });
      const payload = (await response.json().catch(() => null)) as {
        status?: "requested" | "completed";
        error?: { code?: string; message?: string };
      } | null;
      setMessage(
        response.ok
          ? payload?.status === "completed"
            ? "Deletion completed. Card/provider state was cleared first, then your reports, shares, and personal data were anonymized; your sign-in was removed unless it holds a seller dashboard."
            : action === "deletion"
              ? "Report access is closed. Deletion was requested and will finish automatically."
              : "Request recorded."
          : (payload?.error?.message ?? NOTHING_CHANGED),
      );
      if (response.ok) setConfirmingDeletion(false);
      if (payload?.error?.code === "page_not_matched") setStale(true);
    } catch {
      setMessage(NOTHING_CHANGED);
    } finally {
      setBusy(false);
    }
  }
  if (stale)
    return (
      <div>
        <p aria-live="polite">{message}</p>
        <p>
          {/* Drawn only after a press, in the browser, so the address is there. */}
          <a href={window.location.href}>Reload this page</a>
        </p>
      </div>
    );
  return (
    <div>
      <p>
        Signed in as <strong>{email}</strong>. What you press here is for this address.
      </p>
      {mode === "unsubscribe" ? (
        <button
          className="button button-primary"
          disabled={busy}
          onClick={() => void act("unsubscribe")}
          type="button"
        >
          Unsubscribe from marketing
        </button>
      ) : (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button
            className="button button-secondary"
            disabled={busy}
            onClick={() => void act("access")}
            type="button"
          >
            Request data access
          </button>
          {!confirmingDeletion ? (
            <button
              className="button button-primary"
              onClick={() => setConfirmingDeletion(true)}
              type="button"
            >
              Delete my data
            </button>
          ) : (
            <div>
              <p>
                For {email}, this closes report access and revokes shares, removes any saved card,
                and irreversibly anonymizes your lead and owned scan identifiers. Your sign-in goes
                too, unless it holds a seller dashboard.
              </p>
              <button
                className="button button-primary"
                disabled={busy}
                onClick={() => void act("deletion")}
                type="button"
              >
                {busy ? "Deleting…" : "Confirm deletion"}
              </button>{" "}
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={() => setConfirmingDeletion(false)}
                type="button"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
      <p aria-live="polite">{message}</p>
    </div>
  );
}

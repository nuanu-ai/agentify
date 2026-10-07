"use client";

import { useState } from "react";

import { useVisitor } from "../lib/visitor";

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
  if (visitor.status === "loading") return <p aria-busy="true" />;
  if (visitor.status === "unknown")
    return (
      <p>
        We cannot tell who is visiting right now, so there is nothing to press here yet. Try again
        shortly.
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
        error?: { message?: string };
      } | null;
      setMessage(
        response.ok
          ? payload?.status === "completed"
            ? "Deletion completed. Card/provider state was cleared first, then your reports, shares, and personal data were anonymized; your sign-in was removed unless it holds a seller dashboard."
            : action === "deletion"
              ? "Report access is closed. Deletion was requested and will finish automatically."
              : "Request recorded."
          : (payload?.error?.message ??
              "Sign in with the address your reports were sent to before making this request."),
      );
      if (response.ok) setConfirmingDeletion(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <p>
        Signed in as <strong>{email}</strong>. What you press here is for this address.
      </p>
      {mode === "unsubscribe" ? (
        <button
          className="button button-primary"
          onClick={() => void act("unsubscribe")}
          type="button"
        >
          Unsubscribe from marketing
        </button>
      ) : (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button
            className="button button-secondary"
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

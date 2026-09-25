"use client";

import { useState } from "react";

export function AccountActions({ mode }: { mode: "unsubscribe" | "data" }) {
  const [message, setMessage] = useState("");
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);
  const [busy, setBusy] = useState(false);
  async function act(action: "unsubscribe" | "access" | "deletion") {
    const endpoint =
      action === "unsubscribe" ? "/api/v1/account/unsubscribe" : "/api/v1/account/data-request";
    setBusy(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: action === "unsubscribe" ? "{}" : JSON.stringify({ type: action }),
      });
      const payload = (await response.json().catch(() => null)) as {
        status?: "requested" | "completed";
        error?: { message?: string };
      } | null;
      setMessage(
        response.ok
          ? payload?.status === "completed"
            ? "Deletion completed. Card/provider state was cleared first, then your reports, shares, and personal data were anonymized; your sign-in was removed unless it holds a merchant cabinet."
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
                This closes report access and revokes shares, removes any saved card, and
                irreversibly anonymizes your lead and owned scan identifiers. Your sign-in goes too,
                unless it holds a merchant cabinet.
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

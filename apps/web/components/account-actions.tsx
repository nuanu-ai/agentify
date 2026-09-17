"use client";

import { useState } from "react";

export function AccountActions({ mode }: { mode: "unsubscribe" | "data" }) {
  const [message, setMessage] = useState("");
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);
  const [busy, setBusy] = useState(false);
  async function act(action: "unsubscribe" | "access" | "deletion") {
    const endpoint =
      action === "unsubscribe"
        ? "/api/v1/account/unsubscribe"
        : "/api/v1/account/data-request";
    setBusy(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:
          action === "unsubscribe" ? "{}" : JSON.stringify({ type: action }),
      });
      const payload = (await response.json().catch(() => null)) as {
        status?: "requested" | "completed";
        error?: { message?: string };
      } | null;
      setMessage(
        response.ok
          ? payload?.status === "completed"
            ? "Deletion completed. Card/provider state was cleared first, then report sessions, shares, and personal data were anonymized."
            : action === "deletion"
              ? "Report access is revoked. Deletion was requested and will finish automatically."
              : "Request recorded."
          : (payload?.error?.message ??
              "Sign in through a verified report before making this request."),
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
                This revokes report access and shares, removes any saved card,
                and irreversibly anonymizes your lead and owned scan
                identifiers.
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

"use client";

import React, { useEffect, useRef, useState } from "react";

import { sharePreviewResponseSchema } from "@b2a/contracts";

import type { PublicResultPreview } from "./public-result-card";
import styles from "./public-share-actions.module.css";

type PublishedShare = Readonly<{ slug: string; url: string }>;
type ScopedPublishedShare = Readonly<{
  scanId: string;
  value: PublishedShare;
}>;
type ActionState = "idle" | "publishing" | "published" | "revoking";

export function PublicShareActions({
  enabled,
  preview,
  scanId,
  tokenStorageKey,
}: Readonly<{
  enabled: boolean;
  preview: Omit<PublicResultPreview, "hostLabel" | "scannedLabel" | "score"> & {
    hostLabel: string | null;
    score: number | null;
  };
  scanId: string;
  tokenStorageKey?: string;
}>) {
  const [actionState, setActionState] = useState<ActionState>("idle");
  const [published, setPublished] = useState<ScopedPublishedShare>();
  const [message, setMessage] = useState("");
  const [manualCopy, setManualCopy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resolvedPreview, setResolvedPreview] = useState<
    Readonly<{ scanId: string; value: PublicResultPreview }> | undefined
  >();
  const exactPreview =
    resolvedPreview?.scanId === scanId ? resolvedPreview.value : undefined;
  const currentPublished =
    published?.scanId === scanId ? published.value : undefined;
  const copyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!manualCopy) return;
    copyRef.current?.focus();
    copyRef.current?.select();
  }, [manualCopy]);

  useEffect(() => {
    if (!enabled || preview.score === null || exactPreview) return;
    let active = true;
    const load = async () => {
      setMessage("Preparing the exact public preview…");
      try {
        const storedToken = tokenStorageKey
          ? sessionStorage.getItem(tokenStorageKey)
          : null;
        const fragmentToken = new URLSearchParams(
          window.location.hash.slice(1),
        ).get("access_token");
        const response = await fetch(
          `/api/v1/scans/${encodeURIComponent(scanId)}/share-preview`,
          {
            cache: "no-store",
            credentials: "same-origin",
            headers: shareRequestHeaders(storedToken ?? fragmentToken, false),
          },
        );
        const parsed = parseSharePreviewResponse(
          await response.json().catch(() => null),
          window.location.origin,
        );
        if (!response.ok || !parsed) throw new Error("share_preview_failed");
        if (active) {
          setResolvedPreview({ scanId, value: parsed.preview });
          if (parsed.existingShare) {
            const restored = parsed.existingShare;
            setPublished((current) =>
              current?.scanId === scanId
                ? current
                : { scanId, value: restored },
            );
          }
          setMessage("");
        }
      } catch {
        if (active)
          setMessage(
            "The exact public preview could not be loaded. Publishing remains disabled.",
          );
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [enabled, exactPreview, preview.score, scanId, tokenStorageKey]);

  if (!enabled || preview.score === null) return null;

  const token = () =>
    tokenStorageKey ? sessionStorage.getItem(tokenStorageKey) : null;

  async function ensurePublished(): Promise<PublishedShare> {
    if (currentPublished) return currentPublished;
    if (!exactPreview) throw new Error("share_preview_unavailable");
    setActionState("publishing");
    setManualCopy(false);
    setCopied(false);
    const response = await fetch(
      `/api/v1/scans/${encodeURIComponent(scanId)}/share`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: shareRequestHeaders(token(), true),
        body: JSON.stringify({ allow_indexing: false }),
      },
    );
    const share = validatePublishedShare(
      await response.json().catch(() => null),
      window.location.origin,
    );
    if (!response.ok || !share) throw new Error("share_publish_failed");
    setPublished({ scanId, value: share });
    setActionState("published");
    return share;
  }

  async function copyLink(
    share: PublishedShare,
    successMessage = "Public link copied. It is live and remains noindex.",
  ) {
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(share.url);
      setManualCopy(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      setMessage(successMessage);
      return true;
    } catch {
      setCopied(false);
      setManualCopy(true);
      setMessage(
        "Clipboard access is unavailable. Copy the selected link below.",
      );
      return false;
    }
  }

  async function publishAndCopy() {
    setMessage("Preparing and copying your public link…");
    try {
      const share = await ensurePublished();
      await copyLink(share);
    } catch {
      setActionState("idle");
      setMessage("The public link could not be prepared. Try again.");
    }
  }

  async function downloadImage() {
    setMessage("Preparing your share image…");
    try {
      const share = await ensurePublished();
      const anchor = document.createElement("a");
      anchor.href = `/api/v1/shares/${encodeURIComponent(share.slug)}/image`;
      anchor.download = "";
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setActionState("published");
      setMessage(
        "Image download started. The public link is live and noindex.",
      );
    } catch {
      setActionState("idle");
      setMessage("The share image could not be prepared. Try again.");
    }
  }

  async function revoke() {
    if (!currentPublished) return;
    setActionState("revoking");
    setMessage("Revoking the public link…");
    try {
      const response = await fetch(
        `/api/v1/shares/${encodeURIComponent(currentPublished.slug)}`,
        {
          method: "DELETE",
          credentials: "same-origin",
          headers: shareRequestHeaders(token(), false),
        },
      );
      if (!response.ok) throw new Error("share_revoke_failed");
      setPublished(undefined);
      setManualCopy(false);
      setCopied(false);
      setActionState("idle");
      setMessage("Public link revoked.");
    } catch {
      setActionState("published");
      setMessage("The public link could not be revoked. Try again.");
    }
  }

  const busy = actionState === "publishing" || actionState === "revoking";

  return (
    <div className={styles.bar}>
      <div className={styles.actions}>
        <button
          className={`button button-primary ${styles.primaryAction}`}
          disabled={busy || !exactPreview}
          onClick={() => void publishAndCopy()}
          type="button"
        >
          {actionState === "publishing"
            ? "Preparing…"
            : copied
              ? "Copied"
              : "Copy share link"}
        </button>
        <button
          className="button button-secondary"
          disabled={busy || !exactPreview}
          onClick={() => void downloadImage()}
          type="button"
        >
          Download image
        </button>
        {currentPublished ? (
          <span className={styles.meta}>
            <span className={styles.live}>
              <span aria-hidden="true" className={styles.dot} />
              Public link live
            </span>
            <button
              className={styles.revoke}
              disabled={busy}
              onClick={() => void revoke()}
              type="button"
            >
              {actionState === "revoking" ? "Revoking…" : "Revoke"}
            </button>
          </span>
        ) : null}
      </div>
      <span aria-live="polite" className={styles.status}>
        {message}
      </span>
      {manualCopy && currentPublished ? (
        <div className={styles.manualCopy}>
          <label htmlFor={`share-link-${scanId}`}>Public link</label>
          <textarea
            id={`share-link-${scanId}`}
            onFocus={(event) => event.currentTarget.select()}
            readOnly
            ref={copyRef}
            rows={3}
            value={currentPublished.url}
          />
        </div>
      ) : null}
    </div>
  );
}

export function shareRequestHeaders(
  token: string | null,
  includeContentType: boolean,
) {
  return {
    ...(includeContentType ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function validatePublishedShare(
  payload: unknown,
  expectedOrigin: string,
): PublishedShare | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (
    typeof record.slug !== "string" ||
    !/^[A-Za-z0-9_-]{20,200}$/.test(record.slug) ||
    typeof record.public_url !== "string"
  )
    return null;
  try {
    const url = new URL(record.public_url, expectedOrigin);
    if (
      url.origin !== expectedOrigin ||
      url.pathname !== `/s/${record.slug}` ||
      url.search ||
      url.hash
    )
      return null;
    return { slug: record.slug, url: url.toString() };
  } catch {
    return null;
  }
}

export function parseSharePreviewResponse(
  payload: unknown,
  expectedOrigin: string,
): Readonly<{
  preview: PublicResultPreview;
  existingShare: PublishedShare | null;
}> | null {
  const parsed = sharePreviewResponseSchema.safeParse(payload);
  if (!parsed.success) return null;
  return {
    preview: {
      hostLabel: parsed.data.host,
      level: parsed.data.level,
      score: parsed.data.score,
    },
    existingShare: parsed.data.existing_share
      ? validatePublishedShare(parsed.data.existing_share, expectedOrigin)
      : null,
  };
}

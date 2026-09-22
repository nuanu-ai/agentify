"use client";

import { remediationPromptResponseSchema } from "@agentify/scanner-contracts";
import { useId, useRef, useState } from "react";

import {
  type ResumeIntent as GateIntent,
  rememberResumeIntent,
} from "../lib/resume-intent";
import styles from "./copy-remediation-prompt.module.css";

type CopyState = "idle" | "loading" | "copied" | "fallback" | "error" | "gated";

export function gateStatusMessage(intent: GateIntent) {
  return intent === "download-md"
    ? "Confirm your email in the highlighted form below — the download starts right after verification."
    : "Confirm your email in the highlighted form below — the prompt will be ready on your report.";
}

export function revealRegistrationGate(targetId: string) {
  const target = document.getElementById(targetId);
  if (!target) return false;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.setAttribute("data-gate-highlight", "true");
  window.setTimeout(() => target.removeAttribute("data-gate-highlight"), 2_400);
  target.querySelector<HTMLInputElement>('input[type="email"]')?.focus({
    preventScroll: true,
  });
  return true;
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.checkIcon}
      fill="none"
      height="16"
      viewBox="0 0 16 16"
      width="16"
    >
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

export function CopyRemediationPrompt({
  allowDownload = false,
  contactGateScanId,
  downloadUrl,
  gateTargetId = "registration",
  label,
  prompt,
  promptUrl,
  tokenStorageKey,
  secondary = false,
  small = false,
}: Readonly<{
  allowDownload?: boolean;
  contactGateScanId?: string;
  downloadUrl?: string;
  gateTargetId?: string;
  label: string;
  prompt?: string;
  promptUrl?: string;
  secondary?: boolean;
  small?: boolean;
  tokenStorageKey?: string;
}>) {
  const [state, setState] = useState<CopyState>("idle");
  const [resolvedPrompt, setResolvedPrompt] = useState(prompt ?? "");
  const [gateIntent, setGateIntent] = useState<GateIntent>("copy-prompt");
  const textareaId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  async function copy() {
    let content: string;
    try {
      setState("loading");
      if (!(await ensureContactAccess("copy-prompt"))) return;
      content = await resolvePrompt();
    } catch {
      setState("error");
      return;
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_missing");
      await navigator.clipboard.writeText(content);
      setState("copied");
      window.setTimeout(
        () => setState((current) => (current === "copied" ? "idle" : current)),
        2000,
      );
    } catch {
      setState("fallback");
      window.setTimeout(() => {
        textareaRef.current?.focus();
        textareaRef.current?.select();
      });
    }
  }

  async function resolvePrompt(): Promise<string> {
    if (promptUrl) {
      const token = tokenStorageKey
        ? sessionStorage.getItem(tokenStorageKey)
        : undefined;
      const response = await fetch(promptUrl, {
        cache: "no-store",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      const payload: unknown = await response.json().catch(() => null);
      const parsed = remediationPromptResponseSchema.safeParse(payload);
      if (response.ok && parsed.success) {
        setResolvedPrompt(parsed.data.content);
        return parsed.data.content;
      }
    }
    if (prompt) {
      setResolvedPrompt(prompt);
      return prompt;
    }
    throw new Error("prompt_unavailable");
  }

  async function ensureContactAccess(intent: GateIntent): Promise<boolean> {
    if (!contactGateScanId) return true;
    const response = await fetch(
      `/api/v2/scans/${encodeURIComponent(contactGateScanId)}/contact-access`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (response.ok) return true;
    if (response.status === 401) {
      setGateIntent(intent);
      setState("gated");
      rememberResumeIntent(contactGateScanId, intent);
      revealRegistrationGate(gateTargetId);
      return false;
    }
    throw new Error("contact_access_unavailable");
  }

  async function download() {
    try {
      setState("loading");
      if (!(await ensureContactAccess("download-md"))) return;
      if (!downloadUrl) throw new Error("download_url_missing");
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = "";
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setState("idle");
    } catch {
      setState("error");
    }
  }

  const buttonClass = `${styles.button} ${small ? styles.small : ""}`;

  return (
    <div className={styles.wrap}>
      <div className={styles.actions}>
        <button
          className={`${buttonClass} ${secondary ? styles.secondary : styles.primary}`}
          disabled={state === "loading"}
          onClick={() => void copy()}
          type="button"
        >
          {state === "copied" ? (
            <>
              <CheckIcon /> Copied
            </>
          ) : state === "loading" ? (
            "Preparing…"
          ) : (
            label
          )}
        </button>
        {allowDownload ? (
          <button
            className={`${buttonClass} ${styles.download}`}
            disabled={state === "loading"}
            onClick={() => void download()}
            type="button"
          >
            Download .md
          </button>
        ) : null}
      </div>
      <span aria-live="polite" className={styles.status}>
        {state === "copied"
          ? "Prompt copied to your clipboard."
          : state === "gated"
            ? gateStatusMessage(gateIntent)
            : state === "fallback"
              ? "Clipboard access was unavailable. The prompt is selected below for manual copying."
              : state === "error"
                ? "The prompt could not be prepared. Check your access and try again."
                : ""}
      </span>
      {state === "fallback" ? (
        <div className={styles.fallback}>
          <label htmlFor={textareaId}>Fix prompt</label>
          <textarea
            id={textareaId}
            onFocus={(event) => event.currentTarget.select()}
            readOnly
            ref={textareaRef}
            rows={8}
            value={resolvedPrompt}
          />
        </div>
      ) : null}
    </div>
  );
}

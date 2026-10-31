import { useEffect, useRef, useState } from "react";

type Copied = "idle" | "copied" | "failed";

/** How long the button says it copied before it is ready again. */
const SAID_FOR_MS = 2_000;

/**
 * Copying needs the page's script and a browser that lets the page write to
 * the clipboard; where either is missing the press says it could not copy.
 */
export const useCopy = (value: string) => {
  const [copied, setCopied] = useState<Copied>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
      timer.current = setTimeout(() => setCopied("idle"), SAID_FOR_MS);
    } catch {
      setCopied("failed");
    }
  };
  return { copied, copy: () => void copy() };
};

export const Tick = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <path d="m5 12 5 5L20 7" />
  </svg>
);

export const SAID: Readonly<Record<Copied, string>> = {
  idle: "",
  copied: "Copied",
  failed: "Could not copy; select it",
};

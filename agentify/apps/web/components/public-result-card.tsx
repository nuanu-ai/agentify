import type { DiagnosticLevel } from "@b2a/contracts";
import React from "react";

import { Brand } from "./brand";
import styles from "./public-result-card.module.css";

export type PublicResultPreview = Readonly<{
  hostLabel: string;
  level: DiagnosticLevel;
  score: number;
  scannedLabel?: string;
}>;

const ZONES = [
  { key: "invisible", label: "Invisible" },
  { key: "readable", label: "Readable" },
  { key: "callable_ready", label: "Callable-ready" },
  { key: "ahead_of_market", label: "Ahead of the market" },
] as const;

export function PublicResultCard({
  compact = false,
  headingLevel = 2,
  preview,
}: Readonly<{
  compact?: boolean;
  headingLevel?: 1 | 2;
  preview: PublicResultPreview;
}>) {
  const score = Math.max(0, Math.min(100, preview.score));
  const Heading = headingLevel === 1 ? "h1" : "h2";

  return (
    <article
      aria-label="Public result card"
      className={`${styles.card} ${compact ? styles.compact : ""}`}
    >
      <header className={styles.header}>
        <Brand />
        <span>{preview.scannedLabel ?? "Preview before publishing"}</span>
      </header>
      <div className={styles.body}>
        <p className={styles.host}>{preview.hostLabel}</p>
        <div className={styles.result}>
          <Heading>{formatLevel(preview.level)}</Heading>
          <strong>
            {score}
            <small>/100</small>
          </strong>
        </div>
        <div
          aria-label={`Diagnostic score ${score} out of 100`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={score}
          className={styles.scale}
          role="meter"
        >
          <span className={styles.fill} style={{ width: `${score}%` }} />
          <i style={{ left: "25%" }} />
          <i style={{ left: "50%" }} />
          <i style={{ left: "70%" }} />
        </div>
        <div className={styles.labels}>
          {ZONES.map((zone) => (
            <span
              className={zone.key === preview.level ? styles.active : undefined}
              key={zone.key}
            >
              {zone.label}
            </span>
          ))}
        </div>
        <p className={styles.disclosure}>
          Only the domain, level, score, scale and scan date are public.
          Detailed findings and contact details stay private.
          {preview.level === "callable_ready"
            ? " Callable-ready describes discovery metadata; tool execution was not tested."
            : ""}
        </p>
      </div>
    </article>
  );
}

export function formatLevel(level: DiagnosticLevel) {
  return (
    {
      invisible: "Invisible",
      readable: "Readable",
      callable_ready: "Callable-ready",
      ahead_of_market: "Ahead of the market",
      incomplete: "Incomplete",
    } as const
  )[level];
}

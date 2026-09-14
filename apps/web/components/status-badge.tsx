import type { CheckStatus } from "@agentify/scanner-contracts";
import React from "react";

import styles from "./status-badge.module.css";

type BadgeStatus = CheckStatus | "complete";

const STATUS_LABELS: Record<BadgeStatus, string> = {
  pending: "pending",
  running: "checking",
  pass: "pass",
  partial: "partial",
  fail: "fail",
  unavailable: "unavailable",
  not_applicable: "n/a",
  complete: "complete",
};

export function StatusBadge({ status }: Readonly<{ status: BadgeStatus }>) {
  return (
    <span className={`${styles.badge} ${styles[status]}`}>
      <span aria-hidden="true" className={styles.dot} />
      {STATUS_LABELS[status]}
    </span>
  );
}

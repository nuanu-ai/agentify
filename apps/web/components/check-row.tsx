import type { ReactNode } from "react";

import styles from "./check-row.module.css";

/**
 * One check, finding or observation as a line of a list: what it is, and its
 * state at the end of the line, in a slot of one width on every row so the
 * states of a list read down one column. What it found sits under the line,
 * shown there, or folded under it where `fold` says whether it starts open.
 */
export function CheckRow({
  detail,
  fold,
  number,
  state,
  title,
}: Readonly<{
  detail?: ReactNode;
  fold?: "open" | "closed";
  number?: number;
  state: ReactNode;
  title: ReactNode;
}>) {
  const className = number === undefined ? styles.row : `${styles.row} ${styles.numbered}`;
  const line = (
    <>
      <span className={styles.title}>
        {number === undefined ? null : (
          <span className={styles.number}>{String(number).padStart(2, "0")}</span>
        )}
        {title}
      </span>
      <span className="badge-slot">{state}</span>
    </>
  );
  if (detail === undefined)
    return (
      <div className={className}>
        <div className={styles.line}>{line}</div>
      </div>
    );
  if (fold === undefined)
    return (
      <div className={className}>
        <div className={styles.line}>{line}</div>
        <div className={styles.detail}>{detail}</div>
      </div>
    );
  return (
    <details className={className} open={fold === "open"}>
      <summary className={styles.line}>{line}</summary>
      <div className={styles.detail}>{detail}</div>
    </details>
  );
}

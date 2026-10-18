import type { DiagnosticLevel } from "@agentify/scanner-contracts";
import type { ReactNode } from "react";

import { LEVEL_LABELS, PROVISIONAL_BELOW } from "../lib/levels";
import styles from "./result-head.module.css";

/**
 * The head a scan's result and its report both open with: the site and what
 * this page of it is, the level and the score on their scale, and what the
 * level is not. `caption` is said after "not a certification", on its line.
 */
export function ResultHead({
  caption,
  coverage,
  host,
  level,
  line,
  score,
}: Readonly<{
  caption?: ReactNode;
  coverage: number;
  host: string;
  level: DiagnosticLevel;
  line: ReactNode;
  score: number | null;
}>) {
  const provisional = coverage < PROVISIONAL_BELOW || level === "incomplete";
  return (
    <>
      <p className={styles.site}>
        <b>{host}</b>
        <span>{line}</span>
      </p>
      <span className={`eyebrow ${styles.eyebrow}`}>
        {provisional ? "Provisional diagnostic" : "Diagnostic level"}
      </span>
      <div className={styles.verdict}>
        <h1>{LEVEL_LABELS[level]}</h1>
        {score === null ? (
          <strong className={styles.score}>
            <span aria-hidden="true">—</span>
            <span className="sr-only">No score</span>
            <small>/100</small>
          </strong>
        ) : (
          <strong className={styles.score}>
            {score}
            <small>/100</small>
          </strong>
        )}
      </div>
      {score === null ? null : <ScoreScale score={score} />}
      <p className={styles.caption}>
        <span>
          Diagnostic level, not a certification
          {caption ? <> · {caption}</> : null}
        </span>
        <span>Coverage {Math.round(coverage * 100)}%</span>
      </p>
      {level === "callable_ready" ? (
        <p className={styles.note}>
          Callable-ready describes public discovery metadata. Agentify did not invoke tools or
          verify authenticated actions.
        </p>
      ) : null}
    </>
  );
}

/** The score on the scale, its marks where one level ends and the next begins. */
function ScoreScale({ score }: Readonly<{ score: number }>) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the custom meter draws the levels' bounds alongside its fill; its value and bounds are exposed here
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
  );
}

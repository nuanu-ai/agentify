import type { ScanStatusResponse } from "@agentify/scanner-contracts";

import { robotsHeadline } from "../lib/robots-notice";
import layout from "./result-layout.module.css";
import { RobotsNotice } from "./robots-notice";
import styles from "./scan-experience.module.css";

/** Why a scan ended without a result, and the way to try again. */
export function ScanFailed({
  blocked,
  checks,
  onRetry,
}: Readonly<{
  blocked: boolean;
  checks: ScanStatusResponse["checks"];
  onRetry: () => void;
}>) {
  const headline = robotsHeadline(checks);
  return (
    <div className={`${layout.message} ${styles.state}`}>
      <h1
        data-access-blocked={!headline && blocked ? "" : undefined}
        data-robots-headline={headline ?? undefined}
      >
        {headline === "disallowed"
          ? "Your robots.txt kept the scanner out"
          : headline === "unassessed"
            ? "The scanner could not assess your robots.txt"
            : blocked
              ? "The site blocked our reader"
              : "No reliable diagnostic was produced"}
      </h1>
      <RobotsNotice checks={checks} className={layout.note} />
      {headline ? null : (
        <p>
          {blocked
            ? "The site answered the scanner's request for its home page with a bot challenge or a refusal. What could be read around it is what the site shows a reader it turns away, so no score is given."
            : "Coverage stayed below the minimum for an honest result. This can happen after a timeout, access block, or scanner failure."}
        </p>
      )}
      <button className="button button-primary" onClick={onRetry} type="button">
        Try again
      </button>
    </div>
  );
}

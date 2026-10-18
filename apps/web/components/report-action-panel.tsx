import { useEffect, useState } from "react";

import { type ResumeIntent, takeResumeIntent } from "../lib/resume-intent";
import { CopyRemediationPrompt } from "./copy-remediation-prompt";
import type { PublicResultPreview } from "./public-result-card";
import { PublicShareActions } from "./public-share-actions";
import styles from "./report-action-panel.module.css";
import { columnsFor } from "./report-actions";
import row from "./report-actions.module.css";

export function ReportActionPanel({
  aiPrompt,
  devBrief,
  downloadUrl,
  initialIntent,
  preview,
  promptEnabled,
  scanId,
  shareEnabled,
}: Readonly<{
  aiPrompt: string;
  devBrief: string;
  downloadUrl: string;
  initialIntent?: ResumeIntent;
  preview: Omit<PublicResultPreview, "hostLabel" | "scannedLabel" | "score"> & {
    hostLabel: string | null;
    score: number | null;
  };
  promptEnabled: boolean;
  scanId: string;
  shareEnabled: boolean;
}>) {
  const [intent, setIntent] = useState<ResumeIntent | null>(initialIntent ?? null);
  const [downloadStarted, setDownloadStarted] = useState(false);

  useEffect(() => {
    if (initialIntent) return;
    const stored = takeResumeIntent(scanId);
    if (stored) setIntent(stored);
  }, [initialIntent, scanId]);

  useEffect(() => {
    if (!promptEnabled || intent !== "download-md" || downloadStarted) return;
    setDownloadStarted(true);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = "";
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }, [downloadStarted, downloadUrl, intent, promptEnabled]);

  const shareShown = shareEnabled && preview.score !== null;
  if (!shareShown && !promptEnabled) return null;

  return (
    <div className={row.share}>
      {promptEnabled && intent ? (
        <p aria-live="polite" className={styles.verified}>
          <span aria-hidden="true" className={styles.dot} />
          {intent === "download-md" ? (
            <>
              Verified — your .md download started.{" "}
              <a download href={downloadUrl}>
                Download again
              </a>
            </>
          ) : (
            "Verified — your AI fix prompt is ready below."
          )}
        </p>
      ) : null}
      <div
        className={row.row}
        data-columns={columnsFor((shareShown ? 2 : 0) + (promptEnabled ? 3 : 0))}
      >
        {shareShown ? (
          <PublicShareActions enabled={shareEnabled} preview={preview} scanId={scanId} />
        ) : null}
        {promptEnabled ? (
          <CopyRemediationPrompt
            allowDownload
            downloadUrl={downloadUrl}
            label="Copy AI fix prompt"
            prompt={aiPrompt}
            secondary
          />
        ) : null}
        {promptEnabled ? (
          <CopyRemediationPrompt label="Copy developer brief" prompt={devBrief} secondary />
        ) : null}
      </div>
      {shareShown ? (
        <p className={row.note}>
          The public link shows only the domain, level, score, and scan date. Prompts stay private.
        </p>
      ) : null}
    </div>
  );
}

/** How often the scanner asks again to finish the identity deletions still pending. */
export const DELETION_RETRY_INTERVAL_MS = 30_000;

/**
 * Starts asking `retry` to finish the scanner's pending identity deletions:
 * once at once and then every thirty seconds, for as long as the process runs.
 * It starts only where both halves of the dashboard's private route are
 * configured, since a deletion is finished by asking the dashboard; a failed
 * round is left for the next one, and its failure is the retry's to record.
 */
export function startDeletionRetries(
  environment: Readonly<Record<string, string | undefined>>,
  retry: () => Promise<unknown>,
): Readonly<{ stop: () => void }> {
  if (!environment.DASHBOARD_IDENTITY_URL || !environment.REPORT_IDENTITY_SECRET) {
    return { stop: () => {} };
  }
  const run = () => {
    void retry().catch(() => undefined);
  };
  run();
  const timer = setInterval(run, DELETION_RETRY_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

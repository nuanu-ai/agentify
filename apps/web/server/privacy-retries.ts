/**
 * How often the scanner asks again to finish the identity deletions still
 * pending and to send the data copies whose next try is due.
 */
export const PRIVACY_RETRY_INTERVAL_MS = 30_000;

/**
 * Starts asking `retry` to finish the scanner's pending privacy requests, the
 * identity deletions and the data copies: once at once and then every thirty
 * seconds, for as long as the process runs. It starts only where both halves
 * of the dashboard's private route are configured, since both are finished by
 * asking the dashboard; a failed round is left for the next one, and its
 * failure is the retry's to record.
 */
export function startPrivacyRetries(
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
  const timer = setInterval(run, PRIVACY_RETRY_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

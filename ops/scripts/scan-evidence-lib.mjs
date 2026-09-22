export const TERMINAL_SCAN_STATUSES = new Set(["completed", "partial", "failed"]);

const KNOWN_SCAN_STATUSES = new Set(["accepted", "queued", "running", ...TERMINAL_SCAN_STATUSES]);

export function percentile(values, quantile) {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

export function analyzeAcceptedResponses(results) {
  const acceptedResponses = results.filter((result) => result.status === 202);
  const accepted = acceptedResponses.filter(
    (result) =>
      typeof result.scanId === "string" &&
      result.scanId.length > 0 &&
      typeof result.accessToken === "string" &&
      result.accessToken.length >= 32 &&
      typeof result.statusUrl === "string" &&
      result.statusUrl.length > 0,
  );
  const ids = accepted.map((result) => result.scanId);
  return {
    accepted,
    acceptedResponses: acceptedResponses.length,
    malformedAccepted: acceptedResponses.length - accepted.length,
    duplicateIds: ids.length - new Set(ids).size,
    apiP95Ms: percentile(
      acceptedResponses.map((result) => result.apiMs),
      0.95,
    ),
  };
}

export async function pollAcceptedScans(
  scans,
  {
    fetchStatus,
    intervalMs,
    timeoutMs,
    maxConsecutiveErrors = 3,
    now = () => performance.now(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  },
) {
  const runningIds = new Set();
  let observedMaxRunning = 0;

  const results = await Promise.all(
    scans.map(async (scan) => {
      const deadline = scan.acceptedAtMs + timeoutMs;
      let consecutiveErrors = 0;
      let firstWorkAtMs;
      let lastStatus = "accepted";

      while (now() < deadline) {
        let payload;
        try {
          payload = await fetchStatus(scan);
          consecutiveErrors = 0;
        } catch {
          consecutiveErrors += 1;
          if (consecutiveErrors > maxConsecutiveErrors) {
            runningIds.delete(scan.scanId);
            return {
              scanId: scan.scanId,
              outcome: "poll_error",
              lastStatus,
              pollErrors: consecutiveErrors,
            };
          }
          await sleep(intervalMs);
          continue;
        }

        const observedAtMs = now();
        if (!payload || !KNOWN_SCAN_STATUSES.has(payload.status)) {
          runningIds.delete(scan.scanId);
          return {
            scanId: scan.scanId,
            outcome: "invalid_status",
            lastStatus,
            pollErrors: consecutiveErrors,
          };
        }
        lastStatus = payload.status;

        if (payload.status === "running") {
          firstWorkAtMs ??= observedAtMs;
          runningIds.add(scan.scanId);
          observedMaxRunning = Math.max(observedMaxRunning, runningIds.size);
        } else {
          runningIds.delete(scan.scanId);
        }

        if (TERMINAL_SCAN_STATUSES.has(payload.status)) {
          firstWorkAtMs ??= observedAtMs;
          return {
            scanId: scan.scanId,
            outcome: "terminal",
            terminalStatus: payload.status,
            queueMs: firstWorkAtMs - scan.acceptedAtMs,
            terminalMs: observedAtMs - scan.acceptedAtMs,
            pollErrors: consecutiveErrors,
            payload,
          };
        }
        await sleep(intervalMs);
      }

      runningIds.delete(scan.scanId);
      return {
        scanId: scan.scanId,
        outcome: "timeout",
        lastStatus,
        pollErrors: consecutiveErrors,
      };
    }),
  );

  return { results, observedMaxRunning };
}

export function statusCounts(results) {
  return Object.fromEntries(
    [...new Set(results.map((result) => String(result.status)))].map((status) => [
      status,
      results.filter((result) => String(result.status) === status).length,
    ]),
  );
}

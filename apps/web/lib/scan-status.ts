import type { ScanStatusResponse } from "@agentify/scanner-contracts";

/** What a scan's line says of where it stands, in progress and in its result alike. */
export const SCAN_STATUS_LINES: Readonly<Record<ScanStatusResponse["status"], string>> = {
  accepted: "Scan accepted",
  queued: "Waiting for scanner capacity",
  running: "Reading public signals…",
  completed: "Scan complete",
  partial: "Scan complete with unavailable checks",
  failed: "Scan ended without a reliable result",
};

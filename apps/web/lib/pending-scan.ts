import { isSegment, type Segment } from "@agentify/scanner-contracts/browser";

export const PENDING_SCAN_STORAGE_KEY = "agentify.pending-scan.v1";

export type PendingScanRequest = Readonly<{
  url: string;
  segment: Segment;
  variant: string;
  idempotencyKey: string;
  landingPath: string;
  landingSearch: string;
}>;

const FIELDS = [
  "url",
  "segment",
  "variant",
  "idempotencyKey",
  "landingPath",
  "landingSearch",
] as const;

const within = (value: unknown, least: number, most: number): value is string =>
  typeof value === "string" && value.length >= least && value.length <= most;

/**
 * Checked by hand rather than by a schema, because this runs in the browser
 * and a schema library there costs every page its weight. The scan endpoint
 * checks the request again, so this only keeps a corrupt or stale hand-off
 * from being sent at all. The address comes back trimmed.
 */
function pendingScanIn(value: unknown): PendingScanRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const given = value as Record<string, unknown>;
  if (Object.keys(given).some((key) => !(FIELDS as readonly string[]).includes(key))) return null;
  const url = typeof given.url === "string" ? given.url.trim() : null;
  if (
    !within(url, 1, 2048) ||
    !isSegment(given.segment) ||
    !within(given.variant, 1, 100) ||
    !within(given.idempotencyKey, 8, 200) ||
    !within(given.landingPath, 1, 512) ||
    !given.landingPath.startsWith("/") ||
    !within(given.landingSearch, 0, 4096)
  ) {
    return null;
  }
  return {
    url,
    segment: given.segment,
    variant: given.variant,
    idempotencyKey: given.idempotencyKey,
    landingPath: given.landingPath,
    landingSearch: given.landingSearch,
  };
}

type ScanStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export function savePendingScan(storage: ScanStorage, request: PendingScanRequest) {
  const checked = pendingScanIn(request);
  if (checked === null) throw new Error("the pending scan is not one this page can hand on");
  storage.setItem(PENDING_SCAN_STORAGE_KEY, JSON.stringify(checked));
}

export function readPendingScan(storage: ScanStorage): PendingScanRequest | null {
  const raw = storage.getItem(PENDING_SCAN_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = pendingScanIn(JSON.parse(raw));
    if (parsed !== null) return parsed;
  } catch {
    // Corrupt or stale browser state is removed below.
  }
  storage.removeItem(PENDING_SCAN_STORAGE_KEY);
  return null;
}

export function clearPendingScan(storage: ScanStorage) {
  storage.removeItem(PENDING_SCAN_STORAGE_KEY);
}

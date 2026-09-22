import { segmentSchema } from "@agentify/scanner-contracts";
import { z } from "zod";

export const PENDING_SCAN_STORAGE_KEY = "agentify.pending-scan.v1";

const pendingScanRequestSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    segment: segmentSchema,
    variant: z.string().min(1).max(100),
    idempotencyKey: z.string().min(8).max(200),
    landingPath: z.string().startsWith("/").max(512),
    landingSearch: z.string().max(4096),
  })
  .strict();

export type PendingScanRequest = z.infer<typeof pendingScanRequestSchema>;

type ScanStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export function savePendingScan(storage: ScanStorage, request: PendingScanRequest) {
  storage.setItem(
    PENDING_SCAN_STORAGE_KEY,
    JSON.stringify(pendingScanRequestSchema.parse(request)),
  );
}

export function readPendingScan(storage: ScanStorage): PendingScanRequest | null {
  const raw = storage.getItem(PENDING_SCAN_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = pendingScanRequestSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Corrupt or stale browser state is removed below.
  }
  storage.removeItem(PENDING_SCAN_STORAGE_KEY);
  return null;
}

export function clearPendingScan(storage: ScanStorage) {
  storage.removeItem(PENDING_SCAN_STORAGE_KEY);
}

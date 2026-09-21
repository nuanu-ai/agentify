import {
  SCAN_RUBRIC_VERSION,
  type ScanJobV1,
  type Segment,
} from "@agentify/scanner-contracts";
import {
  normalizeNodePostgresConnectionString,
  scans,
  type DatabaseTransaction,
} from "@agentify/scanner-database";
import { and, eq, sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";

import { getServerConfig } from "./config";

const globalQueue = globalThis as typeof globalThis & {
  agentifyWebQueue?: Promise<PgBoss>;
};

export function getScanQueue(): Promise<PgBoss> {
  globalQueue.agentifyWebQueue ??= (async () => {
    const boss = new PgBoss({
      connectionString: normalizeNodePostgresConnectionString(
        getServerConfig().DATABASE_URL,
      ),
      schema: "pgboss",
      application_name: "agentify-web-enqueuer",
      supervise: false,
      schedule: false,
    });
    await boss.start();
    await boss.createQueue("scan-v1", {
      retryLimit: 1,
      retryDelay: 1,
      expireInSeconds: 60,
    });
    return boss;
  })();
  return globalQueue.agentifyWebQueue;
}

export async function stopScanQueue(): Promise<void> {
  const queue = globalQueue.agentifyWebQueue;
  globalQueue.agentifyWebQueue = undefined;
  if (queue) await (await queue).stop();
}

export async function enqueueScanInTransaction(
  tx: DatabaseTransaction,
  input: {
    scanId: string;
    canonicalTargetUrl: string;
    submittedWithoutScheme: boolean;
    segment: Segment;
    deadlineAt?: Date;
  },
): Promise<boolean> {
  const transitioned = await tx
    .update(scans)
    .set({ status: "queued", queuedAt: new Date() })
    .where(and(eq(scans.id, input.scanId), eq(scans.status, "accepted")))
    .returning({ id: scans.id });
  if (!transitioned[0]) return false;

  const payload: ScanJobV1 = {
    scan_id: input.scanId,
    canonical_target_url: input.canonicalTargetUrl,
    ...(input.submittedWithoutScheme ? { submitted_without_scheme: true } : {}),
    segment: input.segment,
    rubric_version: SCAN_RUBRIC_VERSION,
    deadline_at: (
      input.deadlineAt ?? new Date(Date.now() + 55_000)
    ).toISOString(),
    attempt_no: 1,
  };
  const queue = await getScanQueue();
  await queue.send("scan-v1", payload, {
    singletonKey: input.scanId,
    db: fromDrizzle(tx, sql),
  });
  return true;
}

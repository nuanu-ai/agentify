import { sql } from "drizzle-orm";

import type { Database } from "./client.js";
import { workerHeartbeats } from "./schema.js";

export async function recordWorkerHeartbeat(
  db: Database,
  input: {
    workerId: string;
    service: string;
    startedAt: Date;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const now = new Date();
  await db
    .insert(workerHeartbeats)
    .values({
      workerId: input.workerId,
      service: input.service,
      startedAt: input.startedAt,
      heartbeatAt: now,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: {
        startedAt: input.startedAt,
        heartbeatAt: now,
        metadata: input.metadata ?? {},
        service: input.service,
      },
      setWhere: sql`${workerHeartbeats.startedAt} <= ${input.startedAt}`,
    });
}

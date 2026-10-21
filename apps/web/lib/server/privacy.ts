import { runRetentionCleanup } from "@agentify/scanner-database";

import { getDatabase } from "./database";

export async function executeRetentionCleanup(input: { now?: Date; batchSize?: number }) {
  return await runRetentionCleanup(getDatabase().db, {
    now: input.now ?? new Date(),
    batchSize: input.batchSize,
  });
}

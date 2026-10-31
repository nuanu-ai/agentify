import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { JournalRow } from "../../ports/journal.js";
import type { LiveSalesEffect, LiveSalesRequest } from "../../ports/live-sales.js";
import { journalRowOf } from "./journal.js";
import { liveRequests, operatorJournal } from "./schema.js";

export type LiveSalesTransaction = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];
export interface PostgresLiveSalesNotices {
  within(tx: LiveSalesTransaction, event: LiveSalesEffect): Promise<void>;
}
export const noLiveSalesNotices: PostgresLiveSalesNotices = {
  async within() {
    throw new Error("live-sales changes need a transactional notice writer");
  },
};
export function liveRequestOf(
  row: typeof liveRequests.$inferSelect,
  decline: JournalRow | null,
): LiveSalesRequest {
  return {
    id: row.id,
    merchantId: row.merchantId,
    accountId: row.accountId,
    requestedAt: row.requestedAt.getTime(),
    evidence: row.evidence,
    state: row.state,
    decline,
    reminderDueAt: row.reminderDueAt.getTime(),
    reminderCreatedAt: row.reminderCreatedAt?.getTime() ?? null,
  };
}
export async function readLiveRequest(
  db: Pick<NodePgDatabase, "select">,
  merchantId: string,
): Promise<LiveSalesRequest | null> {
  const [row] = await db.select().from(liveRequests).where(eq(liveRequests.merchantId, merchantId));
  if (!row) return null;
  const [decline] =
    row.declineSequence === null
      ? []
      : await db
          .select()
          .from(operatorJournal)
          .where(eq(operatorJournal.sequence, row.declineSequence));
  if (row.state === "declined" && !decline) throw new Error("the decline journal row is missing");
  return liveRequestOf(row, decline ? journalRowOf(decline) : null);
}

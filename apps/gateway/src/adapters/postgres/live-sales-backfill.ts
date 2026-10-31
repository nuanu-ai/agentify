import { type SurfaceMode, surfaceModeOf } from "@agentify/core";
import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { randomIds } from "../../ports/clock.js";
import { liveSalesReminderAt } from "../../ports/live-sales.js";
import { liveRequestOf, type PostgresLiveSalesNotices } from "./live-sales.js";
import { liveRequestBackfill, liveRequests } from "./schema.js";

/** Missing configuration cannot label an old database live. */
export function liveBackfillMode(
  network: string | undefined,
  facilitator: string | undefined,
): SurfaceMode | null {
  if (!network || !facilitator) return null;
  try {
    return surfaceModeOf(network, facilitator);
  } catch {
    return null;
  }
}

/** Runs after both applications' schema migrations, once for the live release. */
export async function backfillLiveSalesRequests(
  db: NodePgDatabase,
  mode: SurfaceMode | null,
  notices: PostgresLiveSalesNotices,
  at: Date,
) {
  if (mode !== "live") return { kind: "skipped" as const, count: 0 };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(1473867341, 1381057873)`);
    const id = "live-sales-requests";
    const [done] = await tx
      .select()
      .from(liveRequestBackfill)
      .where(eq(liveRequestBackfill.id, id));
    if (done) return { kind: "already_done" as const, count: 0 };
    const { rows } = await tx.execute<{
      id: string;
      service_name: string;
      payout_wallet: string;
    }>(sql`
      select m.id,m.service_name,m.payout_wallet from merchants m
      where m.service_name is not null and m.payout_wallet is not null and m.live_approved_at is null
        and not exists(select 1 from operator_journal j where j.subject_merchant=m.id and j.action='withdraw' and j.outcome='done')
        and not exists(select 1 from merchant_live_requests r where r.merchant_id=m.id)
      order by m.id for no key update of m`);
    for (const merchant of rows) {
      const [row] = await tx
        .insert(liveRequests)
        .values({
          merchantId: merchant.id,
          id: randomIds("lsr"),
          accountId: null,
          requestedAt: at,
          evidence: null,
          state: "pending",
          declineSequence: null,
          reminderDueAt: new Date(liveSalesReminderAt(at.getTime())),
          reminderCreatedAt: null,
        })
        .returning();
      if (!row) throw new Error("the legacy live-sales request was not written");
      await notices.within(tx, {
        kind: "requested",
        request: liveRequestOf(row, null),
        sellerName: merchant.service_name,
        hasWallet: true,
      });
    }
    await tx.insert(liveRequestBackfill).values({ id, completedAt: at });
    return { kind: "done" as const, count: rows.length };
  });
}

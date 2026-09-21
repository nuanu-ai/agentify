import { leadScans, reportSessions } from "@agentify/scanner-database";
import { and, eq, gt, isNull } from "drizzle-orm";

import { sha256 } from "./crypto";
import { getDatabase } from "./database";

export const REPORT_SESSION_COOKIE = "agentify_report_session";

export async function getVerifiedSession(
  sessionToken: string | undefined,
  scanId?: string,
) {
  if (!sessionToken) return undefined;
  const { db } = getDatabase();
  const session = (
    await db
      .select()
      .from(reportSessions)
      .where(
        and(
          eq(reportSessions.sessionTokenHash, sha256(sessionToken)),
          gt(reportSessions.expiresAt, new Date()),
          isNull(reportSessions.revokedAt),
        ),
      )
      .limit(1)
  )[0];
  if (!session) return undefined;
  if (scanId) {
    const linked = (
      await db
        .select({ leadId: leadScans.leadId })
        .from(leadScans)
        .where(
          and(
            eq(leadScans.leadId, session.leadId),
            eq(leadScans.scanId, scanId),
          ),
        )
        .limit(1)
    )[0];
    if (!linked) return undefined;
  }
  await db
    .update(reportSessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(reportSessions.id, session.id));
  return session;
}

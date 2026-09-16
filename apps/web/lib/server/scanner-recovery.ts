import {
  createUuidV7,
  leads,
  leadScans,
  registrationIntents,
  reportSessions,
  scans,
  waitlistEntries,
  type DatabaseTransaction,
} from "@agentify/scanner-database";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { getVerifiedSession } from "./auth";
import { getServerConfig } from "./config";
import { hmacHex, normalizeEmail, randomCapability, sha256 } from "./crypto";
import { getDatabase } from "./database";
import { consumeRateLimitsAtomically } from "./rate-limit";
import {
  consumeScannerMagicLinkInTransaction,
  inspectScannerMagicLinkClaim,
  sendScannerRecoveryLink,
} from "./scanner-auth";

const REPORT_SESSION_TTL_MS = 30 * 86_400_000;

type RecoveryTarget = Readonly<{
  leadId: string;
  scanId: string;
  scannerAuthUserId: string | null;
}>;

async function lockScannerEmail(
  tx: DatabaseTransaction,
  emailLookupHash: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${emailLookupHash}, 0))`,
  );
}

async function recoverableLead(
  tx: DatabaseTransaction,
  emailLookupHash: string,
) {
  return (
    await tx
      .select({
        id: leads.id,
        scannerAuthUserId: leads.scannerAuthUserId,
      })
      .from(leads)
      .where(
        and(
          eq(leads.emailLookupHash, emailLookupHash),
          isNotNull(leads.verifiedAt),
          isNull(leads.deletionRequestedAt),
          isNull(leads.anonymizedAt),
        ),
      )
      .limit(1)
  )[0];
}

async function recoveryTargetForLead(
  tx: DatabaseTransaction,
  lead: { id: string; scannerAuthUserId: string | null },
  state?: string,
): Promise<RecoveryTarget | undefined> {
  if (state) {
    const hintedScan = (
      await tx
        .select({ scanId: scans.id })
        .from(registrationIntents)
        .innerJoin(scans, eq(scans.id, registrationIntents.scanId))
        .where(
          and(
            eq(registrationIntents.callbackStateHash, sha256(state)),
            inArray(scans.status, ["completed", "partial"]),
          ),
        )
        .limit(1)
    )[0];
    if (hintedScan) {
      const owned = (
        await tx
          .select({ scanId: leadScans.scanId })
          .from(leadScans)
          .innerJoin(
            waitlistEntries,
            and(
              eq(waitlistEntries.scanId, leadScans.scanId),
              eq(waitlistEntries.leadId, leadScans.leadId),
            ),
          )
          .where(
            and(
              eq(leadScans.leadId, lead.id),
              eq(leadScans.scanId, hintedScan.scanId),
            ),
          )
          .limit(1)
      )[0];
      if (!owned) return undefined;
      return {
        leadId: lead.id,
        scanId: hintedScan.scanId,
        scannerAuthUserId: lead.scannerAuthUserId,
      };
    }
  }

  const latest = (
    await tx
      .select({ scanId: scans.id })
      .from(leadScans)
      .innerJoin(scans, eq(scans.id, leadScans.scanId))
      .innerJoin(
        waitlistEntries,
        and(
          eq(waitlistEntries.scanId, scans.id),
          eq(waitlistEntries.leadId, lead.id),
        ),
      )
      .where(
        and(
          eq(leadScans.leadId, lead.id),
          inArray(scans.status, ["completed", "partial"]),
        ),
      )
      .orderBy(desc(scans.finishedAt), desc(scans.acceptedAt))
      .limit(1)
  )[0];
  return latest
    ? {
        leadId: lead.id,
        scanId: latest.scanId,
        scannerAuthUserId: lead.scannerAuthUserId,
      }
    : undefined;
}

async function recoveryTargetForEmail(
  tx: DatabaseTransaction,
  emailLookupHash: string,
  state?: string,
) {
  const lead = await recoverableLead(tx, emailLookupHash);
  return lead ? await recoveryTargetForLead(tx, lead, state) : undefined;
}

export async function requestScannerReportRecovery(input: {
  email: string;
  ip: string;
  state?: string;
}): Promise<void> {
  const config = getServerConfig();
  const normalizedEmail = normalizeEmail(input.email);
  const emailLookupHash = hmacHex(config.hmacSecret, "email", normalizedEmail);
  const limits = await consumeRateLimitsAtomically([
    {
      keyHash: hmacHex(config.hmacSecret, "recovery-email", emailLookupHash),
      kind: "recovery_email_hour",
      limit: 3,
    },
    {
      keyHash: hmacHex(config.hmacSecret, "recovery-ip", input.ip),
      kind: "recovery_ip_hour",
      limit: 10,
    },
  ]);
  if (!limits.allowed) return;

  await getDatabase().db.transaction(async (tx) => {
    // Privacy deletion takes the same lock before removing pending links.
    await lockScannerEmail(tx, emailLookupHash);
    const target = await recoveryTargetForEmail(
      tx,
      emailLookupHash,
      input.state,
    );
    if (!target) return;
    await sendScannerRecoveryLink(
      normalizedEmail,
      input.state ?? randomCapability(),
      tx,
    );
  });
}

export async function recoverScannerReportSession(
  sessionToken: string | undefined,
  state?: string,
) {
  const session = await getVerifiedSession(sessionToken);
  if (!session) return undefined;
  return await getDatabase().db.transaction(async (tx) => {
    const lead = (
      await tx
        .select({
          id: leads.id,
          scannerAuthUserId: leads.scannerAuthUserId,
        })
        .from(leads)
        .where(
          and(
            eq(leads.id, session.leadId),
            isNotNull(leads.verifiedAt),
            isNull(leads.deletionRequestedAt),
            isNull(leads.anonymizedAt),
          ),
        )
        .limit(1)
    )[0];
    return lead ? await recoveryTargetForLead(tx, lead, state) : undefined;
  });
}

export async function verifyAndFinalizeScannerRecovery(
  state: string,
  token: string,
) {
  const config = getServerConfig();
  return await getDatabase().db.transaction(async (tx) => {
    const claim = await inspectScannerMagicLinkClaim(token, tx);
    if (!claim || claim.purpose !== "recovery" || claim.state !== state)
      return undefined;
    const emailLookupHash = hmacHex(
      config.hmacSecret,
      "email",
      normalizeEmail(claim.email),
    );
    await lockScannerEmail(tx, emailLookupHash);
    const target = await recoveryTargetForEmail(tx, emailLookupHash, state);
    if (!target) return undefined;

    const verified = await consumeScannerMagicLinkInTransaction(tx, token);
    if (
      hmacHex(config.hmacSecret, "email", normalizeEmail(verified.email)) !==
      emailLookupHash
    )
      throw new Error("verification_email_mismatch");
    if (
      target.scannerAuthUserId !== null &&
      target.scannerAuthUserId !== verified.id
    )
      throw new Error("scanner_identity_conflict");

    const linked = await tx
      .update(leads)
      .set({ scannerAuthUserId: verified.id })
      .where(
        and(
          eq(leads.id, target.leadId),
          isNull(leads.deletionRequestedAt),
          isNull(leads.anonymizedAt),
        ),
      )
      .returning({ id: leads.id });
    if (!linked.length) throw new Error("recovery_lead_unavailable");

    const sessionToken = randomCapability();
    await tx.insert(reportSessions).values({
      id: createUuidV7(),
      leadId: target.leadId,
      sessionTokenHash: sha256(sessionToken),
      expiresAt: new Date(Date.now() + REPORT_SESSION_TTL_MS),
    });
    return { scanId: target.scanId, sessionToken };
  });
}

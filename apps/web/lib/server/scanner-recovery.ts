import {
  createUuidV7,
  type DatabaseTransaction,
  leadScans,
  leads,
  registrationIntents,
  reportSessions,
  scannerRecoveryIntents,
  scans,
  waitlistEntries,
} from "@agentify/scanner-database";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { getVerifiedSession } from "./auth";
import { getCabinetReportIdentityClient } from "./cabinet-report-identity";
import { getServerConfig } from "./config";
import { decryptEmail, hmacHex, normalizeEmail, randomCapability, sha256 } from "./crypto";
import { getDatabase } from "./database";
import type { LinkSendOutcome } from "./link-wait";
import { consumeRateLimitsAtomically, refundRateLimitEvent } from "./rate-limit";

const REPORT_SESSION_TTL_MS = 30 * 86_400_000;
const RECOVERY_INTENT_TTL_MS = 60 * 60 * 1000;

type RecoveryTarget = Readonly<{
  leadId: string;
  scanId: string;
}>;

type RecoverableLead = Readonly<{
  id: string;
  emailLookupHash: string;
}>;

async function lockScannerEmail(tx: DatabaseTransaction, emailLookupHash: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${emailLookupHash}, 0))`);
}

async function recoverableLead(tx: DatabaseTransaction, emailLookupHash: string) {
  return (
    await tx
      .select({ id: leads.id, emailLookupHash: leads.emailLookupHash })
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
  lead: RecoverableLead,
  state?: string,
  latestWhenStateUnknown = false,
): Promise<RecoveryTarget | undefined> {
  if (state) {
    const stateHash = sha256(state);
    const registration = (
      await tx
        .select({
          scanId: registrationIntents.scanId,
          emailLookupHash: registrationIntents.emailLookupHash,
        })
        .from(registrationIntents)
        .where(eq(registrationIntents.callbackStateHash, stateHash))
        .limit(1)
    )[0];
    const recoveries = await tx
      .select({
        scanId: scannerRecoveryIntents.scanId,
        leadId: scannerRecoveryIntents.leadId,
        emailLookupHash: scannerRecoveryIntents.emailLookupHash,
      })
      .from(scannerRecoveryIntents)
      .where(eq(scannerRecoveryIntents.stateHash, stateHash))
      .limit(2);
    if (recoveries.length > 1) return undefined;
    const recovery = recoveries[0];
    if (!registration && !recovery) {
      if (!latestWhenStateUnknown) return undefined;
    } else {
      const registrationScan =
        registration?.emailLookupHash === lead.emailLookupHash ? registration.scanId : undefined;
      const recoveryScan =
        recovery?.leadId === lead.id && recovery.emailLookupHash === lead.emailLookupHash
          ? recovery.scanId
          : undefined;
      if (!registrationScan && !recoveryScan) return undefined;
      if (
        registrationScan !== undefined &&
        recoveryScan !== undefined &&
        registrationScan !== recoveryScan
      ) {
        return undefined;
      }
      const scanId = registrationScan ?? recoveryScan;
      if (scanId === undefined) return undefined;
      const owned = (
        await tx
          .select({ scanId: leadScans.scanId })
          .from(leadScans)
          .innerJoin(scans, eq(scans.id, leadScans.scanId))
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
              eq(leadScans.scanId, scanId),
              inArray(scans.status, ["completed", "partial"]),
            ),
          )
          .limit(1)
      )[0];
      return owned ? { leadId: lead.id, scanId } : undefined;
    }
  }

  const latest = (
    await tx
      .select({ scanId: scans.id })
      .from(leadScans)
      .innerJoin(scans, eq(scans.id, leadScans.scanId))
      .innerJoin(
        waitlistEntries,
        and(eq(waitlistEntries.scanId, scans.id), eq(waitlistEntries.leadId, lead.id)),
      )
      .where(and(eq(leadScans.leadId, lead.id), inArray(scans.status, ["completed", "partial"])))
      .orderBy(desc(scans.finishedAt), desc(scans.acceptedAt))
      .limit(1)
  )[0];
  return latest
    ? {
        leadId: lead.id,
        scanId: latest.scanId,
      }
    : undefined;
}

async function recoveryTargetForEmail(
  tx: DatabaseTransaction,
  emailLookupHash: string,
  state?: string,
) {
  const lead = await recoverableLead(tx, emailLookupHash);
  return lead ? await recoveryTargetForLead(tx, lead, state, true) : undefined;
}

export async function requestScannerReportRecovery(input: {
  email: string;
  ip: string;
  state?: string;
}): Promise<LinkSendOutcome> {
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
  if (!limits.allowed)
    return {
      sent: false as const,
      retryAt: limits.retryAt,
      wall:
        limits.wall === "recovery_email_hour"
          ? ("address_hour" as const)
          : ("unspecified" as const),
    };

  const state = randomCapability();
  const now = new Date();
  const intentId = createUuidV7();
  const target = await getDatabase().db.transaction(async (tx) => {
    // Privacy deletion takes the same lock before removing pending links.
    await lockScannerEmail(tx, emailLookupHash);
    const target = await recoveryTargetForEmail(tx, emailLookupHash, input.state);
    if (!target) return undefined;
    await tx.insert(scannerRecoveryIntents).values({
      id: intentId,
      tokenHash: null,
      stateHash: sha256(state),
      emailLookupHash,
      leadId: target.leadId,
      scanId: target.scanId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + RECOVERY_INTENT_TTL_MS),
      activatedAt: null,
      consumedAt: null,
    });
    return target;
  });

  let result: Awaited<
    ReturnType<ReturnType<typeof getCabinetReportIdentityClient>["sendReportLink"]>
  >;
  try {
    result = await getCabinetReportIdentityClient().sendReportLink({
      email: normalizedEmail,
      intentKind: "recovery",
      state,
    });
  } catch (error) {
    if (target) {
      await getDatabase()
        .db.delete(scannerRecoveryIntents)
        .where(eq(scannerRecoveryIntents.id, intentId));
    }
    throw error;
  }

  if (result.status !== "accepted") {
    if (target) {
      await getDatabase()
        .db.delete(scannerRecoveryIntents)
        .where(eq(scannerRecoveryIntents.id, intentId));
    }
    if (result.status === "cooldown") {
      // Nothing reached the mailbox, so the address keeps its hour; the IP's
      // hour counts requests that reached us and stays spent.
      const letter = limits.spent.find(({ kind }) => kind === "recovery_email_hour");
      if (letter) await refundRateLimitEvent(letter.eventId);
      return {
        sent: false as const,
        retryAt: new Date(result.retry_at),
        wall: "unspecified" as const,
      };
    }
    throw new Error("cabinet_identity_unavailable");
  }

  if (target) {
    await getDatabase().db.transaction(async (tx) => {
      await lockScannerEmail(tx, emailLookupHash);
      const currentLead = await recoverableLead(tx, emailLookupHash);
      if (!currentLead || currentLead.id !== target.leadId) {
        await tx.delete(scannerRecoveryIntents).where(eq(scannerRecoveryIntents.id, intentId));
        return;
      }
      const activated = await tx
        .update(scannerRecoveryIntents)
        .set({ tokenHash: result.token_hash, activatedAt: new Date() })
        .where(
          and(
            eq(scannerRecoveryIntents.id, intentId),
            isNull(scannerRecoveryIntents.tokenHash),
            isNull(scannerRecoveryIntents.activatedAt),
            isNull(scannerRecoveryIntents.consumedAt),
          ),
        )
        .returning({ id: scannerRecoveryIntents.id });
      if (!activated.length) throw new Error("recovery_intent_activation_failed");
    });
  }
  return { sent: true as const };
}

export type ActiveRecoveryAuthority = Readonly<{
  email: string;
  emailLookupHash: string;
  intentId: string;
  leadId: string;
  scanId: string;
}>;

export async function findActiveScannerRecoveryAuthority(
  tokenHash: string,
  state: string,
): Promise<ActiveRecoveryAuthority | undefined> {
  const config = getServerConfig();
  return await getDatabase().db.transaction(async (tx) => {
    const authority = (
      await tx
        .select({
          intentId: scannerRecoveryIntents.id,
          emailLookupHash: scannerRecoveryIntents.emailLookupHash,
          leadId: scannerRecoveryIntents.leadId,
          scanId: scannerRecoveryIntents.scanId,
          encryptedEmail: leads.emailNormalizedCiphertext,
        })
        .from(scannerRecoveryIntents)
        .innerJoin(leads, eq(leads.id, scannerRecoveryIntents.leadId))
        .innerJoin(
          leadScans,
          and(
            eq(leadScans.leadId, scannerRecoveryIntents.leadId),
            eq(leadScans.scanId, scannerRecoveryIntents.scanId),
          ),
        )
        .innerJoin(
          waitlistEntries,
          and(
            eq(waitlistEntries.leadId, scannerRecoveryIntents.leadId),
            eq(waitlistEntries.scanId, scannerRecoveryIntents.scanId),
          ),
        )
        .where(
          and(
            eq(scannerRecoveryIntents.tokenHash, tokenHash),
            eq(scannerRecoveryIntents.stateHash, sha256(state)),
            isNotNull(scannerRecoveryIntents.activatedAt),
            isNull(scannerRecoveryIntents.consumedAt),
            isNotNull(leads.verifiedAt),
            isNull(leads.deletionRequestedAt),
            isNull(leads.anonymizedAt),
          ),
        )
        .limit(1)
    )[0];
    if (!authority) return undefined;
    const email = normalizeEmail(decryptEmail(authority.encryptedEmail, config.encryptionKey));
    if (hmacHex(config.hmacSecret, "email", email) !== authority.emailLookupHash) {
      throw new Error("lead_email_identity_mismatch");
    }
    return { ...authority, email };
  });
}

export async function finalizeCabinetScannerRecoveryInTransaction(
  tx: DatabaseTransaction,
  authority: ActiveRecoveryAuthority,
  tokenHash: string,
  state: string,
) {
  const now = new Date();
  const consumed = (
    await tx
      .update(scannerRecoveryIntents)
      .set({ consumedAt: now })
      .where(
        and(
          eq(scannerRecoveryIntents.id, authority.intentId),
          eq(scannerRecoveryIntents.tokenHash, tokenHash),
          eq(scannerRecoveryIntents.stateHash, sha256(state)),
          eq(scannerRecoveryIntents.emailLookupHash, authority.emailLookupHash),
          eq(scannerRecoveryIntents.leadId, authority.leadId),
          eq(scannerRecoveryIntents.scanId, authority.scanId),
          isNotNull(scannerRecoveryIntents.activatedAt),
          isNull(scannerRecoveryIntents.consumedAt),
        ),
      )
      .returning({ id: scannerRecoveryIntents.id })
  )[0];
  if (!consumed) return undefined;
  const lead = (
    await tx
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.id, authority.leadId),
          eq(leads.emailLookupHash, authority.emailLookupHash),
          isNotNull(leads.verifiedAt),
          isNull(leads.deletionRequestedAt),
          isNull(leads.anonymizedAt),
        ),
      )
      .limit(1)
      .for("update")
  )[0];
  if (!lead) throw new Error("recovery_lead_unavailable");
  const sessionToken = randomCapability();
  await tx.insert(reportSessions).values({
    id: createUuidV7(),
    leadId: authority.leadId,
    sessionTokenHash: sha256(sessionToken),
    expiresAt: new Date(Date.now() + REPORT_SESSION_TTL_MS),
  });
  return {
    leadId: authority.leadId,
    scanId: authority.scanId,
    sessionToken,
  };
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
        .select({ id: leads.id, emailLookupHash: leads.emailLookupHash })
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

import {
  consentSnapshots,
  createUuidV7,
  emitStoredBusinessEvent,
  leads,
  leadScans,
  reportSessions,
  scans,
  sessions,
  verificationTokens,
  waitlistEntries,
} from "@b2a/db";
import type { RegistrationRequest } from "@b2a/contracts";
import { and, eq, gt, isNull } from "drizzle-orm";

import { getServerConfig } from "./config";
import {
  decryptEmail,
  encryptEmail,
  hmacHex,
  normalizeEmail,
  randomCapability,
  sha256,
} from "./crypto";
import { getDatabase } from "./database";
import { sendTransactionalEmail, trySendTransactionalEmail } from "./email";
import { consumeRateLimitsAtomically } from "./rate-limit";

export async function registerForReport(
  scan: typeof scans.$inferSelect,
  body: RegistrationRequest,
) {
  const config = getServerConfig();
  const normalizedEmail = normalizeEmail(body.email);
  const emailLookupHash = hmacHex(config.hmacSecret, "email", normalizedEmail);
  const limits = await consumeRateLimitsAtomically([
    {
      keyHash: hmacHex(
        config.hmacSecret,
        "registration-email",
        emailLookupHash,
      ),
      kind: "registration_email_hour",
      limit: 3,
    },
    {
      keyHash: hmacHex(
        config.hmacSecret,
        "registration-session",
        scan.sessionId,
      ),
      kind: "registration_session_hour",
      limit: 10,
    },
  ]);
  if (!limits.allowed) return { sent: false as const };

  const token = randomCapability();
  const { db } = getDatabase();
  await db.transaction(async (tx) => {
    let lead = (
      await tx
        .select()
        .from(leads)
        .where(eq(leads.emailLookupHash, emailLookupHash))
        .limit(1)
    )[0];
    if (!lead) {
      const id = createUuidV7();
      await tx.insert(leads).values({
        id,
        emailNormalizedCiphertext: encryptEmail(
          normalizedEmail,
          config.encryptionKey,
        ),
        emailLookupHash,
        role: body.role,
        firstSegment: scan.segment,
        firstSessionId: scan.sessionId,
      });
      lead = (
        await tx.select().from(leads).where(eq(leads.id, id)).limit(1)
      )[0];
    }
    if (!lead) throw new Error("lead_creation_failed");
    await tx
      .insert(leadScans)
      .values({
        leadId: lead.id,
        scanId: scan.id,
        siteOwnershipClaim: body.site_is_mine,
      })
      .onConflictDoUpdate({
        target: [leadScans.leadId, leadScans.scanId],
        set: { siteOwnershipClaim: body.site_is_mine },
      });
    await tx
      .update(scans)
      .set({ leadId: lead.id })
      .where(eq(scans.id, scan.id));

    const registrationSession = (
      await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, scan.sessionId))
        .limit(1)
    )[0];
    const previousConsent = registrationSession?.consentSnapshotId
      ? (
          await tx
            .select()
            .from(consentSnapshots)
            .where(
              eq(consentSnapshots.id, registrationSession.consentSnapshotId),
            )
            .limit(1)
        )[0]
      : undefined;
    const consentId = createUuidV7();
    await tx.insert(consentSnapshots).values({
      id: consentId,
      sessionId: scan.sessionId,
      policyVersion: "phase-a-v1",
      country: previousConsent?.country,
      categories: {
        ...(typeof previousConsent?.categories === "object"
          ? previousConsent.categories
          : {}),
        essential_processing: true,
        dataset_reuse: true,
        marketing_email: body.marketing_email_opt_in,
      },
      source: "registration",
    });
    await tx
      .update(sessions)
      .set({ consentSnapshotId: consentId })
      .where(eq(sessions.id, scan.sessionId));

    await tx
      .update(verificationTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(verificationTokens.leadId, lead.id),
          eq(verificationTokens.scanId, scan.id),
          isNull(verificationTokens.usedAt),
        ),
      );
    await tx.insert(verificationTokens).values({
      id: createUuidV7(),
      leadId: lead.id,
      scanId: scan.id,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  });

  const verificationUrl = `${config.appBaseUrl}/api/v1/auth/verify?token=${encodeURIComponent(token)}`;
  await sendTransactionalEmail({
    to: normalizedEmail,
    subject: `Confirm your diagnostic report for ${scan.targetHost}`,
    text: `Confirm your email to view the full diagnostic report for ${scan.targetHost}. This one-time link expires in 24 hours: ${verificationUrl}`,
    html: `<p>Confirm your email to view the full diagnostic report for <strong>${escapeHtml(scan.targetHost)}</strong>.</p><p><a href="${verificationUrl}">Confirm and view report</a></p><p>This one-time link expires in 24 hours.</p>`,
    evidenceUrl: verificationUrl,
  });
  return { sent: true as const, verificationUrl };
}

type VerificationResult =
  | { status: "verified"; scanId: string; sessionToken: string }
  | { status: "expired_or_used"; scanId?: string };

export async function verifyEmailToken(
  token: string,
  sendReportEmail: typeof trySendTransactionalEmail = trySendTransactionalEmail,
): Promise<VerificationResult> {
  const config = getServerConfig();
  const { db } = getDatabase();
  const sessionToken = randomCapability();
  const result = await db.transaction(async (tx) => {
    const consumed = await tx
      .update(verificationTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(verificationTokens.tokenHash, sha256(token)),
          isNull(verificationTokens.usedAt),
          gt(verificationTokens.expiresAt, new Date()),
        ),
      )
      .returning();
    const verification = consumed[0];
    if (!verification) {
      const known = (
        await tx
          .select({ scanId: verificationTokens.scanId })
          .from(verificationTokens)
          .where(eq(verificationTokens.tokenHash, sha256(token)))
          .limit(1)
      )[0];
      return { status: "expired_or_used" as const, scanId: known?.scanId };
    }

    const scan = (
      await tx
        .select()
        .from(scans)
        .where(eq(scans.id, verification.scanId))
        .limit(1)
    )[0];
    const lead = (
      await tx
        .select()
        .from(leads)
        .where(eq(leads.id, verification.leadId))
        .limit(1)
    )[0];
    if (!scan || !lead) throw new Error("verification_linkage_missing");
    await tx
      .update(leads)
      .set({ verifiedAt: lead.verifiedAt ?? new Date() })
      .where(eq(leads.id, lead.id));
    await tx
      .insert(waitlistEntries)
      .values({ id: createUuidV7(), leadId: lead.id, scanId: scan.id })
      .onConflictDoNothing({
        target: [waitlistEntries.leadId, waitlistEntries.scanId],
      });
    await tx.insert(reportSessions).values({
      id: createUuidV7(),
      leadId: lead.id,
      sessionTokenHash: sha256(sessionToken),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    const session = (
      await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, scan.sessionId))
        .limit(1)
    )[0];
    if (!session?.consentSnapshotId)
      throw new Error("verification_consent_missing");
    await emitStoredBusinessEvent(tx, {
      name: "registration_completed",
      identifiers: { lead_id: lead.id, scan_id: scan.id },
      sessionId: scan.sessionId,
      consentSnapshotId: session.consentSnapshotId,
      leadId: lead.id,
      scanId: scan.id,
      segment: scan.segment,
      landingVariant: session.firstLandingVariant ?? "unknown",
      properties: { role: lead.role },
    });
    return {
      status: "verified" as const,
      scanId: scan.id,
      sessionToken,
      email: decryptEmail(lead.emailNormalizedCiphertext, config.encryptionKey),
      host: scan.targetHost,
    };
  });

  if (result.status === "verified") {
    const reportUrl = `${config.appBaseUrl}/report/${result.scanId}`;
    await sendReportEmail({
      to: result.email,
      subject: `Your diagnostic report for ${result.host}`,
      text: `Your diagnostic report is ready: ${reportUrl}`,
      html: `<p>Your diagnostic report for <strong>${escapeHtml(result.host)}</strong> is ready.</p><p><a href="${reportUrl}">Open report</a></p>`,
    });
    return {
      status: "verified",
      scanId: result.scanId,
      sessionToken: result.sessionToken,
    };
  }
  return result;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

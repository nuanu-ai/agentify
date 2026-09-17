import { reportIdentityTokenHash } from "@agentify/scanner-contracts/report-identity";
import {
  leads,
  registrationIntents,
  scannerIdentityCompletions,
  scans,
} from "@agentify/scanner-database";
import { and, eq, isNull } from "drizzle-orm";

import {
  CabinetIdentityUnavailableError,
  getCabinetReportIdentityClient,
} from "./cabinet-report-identity";
import { getServerConfig } from "./config";
import { decryptEmail, hmacHex, normalizeEmail, sha256 } from "./crypto";
import { getDatabase } from "./database";
import {
  finalizeCabinetScannerRecoveryInTransaction,
  findActiveScannerRecoveryAuthority,
  type ActiveRecoveryAuthority,
} from "./scanner-recovery";
import { finalizeCabinetScannerRegistrationInTransaction } from "./scanner-registration";

const COMPLETION_RETENTION_MS = 7 * 86_400_000;

type RegistrationAuthority = Readonly<{
  intentKind: "registration";
  email: string;
  emailLookupHash: string;
  scanId: string;
}>;

type RecoveryAuthority = ActiveRecoveryAuthority &
  Readonly<{ intentKind: "recovery" }>;

type Authority = RegistrationAuthority | RecoveryAuthority;

async function findRegistrationAuthority(
  state: string,
): Promise<RegistrationAuthority | undefined> {
  const config = getServerConfig();
  return await getDatabase().db.transaction(async (tx) => {
    const intent = (
      await tx
        .select({
          scanId: registrationIntents.scanId,
          sessionId: registrationIntents.sessionId,
          emailLookupHash: registrationIntents.emailLookupHash,
          encryptedEmail: registrationIntents.emailNormalizedCiphertext,
        })
        .from(registrationIntents)
        .where(
          and(
            eq(registrationIntents.callbackStateHash, sha256(state)),
            isNull(registrationIntents.consumedAt),
          ),
        )
        .limit(1)
    )[0];
    if (!intent) return undefined;
    const scan = (
      await tx
        .select({ sessionId: scans.sessionId, status: scans.status })
        .from(scans)
        .where(eq(scans.id, intent.scanId))
        .limit(1)
    )[0];
    if (
      !scan ||
      scan.sessionId !== intent.sessionId ||
      (scan.status !== "completed" && scan.status !== "partial")
    ) {
      return undefined;
    }
    const deletingLead = (
      await tx
        .select({ deletionRequestedAt: leads.deletionRequestedAt })
        .from(leads)
        .where(eq(leads.emailLookupHash, intent.emailLookupHash))
        .limit(1)
    )[0];
    if (deletingLead?.deletionRequestedAt) return undefined;
    const email = normalizeEmail(
      decryptEmail(intent.encryptedEmail, config.encryptionKey),
    );
    if (hmacHex(config.hmacSecret, "email", email) !== intent.emailLookupHash) {
      throw new Error("registration_email_identity_mismatch");
    }
    return {
      intentKind: "registration",
      email,
      emailLookupHash: intent.emailLookupHash,
      scanId: intent.scanId,
    };
  });
}

async function findAuthority(
  tokenHash: string,
  state: string,
): Promise<Authority | undefined> {
  const recovery = await findActiveScannerRecoveryAuthority(tokenHash, state);
  if (recovery) return { ...recovery, intentKind: "recovery" };
  return await findRegistrationAuthority(state);
}

export type ScannerIdentityFinalization = Readonly<{
  scanId: string;
  sessionToken: string;
  cabinetActionUrl?: string;
}>;

export async function verifyAndFinalizeScannerIdentity(
  state: string,
  token: string,
): Promise<ScannerIdentityFinalization | undefined> {
  const tokenHash = reportIdentityTokenHash(token);
  const stateHash = sha256(state);
  const previouslyCompleted = (
    await getDatabase()
      .db.select()
      .from(scannerIdentityCompletions)
      .where(
        and(
          eq(scannerIdentityCompletions.tokenHash, tokenHash),
          eq(scannerIdentityCompletions.stateHash, stateHash),
        ),
      )
      .limit(1)
  )[0];
  if (previouslyCompleted) {
    await getCabinetReportIdentityClient().acknowledgeReportLink({
      receiptId: previouslyCompleted.receiptId,
      tokenHash,
    });
    // The local report capability was returned only by the request that made
    // the durable completion. A retry can finish acknowledgement, but cannot
    // replay the capability or mint another cabinet transition.
    return undefined;
  }
  const authority = await findAuthority(tokenHash, state);
  if (!authority) return undefined;

  const client = getCabinetReportIdentityClient();
  const consumed = await client.consumeReportLink({
    token,
    email: authority.email,
    intentKind: authority.intentKind,
    state,
  });
  if (consumed.status !== "pending") return undefined;
  const deadline = new Date(consumed.completion_deadline);

  const existing = (
    await getDatabase()
      .db.select()
      .from(scannerIdentityCompletions)
      .where(eq(scannerIdentityCompletions.receiptId, consumed.receipt_id))
      .limit(1)
  )[0];
  if (existing) {
    if (
      existing.tokenHash !== tokenHash ||
      existing.intentKind !== authority.intentKind ||
      existing.stateHash !== stateHash ||
      existing.scanId !== authority.scanId
    ) {
      return undefined;
    }
    const acknowledged = await client.acknowledgeReportLink({
      receiptId: consumed.receipt_id,
      tokenHash,
    });
    if (acknowledged.status !== "completed") return undefined;
    return undefined;
  }

  const finalized = await getDatabase().db.transaction(async (tx) => {
    const alreadyCompleted = (
      await tx
        .select({ receiptId: scannerIdentityCompletions.receiptId })
        .from(scannerIdentityCompletions)
        .where(eq(scannerIdentityCompletions.receiptId, consumed.receipt_id))
        .limit(1)
    )[0];
    if (alreadyCompleted) return undefined;
    if (deadline.getTime() <= Date.now()) return undefined;
    const local =
      authority.intentKind === "recovery"
        ? await finalizeCabinetScannerRecoveryInTransaction(
            tx,
            authority,
            tokenHash,
            state,
          )
        : await finalizeCabinetScannerRegistrationInTransaction(
            tx,
            state,
            authority.email,
          );
    if (!local) return undefined;
    const completedAt = new Date();
    await tx.insert(scannerIdentityCompletions).values({
      receiptId: consumed.receipt_id,
      tokenHash,
      intentKind: authority.intentKind,
      stateHash,
      leadId: local.leadId,
      scanId: local.scanId,
      completedAt,
      retainUntil: new Date(completedAt.getTime() + COMPLETION_RETENTION_MS),
    });
    return local;
  });

  if (!finalized) {
    const completed = (
      await getDatabase()
        .db.select()
        .from(scannerIdentityCompletions)
        .where(eq(scannerIdentityCompletions.receiptId, consumed.receipt_id))
        .limit(1)
    )[0];
    if (!completed) return undefined;
    const acknowledged = await client.acknowledgeReportLink({
      receiptId: consumed.receipt_id,
      tokenHash,
    });
    if (acknowledged.status !== "completed") return undefined;
    return undefined;
  }

  const acknowledged = await client.acknowledgeReportLink({
    receiptId: consumed.receipt_id,
    tokenHash,
  });
  if (acknowledged.status !== "completed") {
    throw new CabinetIdentityUnavailableError();
  }

  let cabinetActionUrl: string | undefined;
  try {
    const issued = await client.issueCabinetLink({
      receiptId: consumed.receipt_id,
      tokenHash,
    });
    if (issued.status === "issued") cabinetActionUrl = issued.action_url;
  } catch {
    // Report access is already committed. The ordinary report control mails a
    // fresh cabinet link when the one-shot transition could not be returned.
  }
  return {
    scanId: finalized.scanId,
    sessionToken: finalized.sessionToken,
    ...(cabinetActionUrl ? { cabinetActionUrl } : {}),
  };
}

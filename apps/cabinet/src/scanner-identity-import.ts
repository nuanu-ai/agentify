/**
 * The stopped, one-way scanner identity import.
 *
 * This module deliberately knows the two old table shapes and the one cabinet
 * target shape. It is not a migration framework. The caller stops both
 * writers, reads one snapshot, applies the cabinet schema migration, and then
 * gives the resulting plan back to the transactional import boundary below.
 * Scanner cleanup is a later, separately verified operation.
 *
 * Errors carry closed status codes only. Source rows contain addresses,
 * ciphertext, tokens and merchant keys, so neither a row nor a database error
 * is allowed to become an exception message or a log line here.
 */

import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

const HASH_43 = /^[A-Za-z0-9_-]{43}$/;
const HASH_64 = /^[a-f0-9]{64}$/;
const UTC_MICROSECOND = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/;
const ELIGIBLE_SCAN = new Set(["completed", "partial"]);

export type CabinetAccountImportRow = {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  createdAt: string;
  updatedAt: string;
  merchantId: string | null;
  merchantKey: string | null;
};

export type ScannerAuthUserImportRow = {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type ScannerLeadImportRow = {
  id: string;
  scannerAuthUserId: string | null;
  emailNormalizedCiphertext: string;
  emailLookupHash: string;
  verifiedAt: string | null;
  deletionRequestedAt: string | null;
  anonymizedAt: string | null;
};

export type ScannerVerificationImportRow = {
  id: string;
  identifier: string;
  value: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type RegistrationIntentImportRow = {
  id: string;
  scanId: string;
  callbackStateHash: string;
  emailNormalizedCiphertext: string;
  emailLookupHash: string;
  expiresAt: string;
  consumedAt: string | null;
};

export type ScanImportRow = {
  id: string;
  status: string;
  acceptedAt: string;
  finishedAt: string | null;
};

export type LeadScanImportRow = { leadId: string; scanId: string };
export type WaitlistEntryImportRow = { leadId: string; scanId: string };

export type ScannerIdentityImportSnapshot = {
  cabinetAccounts: CabinetAccountImportRow[];
  scannerUsers: ScannerAuthUserImportRow[];
  scannerLeads: ScannerLeadImportRow[];
  scannerVerifications: ScannerVerificationImportRow[];
  registrationIntents: RegistrationIntentImportRow[];
  scans: ScanImportRow[];
  leadScans: LeadScanImportRow[];
  waitlistEntries: WaitlistEntryImportRow[];
};

export type PlannedVerificationImportRow = ScannerVerificationImportRow;

/** The validated projection written to the additive scanner recovery table. */
export type PlannedRecoveryIntent = {
  id: string;
  tokenHash: string;
  stateHash: string;
  emailLookupHash: string;
  leadId: string;
  scanId: string;
  createdAt: string;
  expiresAt: string;
};

export type ScannerIdentityImportPlan = {
  baselineCabinetAccounts: CabinetAccountImportRow[];
  accounts: CabinetAccountImportRow[];
  verifications: PlannedVerificationImportRow[];
  recoveryIntents: PlannedRecoveryIntent[];
  counts: {
    preservedCabinetAccounts: number;
    insertedAccounts: number;
    importedVerifications: number;
    plannedRecoveryIntents: number;
    skippedExpiredVerifications: number;
  };
};

export class IdentityImportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "IdentityImportError";
  }
}

export type ScannerIdentityPlanningOptions = {
  now: Date;
  emailEncryptionKey: Buffer;
  tokenHmacSecret: string;
  /** Original cabinet ids retained by the private, aggregate preflight record. */
  originalCabinetAccountIds?: readonly string[];
};

type LiveLead = ScannerLeadImportRow & { email: string };
type ValidatedRegistrationIntent = RegistrationIntentImportRow & { email: string };

const refuse = (code: string): never => {
  throw new IdentityImportError(code);
};

const cabinetEmail = (value: string): string => value.trim().toLowerCase();
const scannerEmail = (value: string): string => value.trim().normalize("NFKC").toLowerCase();
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const lookupHash = (secret: string, email: string): string =>
  createHmac("sha256", secret).update(`email\0${email}`).digest("hex");

const DNS_UUID_NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");

/** A stable new row id; it never reuses or infers a person or Supabase id. */
function recoveryIntentId(tokenHash: string): string {
  const bytes = createHash("sha1")
    .update(DNS_UUID_NAMESPACE)
    .update(`agentify:scanner-recovery-intent:${tokenHash}`)
    .digest()
    .subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sameSecret(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function decryptedEmail(ciphertext: string, key: Buffer, failure: string): string {
  try {
    const [version, rawIv, rawTag, rawBody, extra] = ciphertext.split(".");
    if (version !== "v1" || extra !== undefined) refuse(failure);
    const iv = rawIv ?? refuse(failure);
    const tag = rawTag ?? refuse(failure);
    const body = rawBody ?? refuse(failure);
    if (iv === "" || tag === "" || body === "") refuse(failure);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof IdentityImportError) throw error;
    return refuse(failure);
  }
}

function requireText(value: string, code: string): void {
  if (value === "") refuse(code);
}

function requireDate(value: Date, code: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) refuse(code);
}

function requireTimestamp(value: string, code: string): void {
  const match = UTC_MICROSECOND.exec(value) ?? refuse(code);
  const millisecondTimestamp = `${match[1]}Z`;
  if (new Date(millisecondTimestamp).toISOString() !== millisecondTimestamp) refuse(code);
}

function frozenTimestamp(value: Date): string {
  const result = value.toISOString().replace(/Z$/, "000Z");
  if (!UTC_MICROSECOND.test(result)) refuse("frozen_time_invalid");
  return result;
}

function exactAccount(left: CabinetAccountImportRow, right: CabinetAccountImportRow): boolean {
  return (
    left.id === right.id &&
    left.email === right.email &&
    left.emailVerified === right.emailVerified &&
    left.name === right.name &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.merchantId === right.merchantId &&
    left.merchantKey === right.merchantKey
  );
}

function exactVerification(
  left: PlannedVerificationImportRow,
  right: PlannedVerificationImportRow,
): boolean {
  return (
    left.id === right.id &&
    left.identifier === right.identifier &&
    left.value === right.value &&
    left.expiresAt === right.expiresAt &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function uniqueBy<T>(rows: readonly T[], keyOf: (row: T) => string, code: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    if (result.has(key)) refuse(code);
    result.set(key, row);
  }
  return result;
}

function resolveCabinetEmail(
  email: string,
  cabinetByCabinetEmail: ReadonlyMap<string, CabinetAccountImportRow>,
  cabinetByScannerEmail: ReadonlyMap<string, CabinetAccountImportRow>,
): CabinetAccountImportRow | undefined {
  const byCabinet = cabinetByCabinetEmail.get(cabinetEmail(email));
  const byScanner = cabinetByScannerEmail.get(scannerEmail(email));
  if ((byCabinet === undefined) !== (byScanner === undefined) || byCabinet !== byScanner) {
    refuse("email_normalization_collision");
  }
  return byCabinet;
}

function pairKey(leadId: string, scanId: string): string {
  return `${leadId.length}:${leadId}${scanId}`;
}

function compareNewest(left: ScanImportRow, right: ScanImportRow): number {
  const leftFinished = left.finishedAt ?? "";
  const rightFinished = right.finishedAt ?? "";
  return (
    rightFinished.localeCompare(leftFinished) || right.acceptedAt.localeCompare(left.acceptedAt)
  );
}

function claimFrom(value: string): {
  email: string;
  purpose: "registration" | "recovery";
  state: string;
} {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return refuse("verification_claim_invalid");
    }
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(",") !== "email,purpose,state") refuse("verification_claim_invalid");
    if (typeof record.email !== "string" || record.email !== scannerEmail(record.email)) {
      refuse("verification_email_not_normalized");
    }
    if (record.purpose !== "registration" && record.purpose !== "recovery") {
      refuse("verification_claim_invalid");
    }
    if (typeof record.state !== "string" || !HASH_43.test(record.state)) {
      refuse("verification_claim_invalid");
    }
    return {
      email: record.email as string,
      purpose: record.purpose as "registration" | "recovery",
      state: record.state as string,
    };
  } catch (error) {
    if (error instanceof IdentityImportError) throw error;
    return refuse("verification_claim_invalid");
  }
}

/**
 * Builds the complete deterministic projection before any target mutation.
 */
export function planScannerIdentityImport(
  snapshot: ScannerIdentityImportSnapshot,
  secrets: ScannerIdentityPlanningOptions,
): ScannerIdentityImportPlan {
  requireDate(secrets.now, "frozen_time_invalid");
  const frozenAt = frozenTimestamp(secrets.now);
  if (secrets.emailEncryptionKey.length !== 32) refuse("email_encryption_key_invalid");
  if (secrets.tokenHmacSecret.length < 32) refuse("token_hmac_secret_invalid");

  const allCabinetById = new Map<string, CabinetAccountImportRow>();
  for (const account of snapshot.cabinetAccounts) {
    requireText(account.id, "cabinet_account_invalid");
    requireTimestamp(account.createdAt, "cabinet_account_invalid");
    requireTimestamp(account.updatedAt, "cabinet_account_invalid");
    if (account.email !== cabinetEmail(account.email)) refuse("cabinet_email_not_normalized");
    if (
      (account.merchantId === null) !== (account.merchantKey === null) ||
      account.merchantId === "" ||
      account.merchantKey === ""
    ) {
      refuse("cabinet_partial_merchant_binding");
    }
    if (allCabinetById.has(account.id)) refuse("cabinet_account_id_collision");
    allCabinetById.set(account.id, account);
  }
  const namedBaseline = secrets.originalCabinetAccountIds;
  const baselineIds =
    namedBaseline === undefined ? new Set(allCabinetById.keys()) : new Set(namedBaseline);
  if (namedBaseline !== undefined && baselineIds.size !== namedBaseline.length) {
    refuse("cabinet_baseline_account_invalid");
  }
  for (const id of baselineIds) {
    if (!allCabinetById.has(id)) refuse("cabinet_baseline_account_missing");
  }
  const baselineRows = snapshot.cabinetAccounts.filter((account) => baselineIds.has(account.id));
  const replayRows = snapshot.cabinetAccounts.filter((account) => !baselineIds.has(account.id));

  const cabinetById = new Map<string, CabinetAccountImportRow>();
  const cabinetByCabinetEmail = new Map<string, CabinetAccountImportRow>();
  const cabinetByScannerEmail = new Map<string, CabinetAccountImportRow>();
  for (const account of baselineRows) {
    const cabinetKey = cabinetEmail(account.email);
    const scannerKey = scannerEmail(account.email);
    if (cabinetByCabinetEmail.has(cabinetKey)) refuse("cabinet_email_collision");
    if (cabinetByScannerEmail.has(scannerKey)) refuse("email_normalization_collision");
    cabinetById.set(account.id, account);
    cabinetByCabinetEmail.set(cabinetKey, account);
    cabinetByScannerEmail.set(scannerKey, account);
  }

  const liveLeads: LiveLead[] = [];
  for (const lead of snapshot.scannerLeads) {
    if (lead.verifiedAt !== null) requireTimestamp(lead.verifiedAt, "scanner_lead_invalid");
    if (lead.deletionRequestedAt !== null) {
      requireTimestamp(lead.deletionRequestedAt, "scanner_lead_invalid");
    }
    if (lead.anonymizedAt !== null) requireTimestamp(lead.anonymizedAt, "scanner_lead_invalid");
    if (lead.anonymizedAt !== null) continue;
    requireText(lead.id, "scanner_lead_invalid");
    const email = decryptedEmail(
      lead.emailNormalizedCiphertext,
      secrets.emailEncryptionKey,
      "lead_email_decryption_failed",
    );
    if (email !== scannerEmail(email)) refuse("lead_email_not_normalized");
    if (!HASH_64.test(lead.emailLookupHash)) refuse("lead_email_hash_invalid");
    if (!sameSecret(lead.emailLookupHash, lookupHash(secrets.tokenHmacSecret, email))) {
      refuse("lead_email_hash_mismatch");
    }
    liveLeads.push({ ...lead, email });
  }
  uniqueBy(liveLeads, (lead) => lead.id, "scanner_lead_id_collision");
  uniqueBy(liveLeads, (lead) => lead.emailLookupHash, "scanner_lead_email_collision");

  const leadsByUser = new Map<string, LiveLead[]>();
  for (const lead of liveLeads) {
    if (lead.scannerAuthUserId === null) continue;
    const linked = leadsByUser.get(lead.scannerAuthUserId) ?? [];
    linked.push(lead);
    leadsByUser.set(lead.scannerAuthUserId, linked);
  }

  const scannerById = new Map<string, ScannerAuthUserImportRow>();
  const scannerByCabinetEmail = new Map<string, ScannerAuthUserImportRow>();
  const scannerByScannerEmail = new Map<string, ScannerAuthUserImportRow>();
  for (const user of snapshot.scannerUsers) {
    requireText(user.id, "scanner_user_invalid");
    requireTimestamp(user.createdAt, "scanner_user_invalid");
    requireTimestamp(user.updatedAt, "scanner_user_invalid");
    if (!user.emailVerified) refuse("scanner_user_unverified");
    if (user.email !== scannerEmail(user.email)) refuse("scanner_user_email_not_normalized");
    if (scannerById.has(user.id)) refuse("scanner_user_id_collision");
    if (scannerByCabinetEmail.has(cabinetEmail(user.email))) refuse("scanner_user_email_collision");
    if (scannerByScannerEmail.has(scannerEmail(user.email))) refuse("scanner_user_email_collision");
    const linked = leadsByUser.get(user.id) ?? [];
    if (linked.length === 0) refuse("scanner_user_lead_missing");
    if (linked.length !== 1) refuse("scanner_user_multiple_leads");
    const lead = linked[0] ?? refuse("scanner_user_lead_missing");
    if (lead.deletionRequestedAt !== null) refuse("scanner_user_deletion_pending");
    if (lead.verifiedAt === null) refuse("scanner_user_lead_unverified");
    if (lead.email !== user.email) refuse("scanner_user_email_mismatch");
    scannerById.set(user.id, user);
    scannerByCabinetEmail.set(cabinetEmail(user.email), user);
    scannerByScannerEmail.set(scannerEmail(user.email), user);
  }
  for (const userId of leadsByUser.keys()) {
    if (!scannerById.has(userId)) refuse("scanner_lead_user_missing");
  }

  // Include Supabase-only live leads in the two-normalization inventory. They
  // do not create a cabinet person, but they may own a pending recovery link.
  const scannerIdentityEmails = new Set<string>();
  for (const lead of liveLeads) scannerIdentityEmails.add(lead.email);
  for (const email of scannerIdentityEmails) {
    resolveCabinetEmail(email, cabinetByCabinetEmail, cabinetByScannerEmail);
  }

  const accounts: CabinetAccountImportRow[] = [];
  for (const user of snapshot.scannerUsers) {
    const byCabinet = resolveCabinetEmail(user.email, cabinetByCabinetEmail, cabinetByScannerEmail);
    const idOwner = cabinetById.get(user.id);
    if (idOwner !== undefined && idOwner !== byCabinet) refuse("scanner_id_collision");
    if (byCabinet !== undefined) continue;
    accounts.push({
      id: user.id,
      email: user.email,
      emailVerified: true,
      name: user.name,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      merchantId: null,
      merchantKey: null,
    });
  }
  accounts.sort((left, right) => left.id.localeCompare(right.id));
  const plannedAccountsById = new Map(accounts.map((row) => [row.id, row]));
  for (const replay of replayRows) {
    const expected = plannedAccountsById.get(replay.id);
    if (expected === undefined || !exactAccount(replay, expected)) {
      refuse("cabinet_target_account_conflict");
    }
  }

  const scansById = uniqueBy(snapshot.scans, (scan) => scan.id, "scanner_scan_id_collision");
  for (const scan of snapshot.scans) {
    requireTimestamp(scan.acceptedAt, "scanner_scan_invalid");
    if (scan.finishedAt !== null) requireTimestamp(scan.finishedAt, "scanner_scan_invalid");
  }
  const intentsByState = new Map<string, ValidatedRegistrationIntent[]>();
  for (const intent of snapshot.registrationIntents) {
    requireText(intent.id, "registration_intent_invalid");
    requireTimestamp(intent.expiresAt, "registration_intent_invalid");
    if (intent.consumedAt !== null) {
      requireTimestamp(intent.consumedAt, "registration_intent_invalid");
    }
    if (!HASH_64.test(intent.callbackStateHash) || !HASH_64.test(intent.emailLookupHash)) {
      refuse("registration_intent_invalid");
    }
    const email = decryptedEmail(
      intent.emailNormalizedCiphertext,
      secrets.emailEncryptionKey,
      "registration_intent_email_decryption_failed",
    );
    if (email !== scannerEmail(email)) refuse("registration_intent_email_not_normalized");
    if (!sameSecret(intent.emailLookupHash, lookupHash(secrets.tokenHmacSecret, email))) {
      refuse("registration_intent_email_hash_mismatch");
    }
    if (!scansById.has(intent.scanId)) refuse("registration_intent_scan_missing");
    const matching = intentsByState.get(intent.callbackStateHash) ?? [];
    matching.push({ ...intent, email });
    intentsByState.set(intent.callbackStateHash, matching);
  }

  const ownedPairs = new Set(snapshot.leadScans.map((row) => pairKey(row.leadId, row.scanId)));
  const waitlistPairs = new Set(
    snapshot.waitlistEntries.map((row) => pairKey(row.leadId, row.scanId)),
  );
  const activeVerificationIds = new Set<string>();
  const activeTokenHashes = new Set<string>();
  const verifications: PlannedVerificationImportRow[] = [];
  const recoveryIntents: PlannedRecoveryIntent[] = [];
  let skippedExpiredVerifications = 0;

  for (const source of snapshot.scannerVerifications) {
    requireTimestamp(source.expiresAt, "verification_row_invalid");
    requireTimestamp(source.createdAt, "verification_row_invalid");
    requireTimestamp(source.updatedAt, "verification_row_invalid");
    if (source.expiresAt <= frozenAt) {
      skippedExpiredVerifications += 1;
      continue;
    }
    requireText(source.id, "verification_row_invalid");
    if (!HASH_43.test(source.identifier)) refuse("verification_token_hash_invalid");
    if (activeVerificationIds.has(source.id)) refuse("verification_id_collision");
    if (activeTokenHashes.has(source.identifier)) refuse("verification_token_hash_collision");
    activeVerificationIds.add(source.id);
    activeTokenHashes.add(source.identifier);

    const claim = claimFrom(source.value);
    const stateHash = sha256(claim.state);
    const claimEmailHash = lookupHash(secrets.tokenHmacSecret, claim.email);
    if (claim.purpose === "registration") {
      const matching = intentsByState.get(stateHash) ?? [];
      if (matching.length !== 1) refuse("registration_claim_intent_missing");
      const intent = matching[0] ?? refuse("registration_claim_intent_missing");
      if (intent.email !== claim.email || !sameSecret(intent.emailLookupHash, claimEmailHash)) {
        refuse("registration_claim_email_mismatch");
      }
      const scan = scansById.get(intent.scanId) ?? refuse("registration_intent_scan_missing");
      if (!ELIGIBLE_SCAN.has(scan.status)) refuse("registration_claim_scan_ineligible");
      // A consumed intent is intentional here: a second still-unused email
      // link keeps its proof, while scanner finalization continues to refuse
      // replay through its existing consumed-at check.
    } else {
      const foundLead = liveLeads.find((candidate) =>
        sameSecret(candidate.emailLookupHash, claimEmailHash),
      );
      const lead = foundLead ?? refuse("recovery_target_unavailable");
      if (
        lead.verifiedAt === null ||
        lead.deletionRequestedAt !== null ||
        lead.anonymizedAt !== null
      ) {
        refuse("recovery_target_unavailable");
      }
      const hinted = (intentsByState.get(stateHash) ?? [])
        .map((intent) => scansById.get(intent.scanId))
        .filter(
          (scan): scan is ScanImportRow => scan !== undefined && ELIGIBLE_SCAN.has(scan.status),
        );
      if (hinted.length > 1) refuse("recovery_hint_ambiguous");
      let target: ScanImportRow | undefined;
      if (hinted.length === 1) {
        const scan = hinted[0] ?? refuse("recovery_hint_ambiguous");
        const key = pairKey(lead.id, scan.id);
        if (!ownedPairs.has(key) || !waitlistPairs.has(key)) refuse("recovery_hint_not_owned");
        target = scan;
      } else {
        const eligible = snapshot.scans
          .filter((scan) => {
            const key = pairKey(lead.id, scan.id);
            return ELIGIBLE_SCAN.has(scan.status) && ownedPairs.has(key) && waitlistPairs.has(key);
          })
          .sort(compareNewest);
        if (
          eligible.length > 1 &&
          compareNewest(
            eligible[0] ?? refuse("recovery_target_missing"),
            eligible[1] ?? refuse("recovery_target_missing"),
          ) === 0
        ) {
          refuse("recovery_target_ambiguous");
        }
        target = eligible[0];
      }
      const recoveryTarget = target ?? refuse("recovery_target_missing");
      recoveryIntents.push({
        id: recoveryIntentId(source.identifier),
        tokenHash: source.identifier,
        stateHash,
        emailLookupHash: lead.emailLookupHash,
        leadId: lead.id,
        scanId: recoveryTarget.id,
        createdAt: source.createdAt,
        expiresAt: source.expiresAt,
      });
    }

    resolveCabinetEmail(claim.email, cabinetByCabinetEmail, cabinetByScannerEmail);

    verifications.push({
      id: source.id,
      identifier: source.identifier,
      value: JSON.stringify({
        email: claim.email,
        purpose: "report",
        intentKind: claim.purpose,
        state: claim.state,
      }),
      expiresAt: source.expiresAt,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    });
  }

  verifications.sort((left, right) => left.id.localeCompare(right.id));
  recoveryIntents.sort((left, right) => left.tokenHash.localeCompare(right.tokenHash));
  const baselineCabinetAccounts = baselineRows
    .map((row) => ({ ...row }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    baselineCabinetAccounts,
    accounts,
    verifications,
    recoveryIntents,
    counts: {
      preservedCabinetAccounts: baselineCabinetAccounts.length,
      insertedAccounts: accounts.length,
      importedVerifications: verifications.length,
      plannedRecoveryIntents: recoveryIntents.length,
      skippedExpiredVerifications,
    },
  };
}

type Queryable = {
  query<Row extends QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
};

/** Reads only the named source projections. It performs no mutation. */
export async function readScannerIdentityImportSnapshot(
  cabinet: Queryable,
  scanner: Queryable,
): Promise<ScannerIdentityImportSnapshot> {
  try {
    const [
      cabinetAccounts,
      scannerUsers,
      scannerLeads,
      scannerVerifications,
      registrationIntents,
      scans,
      leadScans,
      waitlistEntries,
    ] = await Promise.all([
      cabinet.query<CabinetAccountImportRow>(`
        select id, email, email_verified as "emailVerified", name,
               to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
               to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt",
               merchant_id as "merchantId", merchant_key as "merchantKey"
          from cabinet_accounts
      `),
      scanner.query<ScannerAuthUserImportRow>(`
        select id, email, email_verified as "emailVerified", name,
               to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
               to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
          from scanner_auth_users
      `),
      scanner.query<ScannerLeadImportRow>(`
        select id, scanner_auth_user_id as "scannerAuthUserId",
               email_normalized_ciphertext as "emailNormalizedCiphertext",
               email_lookup_hash as "emailLookupHash",
               to_char(verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "verifiedAt",
               to_char(deletion_requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "deletionRequestedAt",
               to_char(anonymized_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "anonymizedAt"
          from leads
      `),
      scanner.query<ScannerVerificationImportRow>(`
        select id, identifier, value,
               to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt",
               to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
               to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
          from scanner_auth_verifications
      `),
      scanner.query<RegistrationIntentImportRow>(`
        select id, scan_id as "scanId", callback_state_hash as "callbackStateHash",
               email_normalized_ciphertext as "emailNormalizedCiphertext",
               email_lookup_hash as "emailLookupHash",
               to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt",
               to_char(consumed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "consumedAt"
          from registration_intents
      `),
      scanner.query<ScanImportRow>(`
        select id, status,
               to_char(accepted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "acceptedAt",
               to_char(finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "finishedAt"
          from scans
      `),
      scanner.query<LeadScanImportRow>(`
        select lead_id as "leadId", scan_id as "scanId" from lead_scans
      `),
      scanner.query<WaitlistEntryImportRow>(`
        select lead_id as "leadId", scan_id as "scanId" from waitlist_entries
      `),
    ]);
    return {
      cabinetAccounts: cabinetAccounts.rows,
      scannerUsers: scannerUsers.rows,
      scannerLeads: scannerLeads.rows,
      scannerVerifications: scannerVerifications.rows,
      registrationIntents: registrationIntents.rows,
      scans: scans.rows,
      leadScans: leadScans.rows,
      waitlistEntries: waitlistEntries.rows,
    };
  } catch {
    return refuse("identity_import_snapshot_read_failed");
  }
}

async function currentAccounts(client: Queryable): Promise<CabinetAccountImportRow[]> {
  return (
    await client.query<CabinetAccountImportRow>(`
      select id, email, email_verified as "emailVerified", name,
             to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
             to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt",
             merchant_id as "merchantId", merchant_key as "merchantKey"
        from cabinet_accounts
    `)
  ).rows;
}

async function currentVerifications(client: Queryable): Promise<PlannedVerificationImportRow[]> {
  return (
    await client.query<PlannedVerificationImportRow>(`
      select id, identifier, value,
             to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt",
             to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
             to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
        from cabinet_verifications
    `)
  ).rows;
}

function verifyTargetAccounts(
  current: readonly CabinetAccountImportRow[],
  plan: ScannerIdentityImportPlan,
): void {
  const baseline = new Map(plan.baselineCabinetAccounts.map((row) => [row.id, row]));
  const imported = new Map(plan.accounts.map((row) => [row.id, row]));
  const seen = new Set<string>();
  for (const row of current) {
    if (seen.has(row.id)) refuse("cabinet_target_account_conflict");
    seen.add(row.id);
    const expected = baseline.get(row.id) ?? imported.get(row.id);
    if (expected === undefined || !exactAccount(row, expected)) {
      refuse("cabinet_target_account_conflict");
    }
  }
  for (const row of baseline.values()) {
    if (!seen.has(row.id)) refuse("cabinet_baseline_account_changed");
  }
}

function verifyTargetVerifications(
  current: readonly PlannedVerificationImportRow[],
  plan: ScannerIdentityImportPlan,
): void {
  const expected = new Map(plan.verifications.map((row) => [row.id, row]));
  const identifiers = new Set<string>();
  for (const row of current) {
    if (identifiers.has(row.identifier)) refuse("cabinet_target_verification_conflict");
    identifiers.add(row.identifier);
    const planned = expected.get(row.id);
    if (planned === undefined || !exactVerification(row, planned)) {
      refuse("cabinet_target_verification_conflict");
    }
  }
}

export type ScannerIdentityImportResult = {
  insertedAccounts: number;
  repeatedAccounts: number;
  insertedVerifications: number;
  repeatedVerifications: number;
  plannedRecoveryIntents: number;
};

export type ScannerRecoveryIntentImportResult = {
  insertedRecoveryIntents: number;
  repeatedRecoveryIntents: number;
};

type StoredRecoveryIntent = Omit<PlannedRecoveryIntent, "tokenHash"> & {
  tokenHash: string | null;
  activatedAt: string | null;
  consumedAt: string | null;
};

function exactRecoveryIntent(
  current: StoredRecoveryIntent,
  planned: PlannedRecoveryIntent,
): boolean {
  return (
    current.tokenHash === planned.tokenHash &&
    current.stateHash === planned.stateHash &&
    current.emailLookupHash === planned.emailLookupHash &&
    current.leadId === planned.leadId &&
    current.scanId === planned.scanId &&
    current.createdAt === planned.createdAt &&
    current.expiresAt === planned.expiresAt &&
    current.activatedAt === planned.createdAt &&
    current.consumedAt === null
  );
}

async function currentRecoveryIntents(client: Queryable): Promise<StoredRecoveryIntent[]> {
  return (
    await client.query<StoredRecoveryIntent>(`
      select id::text, token_hash as "tokenHash", state_hash as "stateHash",
             email_lookup_hash as "emailLookupHash", lead_id::text as "leadId",
             scan_id::text as "scanId",
             to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
             to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt",
             to_char(activated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "activatedAt",
             to_char(consumed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "consumedAt"
        from scanner_recovery_intents
    `)
  ).rows;
}

function verifyTargetRecoveryIntents(
  current: readonly StoredRecoveryIntent[],
  plan: ScannerIdentityImportPlan,
): void {
  const plannedByToken = new Map(plan.recoveryIntents.map((row) => [row.tokenHash, row]));
  const seen = new Set<string>();
  for (const row of current) {
    const tokenHash = row.tokenHash ?? refuse("scanner_target_recovery_conflict");
    if (seen.has(tokenHash)) refuse("scanner_target_recovery_conflict");
    seen.add(tokenHash);
    const planned = plannedByToken.get(tokenHash);
    if (planned === undefined || !exactRecoveryIntent(row, planned)) {
      refuse("scanner_target_recovery_conflict");
    }
  }
  if (current.length !== plan.recoveryIntents.length) {
    refuse("scanner_target_recovery_projection_mismatch");
  }
}

/**
 * Materializes only imported, already-active old recovery links after the new
 * scanner schema exists. Ordinary new recovery sends remain scanner-owned.
 */
export async function importScannerRecoveryIntents(
  pool: Pool,
  plan: ScannerIdentityImportPlan,
): Promise<ScannerRecoveryIntentImportResult> {
  const client = await pool.connect().catch(() => refuse("identity_import_database_unavailable"));
  try {
    await client.query("begin isolation level serializable");
    await client.query("lock table scanner_recovery_intents in exclusive mode");
    const current = await currentRecoveryIntents(client);
    const plannedByToken = new Map(plan.recoveryIntents.map((row) => [row.tokenHash, row]));
    const existingTokens = new Set<string>();
    for (const row of current) {
      const tokenHash = row.tokenHash ?? refuse("scanner_target_recovery_conflict");
      if (existingTokens.has(tokenHash)) refuse("scanner_target_recovery_conflict");
      existingTokens.add(tokenHash);
      const planned = plannedByToken.get(tokenHash);
      if (planned === undefined || !exactRecoveryIntent(row, planned)) {
        refuse("scanner_target_recovery_conflict");
      }
    }

    for (const row of plan.recoveryIntents) {
      if (existingTokens.has(row.tokenHash)) continue;
      const inserted = await client.query<{ id: string }>(
        `insert into scanner_recovery_intents
           (id, token_hash, state_hash, email_lookup_hash, lead_id, scan_id,
            created_at, expires_at, activated_at, consumed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $7, null)
         on conflict do nothing
         returning id`,
        [
          row.id,
          row.tokenHash,
          row.stateHash,
          row.emailLookupHash,
          row.leadId,
          row.scanId,
          row.createdAt,
          row.expiresAt,
        ],
      );
      if (inserted.rows.length !== 1) refuse("scanner_target_recovery_conflict");
    }

    const after = await currentRecoveryIntents(client);
    verifyTargetRecoveryIntents(after, plan);
    await client.query("commit");
    return {
      insertedRecoveryIntents: plan.recoveryIntents.filter(
        (row) => !existingTokens.has(row.tokenHash),
      ).length,
      repeatedRecoveryIntents: plan.recoveryIntents.filter((row) =>
        existingTokens.has(row.tokenHash),
      ).length,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (error instanceof IdentityImportError) throw error;
    return refuse("identity_import_database_failed");
  } finally {
    client.release();
  }
}

export type ScannerIdentityVerificationResult = {
  cabinetAccounts: number;
  cabinetVerifications: number;
  scannerRecoveryIntents: number;
};

/**
 * Reads both stopped targets after import and proves the complete projection.
 * It runs in read-only transactions and cannot fill in a missing target row.
 */
export async function verifyScannerIdentityImport(
  cabinetPool: Pool,
  scannerPool: Pool,
  plan: ScannerIdentityImportPlan,
): Promise<ScannerIdentityVerificationResult> {
  const cabinet = await cabinetPool
    .connect()
    .catch(() => refuse("identity_import_database_unavailable"));
  let scanner: PoolClient | undefined;
  try {
    scanner = await scannerPool
      .connect()
      .catch(() => refuse("identity_import_database_unavailable"));
    await Promise.all([
      cabinet.query("begin isolation level repeatable read read only"),
      scanner.query("begin isolation level repeatable read read only"),
    ]);
    const recoveryIntentsPromise = currentRecoveryIntents(scanner);
    const legacy = await cabinet.query<{ credentials: number; sessions: number }>(`
        select
          (select count(*)::int from cabinet_credentials) as credentials,
          (select count(*)::int from cabinet_sessions) as sessions
      `);
    const accounts = await currentAccounts(cabinet);
    const verifications = await currentVerifications(cabinet);
    const recoveryIntents = await recoveryIntentsPromise;
    if (legacy.rows[0]?.credentials !== 0 || legacy.rows[0]?.sessions !== 0) {
      refuse("cabinet_identity_schema_not_cut_over");
    }
    verifyTargetAccounts(accounts, plan);
    verifyTargetVerifications(verifications, plan);
    if (
      accounts.length !== plan.baselineCabinetAccounts.length + plan.accounts.length ||
      verifications.length !== plan.verifications.length
    ) {
      refuse("cabinet_target_projection_mismatch");
    }
    verifyTargetRecoveryIntents(recoveryIntents, plan);
    await Promise.all([cabinet.query("commit"), scanner.query("commit")]);
    return {
      cabinetAccounts: accounts.length,
      cabinetVerifications: verifications.length,
      scannerRecoveryIntents: recoveryIntents.length,
    };
  } catch (error) {
    await Promise.allSettled([cabinet.query("rollback"), scanner?.query("rollback")]);
    if (error instanceof IdentityImportError) throw error;
    return refuse("identity_import_database_failed");
  } finally {
    scanner?.release();
    cabinet.release();
  }
}

/**
 * Imports only cabinet P1 and current verification rows. The caller applies
 * the scanner recovery projection through the separate boundary above.
 */
export async function importScannerIdentityPlan(
  pool: Pool,
  plan: ScannerIdentityImportPlan,
): Promise<ScannerIdentityImportResult> {
  const client = await pool.connect().catch(() => refuse("identity_import_database_unavailable"));
  try {
    await client.query("begin isolation level serializable");
    await client.query("lock table cabinet_accounts, cabinet_verifications in exclusive mode");
    const legacy = await client.query<{ credentials: number; sessions: number }>(`
      select
        (select count(*)::int from cabinet_credentials) as credentials,
        (select count(*)::int from cabinet_sessions) as sessions
    `);
    if (legacy.rows[0]?.credentials !== 0 || legacy.rows[0]?.sessions !== 0) {
      refuse("cabinet_identity_schema_not_cut_over");
    }

    const beforeAccounts = await currentAccounts(client);
    const beforeVerifications = await currentVerifications(client);
    verifyTargetAccounts(beforeAccounts, plan);
    verifyTargetVerifications(beforeVerifications, plan);
    const existingAccountIds = new Set(beforeAccounts.map((row) => row.id));
    const existingVerificationIds = new Set(beforeVerifications.map((row) => row.id));

    for (const row of plan.accounts) {
      if (existingAccountIds.has(row.id)) continue;
      const inserted = await client.query<{ id: string }>(
        `insert into cabinet_accounts
           (id, email, email_verified, name, created_at, updated_at, merchant_id, merchant_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict do nothing
         returning id`,
        [
          row.id,
          row.email,
          row.emailVerified,
          row.name,
          row.createdAt,
          row.updatedAt,
          row.merchantId,
          row.merchantKey,
        ],
      );
      if (inserted.rows.length !== 1) refuse("cabinet_target_account_conflict");
    }
    for (const row of plan.verifications) {
      if (existingVerificationIds.has(row.id)) continue;
      const inserted = await client.query<{ id: string }>(
        `insert into cabinet_verifications
           (id, identifier, value, expires_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict do nothing
         returning id`,
        [row.id, row.identifier, row.value, row.expiresAt, row.createdAt, row.updatedAt],
      );
      if (inserted.rows.length !== 1) refuse("cabinet_target_verification_conflict");
    }

    const afterAccounts = await currentAccounts(client);
    const afterVerifications = await currentVerifications(client);
    verifyTargetAccounts(afterAccounts, plan);
    verifyTargetVerifications(afterVerifications, plan);
    if (
      afterAccounts.length !== plan.baselineCabinetAccounts.length + plan.accounts.length ||
      afterVerifications.length !== plan.verifications.length
    ) {
      refuse("cabinet_target_projection_mismatch");
    }
    await client.query("commit");
    return {
      insertedAccounts: plan.accounts.filter((row) => !existingAccountIds.has(row.id)).length,
      repeatedAccounts: plan.accounts.filter((row) => existingAccountIds.has(row.id)).length,
      insertedVerifications: plan.verifications.filter(
        (row) => !existingVerificationIds.has(row.id),
      ).length,
      repeatedVerifications: plan.verifications.filter((row) => existingVerificationIds.has(row.id))
        .length,
      plannedRecoveryIntents: plan.recoveryIntents.length,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (error instanceof IdentityImportError) throw error;
    return refuse("identity_import_database_failed");
  } finally {
    client.release();
  }
}

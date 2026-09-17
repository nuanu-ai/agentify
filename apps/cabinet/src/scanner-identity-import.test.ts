import { createCipheriv, createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  IdentityImportError,
  planScannerIdentityImport,
  type ScannerIdentityImportSnapshot,
} from "./scanner-identity-import.js";

const NOW = new Date("2026-09-17T12:00:00.000Z");
const NOW_TIMESTAMP = "2026-09-17T12:00:00.000000Z";
const LATER = "2026-09-17T13:00:00.000000Z";
const BEFORE = "2026-09-17T11:59:59.000000Z";
const KEY = Buffer.alloc(32, 7);
const HMAC_SECRET = "scanner-import-test-hmac-secret-at-least-32-bytes";
const TOKEN_REGISTRATION = "a".repeat(43);
const TOKEN_RECOVERY = "b".repeat(43);
const STATE_REGISTRATION = "c".repeat(43);
const STATE_RECOVERY = "d".repeat(43);

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const emailHash = (email: string) =>
  createHmac("sha256", HMAC_SECRET).update(`email\0${email}`).digest("hex");

function at<T>(rows: T[], index: number): T {
  const row = rows[index];
  if (row === undefined) throw new Error("identity import test fixture is incomplete");
  return row;
}

function encrypted(value: string): string {
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function snapshot(): ScannerIdentityImportSnapshot {
  const owner = "owner@example.com";
  const reader = "reader@example.com";
  const pending = "pending@example.com";
  return {
    cabinetAccounts: [
      {
        id: "cabinet_owner",
        email: owner,
        emailVerified: false,
        name: "Existing seller",
        createdAt: "2026-08-01T00:00:00.000000Z",
        updatedAt: "2026-09-01T00:00:00.000000Z",
        merchantId: "merchant_owner",
        merchantKey: "merchant-key-that-must-not-escape",
      },
    ],
    scannerUsers: [
      {
        id: "scanner_owner",
        email: owner,
        emailVerified: true,
        name: "Scanner owner",
        createdAt: "2026-08-02T00:00:00.000000Z",
        updatedAt: "2026-09-02T00:00:00.000000Z",
      },
      {
        id: "scanner_reader",
        email: reader,
        emailVerified: true,
        name: "Report reader",
        createdAt: "2026-08-03T00:00:00.000000Z",
        updatedAt: "2026-09-03T00:00:00.000000Z",
      },
    ],
    scannerLeads: [
      {
        id: "lead_owner",
        scannerAuthUserId: "scanner_owner",
        emailNormalizedCiphertext: encrypted(owner),
        emailLookupHash: emailHash(owner),
        verifiedAt: "2026-08-04T00:00:00.000000Z",
        deletionRequestedAt: null,
        anonymizedAt: null,
      },
      {
        id: "lead_reader",
        scannerAuthUserId: "scanner_reader",
        emailNormalizedCiphertext: encrypted(reader),
        emailLookupHash: emailHash(reader),
        verifiedAt: "2026-08-05T00:00:00.000000Z",
        deletionRequestedAt: null,
        anonymizedAt: null,
      },
    ],
    scannerVerifications: [
      {
        id: "verification_registration",
        identifier: TOKEN_REGISTRATION,
        value: JSON.stringify({
          email: pending,
          purpose: "registration",
          state: STATE_REGISTRATION,
        }),
        expiresAt: LATER,
        createdAt: "2026-09-17T11:30:00.000000Z",
        updatedAt: "2026-09-17T11:30:00.000000Z",
      },
      {
        id: "verification_recovery",
        identifier: TOKEN_RECOVERY,
        value: JSON.stringify({ email: owner, purpose: "recovery", state: STATE_RECOVERY }),
        expiresAt: LATER,
        createdAt: "2026-09-17T11:31:00.000000Z",
        updatedAt: "2026-09-17T11:31:00.000000Z",
      },
      {
        id: "verification_naturally_expired",
        identifier: "e".repeat(43),
        value: JSON.stringify({ email: pending, purpose: "registration", state: "f".repeat(43) }),
        expiresAt: BEFORE,
        createdAt: "2026-09-17T10:00:00.000000Z",
        updatedAt: "2026-09-17T10:00:00.000000Z",
      },
    ],
    registrationIntents: [
      {
        id: "intent_pending",
        scanId: "scan_pending",
        callbackStateHash: sha256(STATE_REGISTRATION),
        emailNormalizedCiphertext: encrypted(pending),
        emailLookupHash: emailHash(pending),
        expiresAt: LATER,
        consumedAt: NOW_TIMESTAMP,
      },
    ],
    scans: [
      {
        id: "scan_owner",
        status: "completed",
        acceptedAt: "2026-09-10T10:00:00.000000Z",
        finishedAt: "2026-09-10T10:10:00.000000Z",
      },
      {
        id: "scan_pending",
        status: "completed",
        acceptedAt: "2026-09-11T10:00:00.000000Z",
        finishedAt: "2026-09-11T10:10:00.000000Z",
      },
    ],
    leadScans: [{ leadId: "lead_owner", scanId: "scan_owner" }],
    waitlistEntries: [{ leadId: "lead_owner", scanId: "scan_owner" }],
  };
}

const plan = (input = snapshot()) =>
  planScannerIdentityImport(input, {
    now: NOW,
    emailEncryptionKey: KEY,
    tokenHmacSecret: HMAC_SECRET,
  });

describe("the stopped scanner identity import plan", () => {
  it("preserves the cabinet winner and projects verified scanner-only P1 plus current claims", () => {
    const result = plan();

    expect(result.baselineCabinetAccounts).toStrictEqual(snapshot().cabinetAccounts);
    expect(result.accounts).toStrictEqual([
      {
        id: "scanner_reader",
        email: "reader@example.com",
        emailVerified: true,
        name: "Report reader",
        createdAt: "2026-08-03T00:00:00.000000Z",
        updatedAt: "2026-09-03T00:00:00.000000Z",
        merchantId: null,
        merchantKey: null,
      },
    ]);
    expect(result.verifications).toHaveLength(2);
    const registration = result.verifications.find((row) => row.id === "verification_registration");
    expect(JSON.parse(registration?.value ?? "")).toStrictEqual({
      email: "pending@example.com",
      purpose: "report",
      intentKind: "registration",
      state: STATE_REGISTRATION,
    });
    expect(registration).toMatchObject({
      id: "verification_registration",
      identifier: TOKEN_REGISTRATION,
      expiresAt: LATER,
    });
    expect(result.recoveryIntents).toStrictEqual([
      {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        tokenHash: TOKEN_RECOVERY,
        stateHash: sha256(STATE_RECOVERY),
        emailLookupHash: emailHash("owner@example.com"),
        leadId: "lead_owner",
        scanId: "scan_owner",
        createdAt: "2026-09-17T11:31:00.000000Z",
        expiresAt: LATER,
      },
    ]);
    expect(result.counts).toStrictEqual({
      preservedCabinetAccounts: 1,
      insertedAccounts: 1,
      importedVerifications: 2,
      plannedRecoveryIntents: 1,
      skippedExpiredVerifications: 1,
    });
  });

  it("keeps equal recovery states distinct by token hash", () => {
    const input = snapshot();
    input.scannerVerifications.push({
      ...at(input.scannerVerifications, 1),
      id: "verification_recovery_second",
      identifier: "g".repeat(43),
    });

    expect(plan(input).recoveryIntents).toEqual([
      expect.objectContaining({ tokenHash: TOKEN_RECOVERY, stateHash: sha256(STATE_RECOVERY) }),
      expect.objectContaining({ tokenHash: "g".repeat(43), stateHash: sha256(STATE_RECOVERY) }),
    ]);
  });

  it("uses an owned state hint and refuses an unowned hint instead of falling back", () => {
    const input = snapshot();
    input.registrationIntents.push({
      id: "intent_recovery_hint",
      scanId: "scan_hint",
      callbackStateHash: sha256(STATE_RECOVERY),
      emailNormalizedCiphertext: encrypted("somebody-else@example.com"),
      emailLookupHash: emailHash("somebody-else@example.com"),
      expiresAt: BEFORE,
      consumedAt: NOW_TIMESTAMP,
    });
    input.scans.push({
      id: "scan_hint",
      status: "partial",
      acceptedAt: "2026-09-12T10:00:00.000000Z",
      finishedAt: "2026-09-12T10:10:00.000000Z",
    });

    expect(() => plan(input)).toThrowError(new IdentityImportError("recovery_hint_not_owned"));

    input.leadScans.push({ leadId: "lead_owner", scanId: "scan_hint" });
    input.waitlistEntries.push({ leadId: "lead_owner", scanId: "scan_hint" });
    expect(plan(input).recoveryIntents[0]?.scanId).toBe("scan_hint");
  });

  it("refuses a malformed current claim but ignores a naturally expired malformed row", () => {
    const input = snapshot();
    at(input.scannerVerifications, 0).value = "contains-address@example.com but is not JSON";

    let thrown: unknown;
    try {
      plan(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toStrictEqual(new IdentityImportError("verification_claim_invalid"));
    expect(String(thrown)).not.toContain("contains-address@example.com");

    at(input.scannerVerifications, 0).expiresAt = NOW_TIMESTAMP;
    expect(plan(input).counts.skippedExpiredVerifications).toBe(2);
  });

  it("refuses a pending registration address that collides only after scanner NFKC", () => {
    const input = snapshot();
    at(input.cabinetAccounts, 0).email = "ｏwner@example.com";
    input.scannerUsers.splice(0, 1);
    input.scannerLeads.splice(0, 1);
    input.scannerVerifications.splice(1, 1);
    input.leadScans = [];
    input.waitlistEntries = [];
    at(input.scannerVerifications, 0).value = JSON.stringify({
      email: "owner@example.com",
      purpose: "registration",
      state: STATE_REGISTRATION,
    });
    at(input.registrationIntents, 0).emailNormalizedCiphertext = encrypted("owner@example.com");
    at(input.registrationIntents, 0).emailLookupHash = emailHash("owner@example.com");

    expect(() => plan(input)).toThrowError(
      new IdentityImportError("email_normalization_collision"),
    );
  });

  it("accepts a pending registration address identical to an existing cabinet winner", () => {
    const input = snapshot();
    input.scannerUsers.splice(0, 1);
    input.scannerLeads.splice(0, 1);
    input.scannerVerifications.splice(1, 1);
    input.leadScans = [];
    input.waitlistEntries = [];
    at(input.scannerVerifications, 0).value = JSON.stringify({
      email: "owner@example.com",
      purpose: "registration",
      state: STATE_REGISTRATION,
    });
    at(input.registrationIntents, 0).emailNormalizedCiphertext = encrypted("owner@example.com");
    at(input.registrationIntents, 0).emailLookupHash = emailHash("owner@example.com");

    const result = plan(input);
    expect(result.baselineCabinetAccounts).toStrictEqual(input.cabinetAccounts);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.email).toBe("reader@example.com");
    expect(result.verifications).toHaveLength(1);
  });

  it("classifies equal, future, and past expiry at exact microsecond precision", () => {
    const input = snapshot();
    const registration = at(input.scannerVerifications, 0);

    registration.expiresAt = NOW_TIMESTAMP;
    expect(plan(input).counts.skippedExpiredVerifications).toBe(2);

    registration.expiresAt = "2026-09-17T12:00:00.000001Z";
    const oneMicrosecondFuture = plan(input);
    expect(oneMicrosecondFuture.counts.skippedExpiredVerifications).toBe(1);
    expect(
      oneMicrosecondFuture.verifications.find((row) => row.id === registration.id)?.expiresAt,
    ).toBe("2026-09-17T12:00:00.000001Z");

    registration.expiresAt = "2026-09-17T11:59:59.999999Z";
    expect(plan(input).counts.skippedExpiredVerifications).toBe(2);
  });

  it.each([
    [
      "a partial cabinet merchant pair",
      (input: ScannerIdentityImportSnapshot) => {
        at(input.cabinetAccounts, 0).merchantKey = null;
      },
      "cabinet_partial_merchant_binding",
    ],
    [
      "an unclassified cabinet email",
      (input: ScannerIdentityImportSnapshot) => {
        at(input.cabinetAccounts, 0).email = "Owner@example.com";
      },
      "cabinet_email_not_normalized",
    ],
    [
      "an NFKC-only collision",
      (input: ScannerIdentityImportSnapshot) => {
        input.cabinetAccounts.push({
          ...at(input.cabinetAccounts, 0),
          id: "cabinet_compatibility_character",
          email: "ｏwner@example.com",
          merchantId: "merchant_other",
        });
      },
      "email_normalization_collision",
    ],
    [
      "a scanner id used by another cabinet address",
      (input: ScannerIdentityImportSnapshot) => {
        input.cabinetAccounts.push({
          ...at(input.cabinetAccounts, 0),
          id: "scanner_reader",
          email: "different@example.com",
          merchantId: "merchant_other",
        });
      },
      "scanner_id_collision",
    ],
    [
      "an unverified scanner user",
      (input: ScannerIdentityImportSnapshot) => {
        at(input.scannerUsers, 1).emailVerified = false;
      },
      "scanner_user_unverified",
    ],
    [
      "a corrupt encrypted lead",
      (input: ScannerIdentityImportSnapshot) => {
        at(input.scannerLeads, 1).emailNormalizedCiphertext = "not-ciphertext";
      },
      "lead_email_decryption_failed",
    ],
    [
      "a lead HMAC mismatch",
      (input: ScannerIdentityImportSnapshot) => {
        at(input.scannerLeads, 1).emailLookupHash = "0".repeat(64);
      },
      "lead_email_hash_mismatch",
    ],
    [
      "a lead bound to the wrong scanner person",
      (input: ScannerIdentityImportSnapshot) => {
        at(input.scannerLeads, 1).scannerAuthUserId = "scanner_owner";
      },
      "scanner_user_multiple_leads",
    ],
  ])("refuses %s before producing import rows", (_label, mutate, code) => {
    const input = snapshot();
    mutate(input);

    let thrown: unknown;
    try {
      plan(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toStrictEqual(new IdentityImportError(code));
    expect(String(thrown)).not.toContain("owner@example.com");
    expect(String(thrown)).not.toContain("merchant-key-that-must-not-escape");
    expect(String(thrown)).not.toContain(input.scannerLeads[1]?.emailNormalizedCiphertext ?? "");
  });
});

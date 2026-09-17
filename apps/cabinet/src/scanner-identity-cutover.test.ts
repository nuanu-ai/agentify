import { createCipheriv, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareIdentityCutover, resumeIdentityCutover } from "./scanner-identity-cutover.js";
import type { ScannerIdentityImportSnapshot } from "./scanner-identity-import.js";

const secrets = {
  emailEncryptionKey: Buffer.alloc(32, 7),
  tokenHmacSecret: "private-import-hmac-secret-with-32-bytes",
};
const now = new Date("2026-09-17T12:00:00.000Z");
function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("Missing identity fixture");
  return row;
}

function snapshot(): ScannerIdentityImportSnapshot {
  const iv = Buffer.alloc(12, 1);
  const cipher = createCipheriv("aes-256-gcm", secrets.emailEncryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update("reader@example.com", "utf8"), cipher.final()]);
  const ciphertext = `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
  return {
    cabinetAccounts: [
      {
        id: "existing",
        email: "owner@example.com",
        emailVerified: false,
        name: "Owner",
        createdAt: "2026-09-01T00:00:00.000001Z",
        updatedAt: "2026-09-01T00:00:00.000002Z",
        merchantId: "merchant",
        merchantKey: "secret-merchant-key",
      },
    ],
    scannerUsers: [
      {
        id: "reader",
        email: "reader@example.com",
        emailVerified: true,
        name: "Reader",
        createdAt: "2026-09-01T00:00:00.000003Z",
        updatedAt: "2026-09-01T00:00:00.000004Z",
      },
    ],
    scannerLeads: [
      {
        id: "lead",
        scannerAuthUserId: "reader",
        emailNormalizedCiphertext: ciphertext,
        emailLookupHash: createHmac("sha256", secrets.tokenHmacSecret)
          .update("email\0reader@example.com")
          .digest("hex"),
        verifiedAt: "2026-09-01T00:00:00.000004Z",
        deletionRequestedAt: null,
        anonymizedAt: null,
      },
    ],
    scannerVerifications: [],
    registrationIntents: [],
    scans: [],
    leadScans: [],
    waitlistEntries: [],
  };
}

describe("stopped identity cutover continuity", () => {
  it("records no address, key or row copy and reconstructs the exact planned identity", () => {
    const original = snapshot();
    const { record, plan } = prepareIdentityCutover(original, { ...secrets, now });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("@example.com");
    expect(serialized).not.toContain("secret-merchant-key");
    expect(serialized).not.toContain("Owner");
    expect(resumeIdentityCutover(original, JSON.parse(serialized), secrets)).toEqual(plan);
    expect(plan.accounts.map((row) => row.id)).toEqual(["reader"]);
  });

  it("resumes after a committed account import without reclassifying the imported reader as a baseline owner", () => {
    const original = snapshot();
    const { record, plan } = prepareIdentityCutover(original, { ...secrets, now });
    original.cabinetAccounts.push(...plan.accounts);
    expect(resumeIdentityCutover(original, record, secrets)).toEqual(plan);
  });

  it.each([
    [
      "email confirmation",
      (s: ScannerIdentityImportSnapshot) => {
        first(s.cabinetAccounts).emailVerified = true;
      },
    ],
    [
      "merchant key",
      (s: ScannerIdentityImportSnapshot) => {
        first(s.cabinetAccounts).merchantKey = "changed-key";
      },
    ],
    [
      "timestamp precision",
      (s: ScannerIdentityImportSnapshot) => {
        first(s.cabinetAccounts).updatedAt = "2026-09-01T00:00:00.000005Z";
      },
    ],
    [
      "retained lead confirmation",
      (s: ScannerIdentityImportSnapshot) => {
        first(s.scannerLeads).verifiedAt = "2026-09-01T00:00:00.000009Z";
      },
    ],
    [
      "source identity",
      (s: ScannerIdentityImportSnapshot) => {
        first(s.scannerUsers).name = "Changed";
      },
    ],
  ] as const)("refuses drift in %s before another import", (_name, mutate) => {
    const original = snapshot();
    const { record } = prepareIdentityCutover(original, { ...secrets, now });
    mutate(original);
    expect(() => resumeIdentityCutover(original, record, secrets)).toThrow(/cutover_.*_changed/);
  });

  it.each(["version", "asOf", "originalCabinetAccountIds", "planDigest", "sourceDigest"])(
    "refuses a missing %s in the persisted cutover record",
    (field) => {
      const original = snapshot();
      const { record } = prepareIdentityCutover(original, { ...secrets, now });
      const damaged: Record<string, unknown> = { ...record };
      delete damaged[field];
      expect(() => resumeIdentityCutover(original, damaged, secrets)).toThrow(
        "cutover_record_invalid",
      );
    },
  );

  it("does not depend on unordered database result order", () => {
    const original = snapshot();
    original.scans.push(
      {
        id: "b",
        status: "completed",
        acceptedAt: "2026-09-17T12:00:00.000000Z",
        finishedAt: "2026-09-17T12:00:00.000000Z",
      },
      {
        id: "a",
        status: "partial",
        acceptedAt: "2026-09-17T12:00:00.000000Z",
        finishedAt: "2026-09-17T12:00:00.000000Z",
      },
    );
    const { record, plan } = prepareIdentityCutover(original, { ...secrets, now });
    original.scans.reverse();
    expect(resumeIdentityCutover(original, record, secrets)).toEqual(plan);
  });
});

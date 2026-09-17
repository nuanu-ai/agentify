/** PostgreSQL proof for the stopped scanner-to-cabinet identity import. */

import { createCipheriv, createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  noDatabaseHere,
  readyDatabase,
  testDatabaseUrl,
} from "@agentify/commerce-gateway/testing/database";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  IdentityImportError,
  importScannerIdentityPlan,
  importScannerRecoveryIntents,
  planScannerIdentityImport,
  readScannerIdentityImportSnapshot,
  verifyScannerIdentityImport,
} from "./scanner-identity-import.js";

const NOW = new Date("2026-09-17T12:00:00.000Z");
const KEY = Buffer.alloc(32, 9);
const HMAC_SECRET = "scanner-import-db-test-hmac-secret-at-least-32-bytes";
const REGISTRATION_TOKEN = "r".repeat(43);
const RECOVERY_TOKEN = "v".repeat(43);
const REGISTRATION_STATE = "s".repeat(43);
const RECOVERY_STATE = "t".repeat(43);
const ACTIVE_EXPIRY = "2026-09-17T12:00:00.000001Z";
const LINK_CREATED = "2026-09-17T11:30:00.654321Z";
const LEAD_OWNER = "018f0000-0000-7000-8000-000000000001";
const LEAD_READER = "018f0000-0000-7000-8000-000000000002";
const SCAN_OWNER = "018f0000-0000-7000-8000-000000000003";
const SCAN_PENDING = "018f0000-0000-7000-8000-000000000004";

function ownDatabase(name: string): string {
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

const cabinetWanted = ownDatabase("agentify_identity_import_test_cabinet");
const scannerWanted = ownDatabase("agentify_identity_import_test_scanner");
const [cabinetUrl, scannerUrl] = await Promise.all([
  readyDatabase(cabinetWanted),
  readyDatabase(scannerWanted),
]);

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const emailHash = (email: string) =>
  createHmac("sha256", HMAC_SECRET).update(`email\0${email}`).digest("hex");

function encrypted(value: string): string {
  const iv = Buffer.alloc(12, 4);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

async function scannerRecoverySchemaStatements(): Promise<string[]> {
  const migration = await readFile(
    join(process.cwd(), "packages/scanner-database/migrations/0016_superb_zuras.sql"),
    "utf8",
  );
  return migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        statement.includes('"scanner_recovery_intents"') &&
        /^(CREATE TABLE|ALTER TABLE|CREATE (UNIQUE )?INDEX)/.test(statement),
    );
}

if (cabinetUrl === null || scannerUrl === null) {
  console.log(noDatabaseHere(cabinetUrl === null ? cabinetWanted : scannerWanted));
  describe("the stopped scanner identity import on PostgreSQL", () => {
    it.skip("is skipped: its isolated PostgreSQL databases are unavailable", () => undefined);
  });
} else {
  const cabinet = new Pool({ connectionString: cabinetUrl, max: 2 });
  const scanner = new Pool({ connectionString: scannerUrl, max: 2 });

  afterAll(async () => {
    await Promise.all([cabinet.end(), scanner.end()]);
  });

  beforeEach(async () => {
    await Promise.all([
      cabinet.query("drop schema public cascade; create schema public"),
      scanner.query("drop schema public cascade; create schema public"),
    ]);
    await cabinet.query(`
      create table cabinet_accounts (
        id text primary key,
        email text not null unique,
        email_verified boolean not null,
        name text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        merchant_id text,
        merchant_key text,
        constraint cabinet_accounts_complete_merchant check (
          (merchant_id is null and merchant_key is null)
          or (merchant_id is not null and merchant_key is not null
              and merchant_id <> '' and merchant_key <> '')
        )
      );
      create table cabinet_credentials (id text primary key);
      create table cabinet_sessions (id text primary key);
      create table cabinet_verifications (
        id text primary key,
        identifier text not null,
        value text not null,
        expires_at timestamptz not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
    `);
    await scanner.query(`
      create table scanner_auth_users (
        id text primary key,
        email text not null unique,
        email_verified boolean not null,
        name text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
      create table scanner_auth_verifications (
        id text primary key,
        identifier text not null,
        value text not null,
        expires_at timestamptz not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
      create table leads (
        id uuid primary key,
        scanner_auth_user_id text,
        email_normalized_ciphertext text not null,
        email_lookup_hash text not null,
        verified_at timestamptz,
        deletion_requested_at timestamptz,
        anonymized_at timestamptz
      );
      create table registration_intents (
        id text primary key,
        scan_id uuid not null,
        callback_state_hash text not null,
        email_normalized_ciphertext text not null,
        email_lookup_hash text not null,
        expires_at timestamptz not null,
        consumed_at timestamptz
      );
      create table scans (
        id uuid primary key,
        status text not null,
        accepted_at timestamptz not null,
        finished_at timestamptz
      );
      create table lead_scans (lead_id uuid not null, scan_id uuid not null);
      create table waitlist_entries (lead_id uuid not null, scan_id uuid not null);
    `);
    for (const statement of await scannerRecoverySchemaStatements()) {
      await scanner.query(statement);
    }
  });

  async function fixture(): Promise<void> {
    const owner = "owner@example.com";
    const reader = "reader@example.com";
    const pending = "pending@example.com";
    await cabinet.query(
      `insert into cabinet_accounts
         (id, email, email_verified, name, created_at, updated_at, merchant_id, merchant_key)
       values ($1, $2, false, $3, $4, $5, $6, $7)`,
      [
        "cabinet_owner",
        owner,
        "Existing seller",
        new Date("2026-08-01T00:00:00.000Z"),
        new Date("2026-09-01T00:00:00.000Z"),
        "merchant_owner",
        "merchant-key-preserved-exactly",
      ],
    );
    await scanner.query(
      `insert into scanner_auth_users
         (id, email, email_verified, name, created_at, updated_at)
       values
         ($1, $2, true, $3, $4, $5),
         ($6, $7, true, $8, $9, $10)`,
      [
        "scanner_owner",
        owner,
        "Scanner owner",
        new Date("2026-08-02T00:00:00.000Z"),
        new Date("2026-09-02T00:00:00.000Z"),
        "scanner_reader",
        reader,
        "Report reader",
        new Date("2026-08-03T00:00:00.000Z"),
        new Date("2026-09-03T00:00:00.000Z"),
      ],
    );
    await scanner.query(
      `insert into leads
         (id, scanner_auth_user_id, email_normalized_ciphertext, email_lookup_hash,
          verified_at, deletion_requested_at, anonymized_at)
       values ($1, $2, $3, $4, $5, null, null), ($6, $7, $8, $9, $10, null, null)`,
      [
        LEAD_OWNER,
        "scanner_owner",
        encrypted(owner),
        emailHash(owner),
        new Date("2026-08-04T00:00:00.000Z"),
        LEAD_READER,
        "scanner_reader",
        encrypted(reader),
        emailHash(reader),
        new Date("2026-08-05T00:00:00.000Z"),
      ],
    );
    await scanner.query(
      `insert into scans (id, status, accepted_at, finished_at)
       values ($1, 'completed', $2, $3), ($4, 'completed', $5, $6)`,
      [
        SCAN_OWNER,
        new Date("2026-09-10T10:00:00.000Z"),
        new Date("2026-09-10T10:10:00.000Z"),
        SCAN_PENDING,
        new Date("2026-09-11T10:00:00.000Z"),
        new Date("2026-09-11T10:10:00.000Z"),
      ],
    );
    await scanner.query("insert into lead_scans (lead_id, scan_id) values ($1, $2)", [
      LEAD_OWNER,
      SCAN_OWNER,
    ]);
    await scanner.query("insert into waitlist_entries (lead_id, scan_id) values ($1, $2)", [
      LEAD_OWNER,
      SCAN_OWNER,
    ]);
    await scanner.query(
      `insert into registration_intents
         (id, scan_id, callback_state_hash, email_normalized_ciphertext,
          email_lookup_hash, expires_at, consumed_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        "intent_pending",
        SCAN_PENDING,
        sha256(REGISTRATION_STATE),
        encrypted(pending),
        emailHash(pending),
        ACTIVE_EXPIRY,
        NOW,
      ],
    );
    await scanner.query(
      `insert into scanner_auth_verifications
         (id, identifier, value, expires_at, created_at, updated_at)
       values
         ($1, $2, $3, $4, $5, $5),
         ($6, $7, $8, $4, $5, $5),
         ($9, $10, $11, $12, $5, $5)`,
      [
        "registration_verification",
        REGISTRATION_TOKEN,
        JSON.stringify({ email: pending, purpose: "registration", state: REGISTRATION_STATE }),
        ACTIVE_EXPIRY,
        LINK_CREATED,
        "recovery_verification",
        RECOVERY_TOKEN,
        JSON.stringify({ email: owner, purpose: "recovery", state: RECOVERY_STATE }),
        "expired_verification",
        "x".repeat(43),
        "not-even-a-current-claim",
        new Date("2026-09-17T11:59:59.000Z"),
      ],
    );
  }

  async function planned(originalCabinetAccountIds?: readonly string[]) {
    const snapshot = await readScannerIdentityImportSnapshot(cabinet, scanner);
    return planScannerIdentityImport(snapshot, {
      now: NOW,
      emailEncryptionKey: KEY,
      tokenHmacSecret: HMAC_SECRET,
      originalCabinetAccountIds,
    });
  }

  describe("the stopped scanner identity import on PostgreSQL", () => {
    it("imports once, accepts an exact repeat, and preserves the cabinet winner", async () => {
      await fixture();
      const before = (
        await cabinet.query("select to_jsonb(cabinet_accounts.*) as row from cabinet_accounts")
      ).rows[0]?.row;
      const plan = await planned();

      await expect(importScannerIdentityPlan(cabinet, plan)).resolves.toStrictEqual({
        insertedAccounts: 1,
        repeatedAccounts: 0,
        insertedVerifications: 2,
        repeatedVerifications: 0,
        plannedRecoveryIntents: 1,
      });
      await expect(importScannerRecoveryIntents(scanner, plan)).resolves.toStrictEqual({
        insertedRecoveryIntents: 1,
        repeatedRecoveryIntents: 0,
      });
      const reconstructed = await planned(["cabinet_owner"]);
      expect(reconstructed.accounts).toHaveLength(1);
      await expect(importScannerIdentityPlan(cabinet, reconstructed)).resolves.toStrictEqual({
        insertedAccounts: 0,
        repeatedAccounts: 1,
        insertedVerifications: 0,
        repeatedVerifications: 2,
        plannedRecoveryIntents: 1,
      });
      await expect(importScannerRecoveryIntents(scanner, reconstructed)).resolves.toStrictEqual({
        insertedRecoveryIntents: 0,
        repeatedRecoveryIntents: 1,
      });
      await expect(
        verifyScannerIdentityImport(cabinet, scanner, reconstructed),
      ).resolves.toStrictEqual({
        cabinetAccounts: 2,
        cabinetVerifications: 2,
        scannerRecoveryIntents: 1,
      });

      expect(
        (
          await cabinet.query(
            "select to_jsonb(cabinet_accounts.*) as row from cabinet_accounts where id=$1",
            ["cabinet_owner"],
          )
        ).rows[0]?.row,
      ).toStrictEqual(before);
      expect(
        (
          await cabinet.query(
            `select id, email, email_verified, name, merchant_id, merchant_key
               from cabinet_accounts where id=$1`,
            ["scanner_reader"],
          )
        ).rows,
      ).toStrictEqual([
        {
          id: "scanner_reader",
          email: "reader@example.com",
          email_verified: true,
          name: "Report reader",
          merchant_id: null,
          merchant_key: null,
        },
      ]);
      expect(
        (await cabinet.query("select count(*)::int as count from cabinet_verifications")).rows[0],
      ).toStrictEqual({ count: 2 });
      expect(plan.counts.skippedExpiredVerifications).toBe(1);
      expect(plan.recoveryIntents).toHaveLength(1);
      expect(
        (
          await cabinet.query(
            `select to_char(expires_at at time zone 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expiry
               from cabinet_verifications where id=$1`,
            ["registration_verification"],
          )
        ).rows[0],
      ).toStrictEqual({ expiry: ACTIVE_EXPIRY });
      expect(
        (
          await scanner.query(
            `select to_char(expires_at at time zone 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expiry
               from scanner_recovery_intents where token_hash=$1`,
            [RECOVERY_TOKEN],
          )
        ).rows[0],
      ).toStrictEqual({ expiry: ACTIVE_EXPIRY });
    });

    it("rolls back the whole import when an existing target row conflicts", async () => {
      await fixture();
      const plan = await planned();
      const registration = plan.verifications.find((row) => row.id === "registration_verification");
      if (registration === undefined) throw new Error("registration fixture is missing");
      await cabinet.query(
        `insert into cabinet_verifications
           (id, identifier, value, expires_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $5)`,
        [
          "registration_verification",
          registration.identifier,
          "conflicting-target-value",
          registration.expiresAt,
          registration.createdAt,
        ],
      );

      await expect(importScannerIdentityPlan(cabinet, plan)).rejects.toStrictEqual(
        new IdentityImportError("cabinet_target_verification_conflict"),
      );
      expect(
        (await cabinet.query("select count(*)::int as count from cabinet_accounts")).rows[0],
      ).toStrictEqual({ count: 1 });
    });

    it("refuses to import before the cabinet password/session purge", async () => {
      await fixture();
      const plan = await planned();
      await cabinet.query("insert into cabinet_sessions (id) values ($1)", ["legacy-session"]);

      await expect(importScannerIdentityPlan(cabinet, plan)).rejects.toStrictEqual(
        new IdentityImportError("cabinet_identity_schema_not_cut_over"),
      );
      expect(
        (await cabinet.query("select count(*)::int as count from cabinet_accounts")).rows[0],
      ).toStrictEqual({ count: 1 });
    });

    it("accepts a semantic recovery repeat with another surrogate id and refuses changed data", async () => {
      await fixture();
      const plan = await planned();
      const recovery = plan.recoveryIntents[0];
      if (recovery === undefined) throw new Error("recovery fixture is missing");
      await scanner.query(
        `insert into scanner_recovery_intents
           (id, token_hash, state_hash, email_lookup_hash, lead_id, scan_id,
            created_at, expires_at, activated_at, consumed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $7, null)`,
        [
          "11111111-1111-4111-8111-111111111111",
          recovery.tokenHash,
          recovery.stateHash,
          recovery.emailLookupHash,
          recovery.leadId,
          recovery.scanId,
          recovery.createdAt,
          recovery.expiresAt,
        ],
      );

      await expect(importScannerRecoveryIntents(scanner, plan)).resolves.toStrictEqual({
        insertedRecoveryIntents: 0,
        repeatedRecoveryIntents: 1,
      });
      await scanner.query("update scanner_recovery_intents set state_hash=$1 where token_hash=$2", [
        "0".repeat(64),
        recovery.tokenHash,
      ]);
      await expect(importScannerRecoveryIntents(scanner, plan)).rejects.toStrictEqual(
        new IdentityImportError("scanner_target_recovery_conflict"),
      );
    });

    it("read-only verification refuses a missing imported account without repairing it", async () => {
      await fixture();
      const plan = await planned();
      await importScannerIdentityPlan(cabinet, plan);
      await importScannerRecoveryIntents(scanner, plan);
      await cabinet.query("delete from cabinet_accounts where id=$1", ["scanner_reader"]);

      await expect(verifyScannerIdentityImport(cabinet, scanner, plan)).rejects.toStrictEqual(
        new IdentityImportError("cabinet_target_projection_mismatch"),
      );
      expect(
        (await cabinet.query("select count(*)::int as count from cabinet_accounts")).rows[0],
      ).toStrictEqual({ count: 1 });
    });

    it("read-only verification refuses an altered canonical claim", async () => {
      await fixture();
      const plan = await planned();
      await importScannerIdentityPlan(cabinet, plan);
      await importScannerRecoveryIntents(scanner, plan);
      await cabinet.query("update cabinet_verifications set value=$1 where id=$2", [
        JSON.stringify({
          email: "pending@example.com",
          purpose: "report",
          intentKind: "recovery",
          state: REGISTRATION_STATE,
        }),
        "registration_verification",
      ]);

      await expect(verifyScannerIdentityImport(cabinet, scanner, plan)).rejects.toStrictEqual(
        new IdentityImportError("cabinet_target_verification_conflict"),
      );
    });

    it("read-only verification refuses an altered recovery expiry", async () => {
      await fixture();
      const plan = await planned();
      await importScannerIdentityPlan(cabinet, plan);
      await importScannerRecoveryIntents(scanner, plan);
      await scanner.query(
        "update scanner_recovery_intents set expires_at=expires_at + interval '1 microsecond' where token_hash=$1",
        [RECOVERY_TOKEN],
      );

      await expect(verifyScannerIdentityImport(cabinet, scanner, plan)).rejects.toStrictEqual(
        new IdentityImportError("scanner_target_recovery_conflict"),
      );
    });
  });
}

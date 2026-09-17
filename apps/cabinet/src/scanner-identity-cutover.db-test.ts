/** Runs the real stopped-import CLI against both actual migration histories. */
import { execFile } from "node:child_process";
import { createCipheriv, createHash, createHmac } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { readyDatabase, testDatabaseUrl } from "@agentify/commerce-gateway/testing/database";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { migrateAccounts } from "./database.js";

const execute = promisify(execFile);
const root = process.cwd();
const tsx = resolve(root, "apps/cabinet/node_modules/.bin/tsx");
const key = Buffer.alloc(32, 5);
const secret = "cutover-rehearsal-email-hash-secret-32-bytes";

it("preserves the owner and report capability through real CLI import, restart and guarded source cleanup", async () => {
  const urls = ["agentify_cutover_cabinet_test", "agentify_cutover_scanner_test"].map((name) => {
    const url = new URL(testDatabaseUrl());
    url.pathname = `/${name}`;
    return url.toString();
  });
  const cabinetUrl = urls[0];
  const scannerUrl = urls[1];
  if (!cabinetUrl || !scannerUrl) throw new Error("Missing isolated database name");
  for (const url of urls)
    if (!(await readyDatabase(url))) throw new Error("Cutover database unavailable");
  const cabinet = new Pool({ connectionString: cabinetUrl });
  const scanner = new Pool({ connectionString: scannerUrl });
  const directory = await mkdtemp(join(tmpdir(), "agentify-cutover-proof-"));
  const env = {
    ...process.env,
    CABINET_DATABASE_URL: cabinetUrl,
    SCANNER_DATABASE_URL: scannerUrl,
    EMAIL_ENCRYPTION_KEY: key.toString("base64"),
    TOKEN_HMAC_SECRET: secret,
  };
  const runner = (mode: string) =>
    execute(
      tsx,
      ["apps/cabinet/src/scanner-identity-cutover.ts", mode, join(directory, "record.json")],
      { cwd: root, env },
    );
  const scannerMigration = (...args: string[]) =>
    execute(tsx, ["packages/scanner-database/src/migrate-cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: scannerUrl },
    });
  try {
    for (const pool of [cabinet, scanner])
      await pool.query(
        "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public",
      );
    await mkdir(join(directory, "meta"));
    const journal = JSON.parse(
      await readFile(join(root, "apps/cabinet/drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    const entries = journal.entries.filter((entry) => entry.idx <= 4);
    await writeFile(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries)
      await copyFile(
        join(root, "apps/cabinet/drizzle", `${entry.tag}.sql`),
        join(directory, `${entry.tag}.sql`),
      );
    await migrateAccounts(cabinet, directory);
    await scannerMigration("--identity-preflight");
    await cabinet.query(
      "insert into cabinet_accounts (id,email,email_verified,name,created_at,updated_at,merchant_id,merchant_key) values ('owner','owner@example.com',false,'Owner',now(),now(),'merchant','merchant-key')",
    );
    await cabinet.query(
      "insert into cabinet_sessions (id,token,user_id,expires_at,created_at,updated_at) values ('old-session','old-token','owner',now()+interval '1 day',now(),now())",
    );
    const baseline = await cabinet.query("select to_jsonb(t) as row from cabinet_accounts t");
    await scanner.query(
      "insert into scanner_auth_users (id,email,email_verified,name) values ('reader','reader@example.com',true,'Reader')",
    );
    const iv = Buffer.alloc(12, 2);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update("reader@example.com", "utf8"), cipher.final()]);
    const ciphertext = `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
    const hash = createHmac("sha256", secret).update("email\0reader@example.com").digest("hex");
    const lead = "01950000-0000-7000-8000-000000000001";
    await scanner.query(
      "insert into sessions (id,anonymous_id_hash) values ('01950000-0000-7000-8000-000000000002','anonymous-browser')",
    );
    await scanner.query(
      "insert into leads (id,email_normalized_ciphertext,email_lookup_hash,role,verified_at,first_segment,first_session_id,scanner_auth_user_id) values ($1,$2,$3,'owner',now(),'owner','01950000-0000-7000-8000-000000000002','reader')",
      [lead, ciphertext, hash],
    );
    await scanner.query(
      "insert into report_sessions (id,lead_id,session_token_hash,expires_at) values ('01950000-0000-7000-8000-000000000003',$1,'existing-report-capability',now()+interval '1 day')",
      [lead],
    );
    const report = await scanner.query("select to_jsonb(t) as row from report_sessions t");
    const scan = "01950000-0000-7000-8000-000000000004";
    const state = "q".repeat(43);
    const recoveryState = "w".repeat(43);
    const expiry = new Date(Date.now() + 3_600_000).toISOString().replace("Z", "123Z");
    await scanner.query(
      "insert into scans (id,session_id,lead_id,segment,rubric_version,submitted_url_redacted,canonical_target_url,target_host,target_hash,status,score,coverage,finished_at,access_token_hash,access_token_expires_at,idempotency_key_hash,idempotency_body_hash) values ($1,'01950000-0000-7000-8000-000000000002',$2,'owner','proof','https://example.com','https://example.com','example.com','target-hash','completed',90,1,now(),'scan-access', $3,'idempotency-key','idempotency-body')",
      [scan, lead, expiry],
    );
    await scanner.query("insert into lead_scans (lead_id,scan_id) values ($1,$2)", [lead, scan]);
    await scanner.query(
      "insert into waitlist_entries (id,lead_id,scan_id) values ('01950000-0000-7000-8000-000000000006',$1,$2)",
      [lead, scan],
    );
    await scanner.query(
      "insert into registration_intents (id,scan_id,session_id,callback_state_hash,email_normalized_ciphertext,email_lookup_hash,phone_e164_ciphertext,phone_lookup_hash,role,dataset_reuse_acknowledged,expires_at) values ('01950000-0000-7000-8000-000000000005',$1,'01950000-0000-7000-8000-000000000002',$2,$3,$4,'unused-phone','unused-phone-hash','owner',true,$5)",
      [scan, createHash("sha256").update(state).digest("hex"), ciphertext, hash, expiry],
    );
    for (const [id, purpose, claimState, tokenHash] of [
      ["registration-proof", "registration", state, "r".repeat(43)],
      ["recovery-proof", "recovery", recoveryState, "s".repeat(43)],
    ]) {
      await scanner.query(
        "insert into scanner_auth_verifications (id,identifier,value,expires_at) values ($1,$2,$3,$4)",
        [
          id,
          tokenHash,
          JSON.stringify({ email: "reader@example.com", purpose, state: claimState }),
          expiry,
        ],
      );
    }
    const fingerprintSql = (
      await readFile(join(root, "deploy/ansible/release-identity-target-fingerprint.sql"), "utf8")
    ).replace(/\\gexec\s*$/, "");
    async function targets(pool: Pool) {
      const generated = await pool.query<{ format: string }>(fingerprintSql);
      const rows: unknown[] = [];
      for (const query of generated.rows) rows.push(...(await pool.query(query.format)).rows);
      return rows;
    }

    // Accidental full migration must not erase an unimported scanner identity.
    await expect(scannerMigration()).rejects.toThrow();
    expect(
      (await scanner.query("select count(*)::int as count from scanner_auth_users")).rows[0].count,
    ).toBe(1);
    expect(JSON.parse((await runner("preflight")).stdout).status).toBe("prepared");
    // An operator cannot silently replace the baseline on a retry.
    await expect(runner("preflight")).rejects.toMatchObject({ stderr: "cutover_failed\n" });
    expect(
      (await cabinet.query("select count(*)::int as count from cabinet_sessions")).rows[0].count,
    ).toBe(1);
    await migrateAccounts(cabinet, join(root, "apps/cabinet/drizzle"));
    expect(JSON.parse((await runner("apply")).stdout).cabinet.insertedAccounts).toBe(1);
    expect(JSON.parse((await runner("apply")).stdout).cabinet.repeatedAccounts).toBe(1);

    const cabinetTarget = await targets(cabinet);
    const scannerTarget = await targets(scanner);
    expect(
      (await cabinet.query("select count(*)::int as count from cabinet_verifications")).rows[0]
        .count,
    ).toBe(2);
    expect(
      (await scanner.query("select count(*)::int as count from scanner_recovery_intents")).rows[0]
        .count,
    ).toBe(1);

    // Cleanup authorization is verification, never a repair of changed data.
    await cabinet.query("update cabinet_accounts set email_verified=true where id='owner'");
    await expect(runner("authorize-cleanup")).rejects.toMatchObject({
      stderr: "cutover_plan_changed\n",
    });
    expect(
      (await scanner.query("select to_regclass('public.scanner_identity_cutover_ready') as marker"))
        .rows[0].marker,
    ).toBeNull();
    await cabinet.query("update cabinet_accounts set email_verified=false where id='owner'");
    expect(JSON.parse((await runner("authorize-cleanup")).stdout).status).toBe(
      "cleanup_authorized",
    );
    // Detect lost/changed imported proof even after source cleanup is authorized.
    await scanner.query(
      "update scanner_recovery_intents set expires_at=expires_at+interval '1 microsecond'",
    );
    expect(await targets(scanner)).not.toEqual(scannerTarget);
    await scanner.query(
      "update scanner_recovery_intents set expires_at=expires_at-interval '1 microsecond'",
    );
    await cabinet.query(
      "update cabinet_verifications set expires_at=expires_at+interval '1 microsecond'",
    );
    expect(await targets(cabinet)).not.toEqual(cabinetTarget);
    await cabinet.query(
      "update cabinet_verifications set expires_at=expires_at-interval '1 microsecond'",
    );
    await scannerMigration();
    await scannerMigration();
    expect(await targets(cabinet)).toEqual(cabinetTarget);
    expect(await targets(scanner)).toEqual(scannerTarget);
    expect(
      (
        await scanner.query(
          "select to_regclass('public.scanner_auth_users') as old, to_regclass('public.scanner_identity_cutover_ready') as marker",
        )
      ).rows[0],
    ).toEqual({ old: null, marker: null });
    expect(
      (await cabinet.query("select to_jsonb(t) as row from cabinet_accounts t where id='owner'"))
        .rows,
    ).toEqual(baseline.rows);
    expect(
      (
        await cabinet.query(
          "select email_verified, merchant_id from cabinet_accounts where id='reader'",
        )
      ).rows[0],
    ).toEqual({ email_verified: true, merchant_id: null });
    expect(
      (await cabinet.query("select count(*)::int as count from cabinet_sessions")).rows[0].count,
    ).toBe(0);
    expect((await scanner.query("select to_jsonb(t) as row from report_sessions t")).rows).toEqual(
      report.rows,
    );
  } finally {
    await Promise.allSettled([cabinet.end(), scanner.end()]);
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

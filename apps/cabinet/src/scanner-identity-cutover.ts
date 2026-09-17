/**
 * First shared-identity activation, with both applications stopped by Ansible.
 * The private checkpoint holds hashes and original IDs, never customer rows or
 * credentials. It freezes the eligibility time so an interrupted import can be
 * resumed without extending a link or treating an imported P1 as an old owner.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { z } from "zod";
import {
  IdentityImportError,
  importScannerIdentityPlan,
  importScannerRecoveryIntents,
  planScannerIdentityImport,
  readScannerIdentityImportSnapshot,
  type ScannerIdentityImportSnapshot,
  type ScannerIdentityPlanningOptions,
  verifyScannerIdentityImport,
} from "./scanner-identity-import.js";

const recordSchema = z.strictObject({
  version: z.literal(1),
  asOf: z.iso.datetime(),
  originalCabinetAccountIds: z
    .array(z.string().min(1))
    .refine((ids) => new Set(ids).size === ids.length),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
type CutoverRecord = z.infer<typeof recordSchema>;
type Secrets = Pick<ScannerIdentityPlanningOptions, "emailEncryptionKey" | "tokenHmacSecret">;

// Queries make no ordering promise. Rows and object keys are ordered only for
// hashing; this never changes values or truncates PostgreSQL timestamp precision.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function sourceDigest(snapshot: ScannerIdentityImportSnapshot): string {
  const { cabinetAccounts: _cabinet, ...source } = snapshot;
  return digest(source);
}

export function prepareIdentityCutover(
  snapshot: ScannerIdentityImportSnapshot,
  options: Secrets & { now: Date },
) {
  const plan = planScannerIdentityImport(snapshot, options);
  const record: CutoverRecord = {
    version: 1,
    asOf: options.now.toISOString(),
    originalCabinetAccountIds: plan.baselineCabinetAccounts.map((row) => row.id).sort(),
    planDigest: digest(plan),
    sourceDigest: sourceDigest(snapshot),
  };
  return { record, plan };
}

export function resumeIdentityCutover(
  snapshot: ScannerIdentityImportSnapshot,
  input: unknown,
  secrets: Secrets,
) {
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) throw new IdentityImportError("cutover_record_invalid");
  const record = parsed.data;
  if (sourceDigest(snapshot) !== record.sourceDigest)
    throw new IdentityImportError("cutover_source_changed");
  const plan = planScannerIdentityImport(snapshot, {
    ...secrets,
    now: new Date(record.asOf),
    originalCabinetAccountIds: record.originalCabinetAccountIds,
  });
  if (digest(plan) !== record.planDigest) throw new IdentityImportError("cutover_plan_changed");
  return plan;
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new IdentityImportError("cutover_environment_missing");
  return value;
}

async function main(): Promise<void> {
  const [mode, recordPath, ...extra] = process.argv.slice(2);
  if (
    !["preflight", "apply", "authorize-cleanup"].includes(mode ?? "") ||
    !recordPath ||
    extra.length
  ) {
    throw new IdentityImportError("cutover_arguments_invalid");
  }
  const key = requireEnvironment("EMAIL_ENCRYPTION_KEY");
  if (Buffer.from(key, "base64").length !== 32)
    throw new IdentityImportError("cutover_encryption_key_invalid");
  const secrets: Secrets = {
    emailEncryptionKey: Buffer.from(key, "base64"),
    tokenHmacSecret: requireEnvironment("TOKEN_HMAC_SECRET"),
  };
  const cabinet = new Pool({
    connectionString: requireEnvironment("CABINET_DATABASE_URL"),
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
  });
  const scanner = new Pool({
    connectionString: requireEnvironment("SCANNER_DATABASE_URL"),
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
  });
  try {
    const residual = await scanner.query<{ count: string }>(
      "select count(*)::text as count from verification_tokens",
    );
    if (residual.rows[0]?.count !== "0")
      throw new IdentityImportError("cutover_residual_verification_rows");
    const snapshot = await readScannerIdentityImportSnapshot(cabinet, scanner);
    if (mode === "preflight") {
      const { record, plan } = prepareIdentityCutover(snapshot, { ...secrets, now: new Date() });
      // Never overwrite the original baseline after a partial activation.
      await writeFile(recordPath, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
      process.stdout.write(`${JSON.stringify({ status: "prepared", ...plan.counts })}\n`);
    } else {
      const record: unknown = JSON.parse(await readFile(recordPath, "utf8"));
      const plan = resumeIdentityCutover(snapshot, record, secrets);
      if (mode === "apply") {
        const cabinetResult = await importScannerIdentityPlan(cabinet, plan);
        const scannerResult = await importScannerRecoveryIntents(scanner, plan);
        const verified = await verifyScannerIdentityImport(cabinet, scanner, plan);
        process.stdout.write(
          `${JSON.stringify({ status: "imported", cabinet: cabinetResult, scanner: scannerResult, verified })}\n`,
        );
      } else {
        await verifyScannerIdentityImport(cabinet, scanner, plan);
        const client = await scanner.connect();
        try {
          await client.query("begin");
          await client.query(
            "create table if not exists scanner_identity_cutover_ready (id boolean primary key check(id), plan_digest text not null check(length(plan_digest)=64))",
          );
          await client.query("revoke all on scanner_identity_cutover_ready from public");
          await client.query(
            "insert into scanner_identity_cutover_ready (id, plan_digest) values (true, $1) on conflict do nothing",
            [digest(plan)],
          );
          const marker = await client.query<{ plan_digest: string }>(
            "select plan_digest from scanner_identity_cutover_ready",
          );
          if (marker.rows.length !== 1 || marker.rows[0]?.plan_digest !== digest(plan))
            throw new IdentityImportError("cutover_cleanup_marker_conflict");
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        process.stdout.write(`${JSON.stringify({ status: "cleanup_authorized" })}\n`);
      }
    }
  } finally {
    await Promise.allSettled([cabinet.end(), scanner.end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof IdentityImportError ? error.code : "cutover_failed"}\n`,
    );
    process.exitCode = 1;
  });
}

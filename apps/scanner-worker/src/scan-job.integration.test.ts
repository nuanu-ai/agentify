import { fileURLToPath } from "node:url";

import type { ScanJobV1 } from "@agentify/scanner-contracts";
import {
  anonymizeLeadData,
  consentSnapshots,
  createDatabase,
  createScanJobRepository,
  createUuidV7,
  leadScans,
  leads,
  migrateDatabase,
  scans,
  sessions,
} from "@agentify/scanner-database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PinnedTransport } from "./safe-fetch.js";
import { processScanJob } from "./scan-job.js";
import { ScanRunner } from "./scan-runner.js";

const connectionString = process.env.MIGRATION_TEST_DATABASE_URL;
if (!connectionString) throw new Error("MIGRATION_TEST_DATABASE_URL is required");
const databaseName = new URL(connectionString).pathname.slice(1);
if (!databaseName.endsWith("_migration_test")) {
  throw new Error("MIGRATION_TEST_DATABASE_URL must name a dedicated *_migration_test database");
}

const migrationsFolder = fileURLToPath(
  new URL("../../../packages/scanner-database/migrations", import.meta.url),
);
const { db, pool } = createDatabase(connectionString, { max: 4 });

/** A lead with one queued scan of `host`, as a visitor who registered leaves them. */
async function queuedScanOfALead(host: string) {
  const sessionId = createUuidV7();
  const consentId = createUuidV7();
  const leadId = createUuidV7();
  const scanId = createUuidV7();
  await db.insert(sessions).values({ id: sessionId, anonymousIdHash: `scan-job-${sessionId}` });
  await db.insert(consentSnapshots).values({
    id: consentId,
    sessionId,
    policyVersion: "consent-v1.0.0",
    categories: { essential_processing: true, product_analytics: true },
    source: "api",
  });
  await pool.query("update sessions set consent_snapshot_id = $1 where id = $2", [
    consentId,
    sessionId,
  ]);
  await db.insert(leads).values({
    id: leadId,
    emailNormalizedCiphertext: "ciphertext",
    emailLookupHash: `lookup-${leadId}`,
    role: "business_owner",
    verifiedAt: new Date(),
    firstSegment: "owner",
    firstSessionId: sessionId,
  });
  await db.insert(scans).values({
    id: scanId,
    sessionId,
    leadId,
    segment: "owner",
    rubricVersion: "gtm-v1.0.0",
    submittedUrlRedacted: `https://${host}/`,
    canonicalTargetUrl: `https://${host}/`,
    targetHost: host,
    targetHash: `target-${scanId}`,
    status: "queued",
    queuedAt: new Date(),
    accessTokenHash: `access-${scanId}`,
    accessTokenExpiresAt: new Date(Date.now() + 86_400_000),
    idempotencyKeyHash: `idem-${scanId}`,
    idempotencyBodyHash: `body-${scanId}`,
  });
  await db.insert(leadScans).values({ leadId, scanId, siteOwnershipClaim: true });
  const job: ScanJobV1 = {
    scan_id: scanId,
    segment: "owner",
    rubric_version: "gtm-v1.0.0",
    deadline_at: new Date(Date.now() + 55_000).toISOString(),
    attempt_no: 1,
  };
  return { leadId, scanId, job };
}

beforeAll(async () => {
  await migrateDatabase(db, migrationsFolder);
});

afterAll(async () => {
  await pool.end();
});

describe("a queued scan in the database", () => {
  it("is closed without a request to its site once the person behind it is deleted, while a scan of a person kept is scanned", async () => {
    const resolved: string[] = [];
    const transport: PinnedTransport = {
      request: async (input) => ({
        url: input.url.toString(),
        status: 404,
        headers: { "content-type": "text/plain" },
        body: "",
        decodedBytes: 0,
        truncated: false,
        durationMs: 1,
        ttfbMs: 1,
      }),
    };
    const dependencies = {
      repository: createScanJobRepository(db),
      runner: new ScanRunner({
        resolver: {
          resolve: async (hostname: string) => {
            resolved.push(hostname);
            return [{ address: "93.184.216.34", family: 4 as const }];
          },
        },
        transport,
        appBaseUrl: "http://localhost:3000",
      }),
    };
    const deleted = await queuedScanOfALead("deleted-person.example");
    const kept = await queuedScanOfALead("kept-person.example");
    await expect(anonymizeLeadData(db, deleted.leadId)).resolves.toMatchObject({
      status: "anonymized",
    });

    await expect(processScanJob(deleted.job, dependencies)).resolves.toBe("skipped");
    await processScanJob(kept.job, dependencies);

    const closed = await pool.query("select status, failure_code from scans where id = $1", [
      deleted.scanId,
    ]);
    expect(closed.rows).toEqual([{ status: "failed", failure_code: "data_anonymized" }]);
    expect(new Set(resolved)).toEqual(new Set(["kept-person.example"]));
  });
});

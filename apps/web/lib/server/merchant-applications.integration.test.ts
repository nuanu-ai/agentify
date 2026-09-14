import { fileURLToPath } from "node:url";
import {
  createDatabase,
  deleteExpiredMerchantApplications,
  merchantApplications,
  migrateDatabase,
  rateLimitEvents,
} from "@agentify/scanner-database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "../../app/api/v1/merchant-applications/route";
import { getServerConfig } from "./config";
import { decryptSensitiveValue } from "./crypto";
import { getDatabase } from "./database";
import { consumeRateLimitsAtomically, readRateCount } from "./rate-limit";

const connection = process.env.MIGRATION_TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith("_migration_test"))
  throw new Error("Dedicated migration-test database required");
process.env.DATABASE_URL = connection;
process.env.APP_BASE_URL = "http://localhost:3017";
process.env.REGISTRATION_ENABLED = "false";
process.env.EMAIL_PROVIDER = "disabled";
process.env.TOKEN_HMAC_SECRET = "merchant-integration-only-secret-32-bytes";
const admin = createDatabase(connection);
const body = {
  businessName: "Test merchant",
  website: "https://example.com",
  email: "merchant@example.com",
  category: "retail",
  country: "Indonesia",
  offer: "Test offer",
  consent: true,
  companyFax: "",
};
const request = (
  key: string,
  values: Record<string, unknown> = body,
  ip = "192.0.2.10",
  origin = "http://localhost:3017",
) =>
  new Request("http://localhost:3017/api/v1/merchant-applications", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      "X-Forwarded-For": ip,
    },
    body: JSON.stringify(values),
  });

beforeAll(async () => {
  await admin.pool.query(
    "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public",
  );
  await admin.pool.query(`DO $roles$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentify_web') THEN CREATE ROLE agentify_web NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentify_privacy') THEN CREATE ROLE agentify_privacy NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentify_worker') THEN CREATE ROLE agentify_worker NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentify_dashboard') THEN CREATE ROLE agentify_dashboard NOLOGIN; END IF;
  END $roles$; GRANT USAGE ON SCHEMA public TO agentify_web, agentify_privacy, agentify_worker, agentify_dashboard`);
  await migrateDatabase(
    admin.db,
    fileURLToPath(
      new URL(
        "../../../../packages/scanner-database/migrations",
        import.meta.url,
      ),
    ),
  );
});
afterAll(async () => {
  await getDatabase().pool.end();
  await admin.pool.end();
});

describe("merchant application intake", () => {
  it("persists encrypted contact data and reconciles concurrent retries without consuming extra limits", async () => {
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => POST(request("same-key-0001"))),
    );
    expect(replies.map((reply) => reply.status)).toEqual(Array(8).fill(202));
    expect(await replies[0]!.json()).toEqual({ status: "received" });
    const rows = await admin.db.select().from(merchantApplications);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(JSON.stringify(row)).not.toContain(body.email);
    expect(
      JSON.parse(
        decryptSensitiveValue(
          row.payloadCiphertext,
          getServerConfig().encryptionKey,
        ),
      ),
    ).toMatchObject(body);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(
      30 * 86_400_000,
    );
    expect(await admin.db.select().from(rateLimitEvents)).toHaveLength(2);
    expect(
      (
        await POST(
          request("same-key-0001", { ...body, offer: "Changed offer" }),
        )
      ).status,
    ).toBe(409);
    expect(await admin.db.select().from(merchantApplications)).toHaveLength(1);
  });

  it("rejects cross-origin, absent consent, credential URLs, honeypots and oversized bodies without saving", async () => {
    expect(
      (
        await POST(
          request(
            "rejected-0001",
            body,
            "192.0.2.20",
            "https://unrelated.example",
          ),
        )
      ).status,
    ).toBe(403);
    for (const values of [
      { ...body, consent: false },
      { ...body, website: "https://user:password@example.com" },
      { ...body, companyFax: "bot" },
      { ...body, offer: "x".repeat(9000) },
    ]) {
      expect((await POST(request("rejected-0001", values))).status).toBe(400);
    }
    expect(await admin.db.select().from(merchantApplications)).toHaveLength(1);
  });

  it("enforces email limits across IPs and IP limits across emails", async () => {
    for (let i = 0; i < 2; i++)
      expect(
        (await POST(request(`email-limit-${i}`, body, `192.0.2.${30 + i}`)))
          .status,
      ).toBe(202);
    expect(
      (await POST(request("email-limit-2", body, "192.0.2.32"))).status,
    ).toBe(429);
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        POST(
          request(
            `ip-limit-${i}`,
            { ...body, email: `other-${i}@example.com` },
            "192.0.2.50",
          ),
        ),
      ),
    );
    expect(attempts.filter((reply) => reply.status === 202)).toHaveLength(5);
    expect(attempts.filter((reply) => reply.status === 429)).toHaveLength(1);
  });

  it("grants only the required application roles", async () => {
    for (const role of ["agentify_web", "agentify_privacy"]) {
      await admin.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local role ${role}`));
        expect(await tx.select().from(merchantApplications)).toHaveLength(8);
      });
    }
    for (const role of ["agentify_worker", "agentify_dashboard"]) {
      await expect(
        admin.db.transaction(async (tx) => {
          await tx.execute(sql.raw(`set local role ${role}`));
          return tx.select().from(merchantApplications);
        }),
      ).rejects.toThrow();
    }
    const permissions = await admin.pool.query(
      "select has_table_privilege('agentify_web','merchant_applications','INSERT') as insert, has_table_privilege('agentify_web','merchant_applications','UPDATE') as update, has_table_privilege('agentify_privacy','merchant_applications','DELETE') as delete",
    );
    const policy = await admin.pool.query(
      "select polcmd from pg_policy where polrelid = 'public.merchant_applications'::regclass and polname = 'agentify_web_service'",
    );
    expect(policy.rows).toEqual([{ polcmd: "r" }]);
    expect(permissions.rows[0]).toEqual({
      insert: true,
      update: false,
      delete: true,
    });
  });

  it("removes expired applications while preserving current rows", async () => {
    const [row] = await admin.db.select().from(merchantApplications).limit(1);
    await admin.db
      .update(merchantApplications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(merchantApplications.id, row!.id));
    expect(await deleteExpiredMerchantApplications(admin.db)).toBe(1);
    const current = await admin.db.select().from(merchantApplications);
    expect(current).toHaveLength(7);
    const security = await admin.db.execute<{ relrowsecurity: boolean }>(
      sql`select relrowsecurity from pg_class where oid = 'public.merchant_applications'::regclass`,
    );
    expect(security.rows[0]?.relrowsecurity).toBe(true);
  });

  it.each([
    { kind: "merchant_ip_hour" as const, limit: 5 },
    { kind: "merchant_email_hour" as const, limit: 3 },
  ])(
    "counts overtaking requests toward the $kind limit",
    async ({ kind, limit }) => {
      const entry = { keyHash: `out-of-order-${kind}`, kind, limit };
      const waitingRequestTime = new Date("2026-09-14T12:00:00Z");
      const overtakingRequestTime = new Date("2026-09-14T12:00:00.010Z");
      for (let i = 0; i < limit; i++) {
        await expect(
          consumeRateLimitsAtomically([entry], overtakingRequestTime),
        ).resolves.toEqual({ allowed: true });
      }
      await expect(
        readRateCount(entry.keyHash, kind, waitingRequestTime),
      ).resolves.toBe(limit);
      await expect(
        consumeRateLimitsAtomically([entry], waitingRequestTime),
      ).resolves.toEqual({ allowed: false });
    },
  );
});

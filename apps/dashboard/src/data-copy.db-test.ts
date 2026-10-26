/**
 * What a copy of an address's data reads from the dashboard's own tables on
 * the real database: that account's row, its Google link, its sessions and its
 * ad reports, with no credential among them and nothing of another account.
 * If these fail, a copy mailed to a person could carry a token that signs them
 * in, or somebody else's sessions.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { postgresPersonRecords } from "./data-copy.js";
import { connect, migrateAccounts } from "./database.js";
import { accounts, adReports, credentials, sessions } from "./schema.js";

const WANTED = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_dashboard_data_copy";
  return url.toString();
})();
const databaseUrl = await readyDatabase(WANTED);
const here = dirname(fileURLToPath(import.meta.url));
const gatewayMigrations = join(here, "..", "..", "gateway", "drizzle");
const dashboardMigrations = join(here, "..", "drizzle");

const AT = new Date("2026-10-20T09:00:00.000Z");
const SECRETS = ["owners-session-token", "ya29.access", "1//refresh", "eyJ.id", "password-hash"];

if (databaseUrl === null) {
  console.log(noDatabaseHere(WANTED));
  describe("a copy's read of the dashboard's tables on a real database", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => undefined);
  });
} else {
  const pool = connect(databaseUrl);
  const db = drizzle(pool);
  const people = postgresPersonRecords(pool);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("drop schema public cascade");
    await pool.query("drop schema if exists drizzle cascade");
    await pool.query("create schema public");
    await migrate(db, { migrationsFolder: gatewayMigrations });
    await migrateAccounts(pool, dashboardMigrations);
    for (const [id, email] of [
      ["acc_owner", "owner@example.com"],
      ["acc_other", "other@example.com"],
    ] as const) {
      await db.insert(accounts).values({
        id,
        email,
        emailVerified: true,
        name: id === "acc_owner" ? "Owner's shop" : "",
        createdAt: AT,
        updatedAt: AT,
      });
      await db.insert(sessions).values({
        id: `ses_${id}`,
        token: id === "acc_owner" ? "owners-session-token" : "others-session-token",
        userId: id,
        expiresAt: AT,
        createdAt: AT,
        updatedAt: AT,
        ipAddress: id === "acc_owner" ? "203.0.113.7" : "198.51.100.9",
        userAgent: "Firefox",
      });
    }
    await db.insert(credentials).values({
      id: "cred_owner",
      userId: "acc_owner",
      providerId: "google",
      accountId: "google-subject",
      issuer: "https://accounts.google.com",
      password: "password-hash",
      accessToken: "ya29.access",
      refreshToken: "1//refresh",
      idToken: "eyJ.id",
      createdAt: AT,
      updatedAt: AT,
    });
    await db.insert(adReports).values({
      accountId: "acc_owner",
      event: "reg",
      state: "delivered",
      createdAt: AT,
      eventAt: AT,
      settledAt: AT,
    });
  });

  describe("a copy's read of the dashboard's tables on a real database", () => {
    it("holds the account's row, Google link, sessions and ad reports", async () => {
      const record = await people.of("owner@example.com");

      expect(record).toMatchObject({
        accountId: "acc_owner",
        merchantId: null,
        account: { id: "acc_owner", email: "owner@example.com", name: "Owner's shop" },
        google: [{ issuer: "https://accounts.google.com", subject: "google-subject" }],
        sessions: [{ ip_address: "203.0.113.7", started_at: AT.toISOString() }],
        adReports: [{ event: "reg", state: "delivered" }],
      });
    });

    it("holds no credential and nothing of another account", async () => {
      const text = JSON.stringify(await people.of("owner@example.com"));

      for (const value of [...SECRETS, "others-session-token", "198.51.100.9", "acc_other"]) {
        expect(text, value).not.toContain(value);
      }
    });

    it("finds nothing for an address with no account", async () => {
      await expect(people.of("nobody@example.com")).resolves.toBeNull();
    });
  });
}

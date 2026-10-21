/**
 * Recording an analytics event, against PostgreSQL, because what it promises
 * is the database's: the event commits or rolls back with the caller's own
 * transaction, and an observation made outside any transaction never fails
 * the page that made it.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "../testing/database.js";
import { type AnalyticsEvent, type MerchantCreated, record, recordObserved } from "./index.js";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_analytics_record";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);
const migrationsIn = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "drizzle");

const AT = new Date("2026-10-21T12:00:00.000Z");
const created: MerchantCreated = {
  name: "agc_merchant_created",
  actor: "human",
  source: "dashboard",
  refs: { merchant: "mer_raw_record_1", person: "acc_raw_record_1" },
};

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));
  describe("recording an analytics event", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query("drop schema if exists drizzle cascade");
  await migrate(drizzle(pool), { migrationsFolder: migrationsIn });
  const db = drizzle(pool);

  afterAll(async () => {
    await pool.end();
  });

  let told: string[] = [];
  beforeEach(async () => {
    told = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...said: unknown[]) => {
        told.push(said.map(String).join(" "));
      });
    }
    await pool.query("delete from analytics_events");
  });
  afterEach(() => {
    for (const line of told) expect(line).not.toMatch(/_raw_/);
    vi.restoreAllMocks();
  });

  const recorded = async () =>
    (
      await pool.query<{ id: string; name: string; occurred_at: Date; state: string }>(
        "select id, name, occurred_at, state from analytics_events order by sequence",
      )
    ).rows;

  describe("recording an analytics event", () => {
    it("leaves no event when the caller's transaction rolls back, and exactly one when it commits", async () => {
      await expect(
        db.transaction(async (tx) => {
          await record(tx, created, AT);
          throw new Error("the business write failed");
        }),
      ).rejects.toThrow("the business write failed");
      expect(await recorded()).toStrictEqual([]);

      await db.transaction(async (tx) => {
        await record(tx, created, AT);
      });
      const rows = await recorded();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "agc_merchant_created",
        occurred_at: AT,
        state: "pending",
      });
      expect(rows[0]?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it("commits the caller's transaction with an event that breaks the contract, which the sender refuses later", async () => {
      const broken = {
        ...created,
        fields: { screen: "nowhere" },
      } as unknown as AnalyticsEvent;
      await db.transaction(async (tx) => {
        await record(tx, broken, AT);
      });
      expect(await recorded()).toHaveLength(1);
    });

    it("records an observation outside any transaction", async () => {
      await recordObserved(db, created, AT);
      expect(await recorded()).toHaveLength(1);
    });

    it("never fails the caller of an observation the database cannot take, and says so without identifiers", async () => {
      await pool.query("alter table analytics_events rename to analytics_events_away");
      try {
        await expect(recordObserved(db, created, AT)).resolves.toBeUndefined();
      } finally {
        await pool.query("alter table analytics_events_away rename to analytics_events");
      }
      expect(told.join("\n")).toMatch(/analytics event could not be recorded/);
    });
  });
}

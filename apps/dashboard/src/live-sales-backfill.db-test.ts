/** Release data migration on the shared database, after both real schema histories. */
import { fileURLToPath } from "node:url";
import { PostgresStore, randomIds } from "@agentify/gateway";
import { backfillLiveSalesRequests, liveBackfillMode } from "@agentify/gateway/live-sales";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { migrateAccounts } from "./database.js";
import { postgresLiveSalesNotices } from "./live-sales-mail.js";

const wanted = new URL(testDatabaseUrl());
wanted.pathname = "/agentify_test_live_sales_backfill";
const url = await readyDatabase(wanted.toString());
const at = new Date("2026-10-31T14:00:00Z");
if (url === null) {
  console.log(noDatabaseHere(wanted.toString()));
  it.skip("needs its disposable PostgreSQL server", () => {});
} else {
  const pool = new Pool({ connectionString: url, max: 4 });
  const db = drizzle(pool);
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query("drop schema if exists drizzle cascade");
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../gateway/drizzle", import.meta.url)),
  });
  await migrateAccounts(pool, fileURLToPath(new URL("../drizzle", import.meta.url)));
  afterAll(() => pool.end());
  const notices = postgresLiveSalesNotices({ surfaceMode: "live" });
  const store = PostgresStore.over(db, "eip155:8453", randomIds, undefined, notices);
  beforeEach(async () => {
    await pool.query(
      "truncate merchants, dashboard_accounts, operator_journal, merchant_live_request_backfill cascade",
    );
    await pool.query(
      "insert into dashboard_accounts(id,email,email_verified,operator,created_at,updated_at) values('acc_operator','operator@example.com',true,true,now(),now())",
    );
  });
  const old = async (
    id: string,
    name: string | null = "Existing shop",
    wallet: string | null = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  ) => {
    await pool.query(
      "insert into merchants(id,name,selling,service_name,payout_wallet,created_at,updated_at) values($1,'Existing merchant','open',$2,$3,now(),now())",
      [id, name, wallet],
    );
  };
  const run = (mode: Parameters<typeof backfillLiveSalesRequests>[1] = "live") =>
    backfillLiveSalesRequests(db, mode, notices, at);
  describe("legacy live-sales requests", () => {
    it("backfills only named wallet holders without approval or a successful withdrawal, once at release", async () => {
      await old("eligible");
      await old("unnamed", null);
      await old("walletless", "Shop", null);
      await old("approved");
      await store.grantLiveApproval("approved", 1);
      await old("withdrawn");
      await store.grantLiveApproval("withdrawn", 1);
      await store.withdrawLiveApproval("withdrawn", {
        at: 2,
        actor: { kind: "terminal" },
        action: "withdraw",
        subject: { kind: "merchant", id: "withdrawn" },
        reason: "Stopped",
      });
      await old("refused");
      await store.recordJournal({
        at: 2,
        actor: { kind: "terminal" },
        action: "withdraw",
        subject: { kind: "merchant", id: "refused" },
        reason: "Tried",
        outcome: { kind: "refused", code: "not_confirmed" },
      });
      await old("unchanged");
      await store.withdrawLiveApproval("unchanged", {
        at: 2,
        actor: { kind: "terminal" },
        action: "withdraw",
        subject: { kind: "merchant", id: "unchanged" },
        reason: "Tried",
      });
      expect(await run()).toEqual({ kind: "done", count: 3 });
      const { rows } = await pool.query(
        "select merchant_id,requested_at,evidence,account_id from merchant_live_requests order by merchant_id",
      );
      expect(rows).toEqual(
        ["eligible", "refused", "unchanged"].map((merchant_id) => ({
          merchant_id,
          requested_at: at,
          evidence: null,
          account_id: null,
        })),
      );
      expect(
        (await pool.query("select count(*)::int as count from dashboard_live_sales_mail")).rows[0]
          .count,
      ).toBe(3);
      const request = await store.liveSalesRequest("eligible");
      if (!request) throw new Error("request missing");
      await store.declineLiveSales("eligible", request.id, {
        at: at.getTime() + 1,
        actor: { kind: "terminal" },
        action: "decline",
        subject: { kind: "merchant", id: "eligible" },
        reason: "Correct the name",
      });
      await old("new_after_release");
      expect(await run()).toEqual({ kind: "already_done", count: 0 });
      expect((await store.liveSalesRequest("eligible"))?.state).toBe("declined");
      expect(await store.liveSalesRequest("new_after_release")).toBeNull();
    });
    it("skips test, sandbox and unknown channel inputs without setting the completion marker", async () => {
      await old("eligible");
      for (const mode of ["test", "sandbox", null] as const)
        expect(await run(mode)).toEqual({ kind: "skipped", count: 0 });
      expect(
        (await pool.query("select count(*)::int as count from merchant_live_request_backfill"))
          .rows[0].count,
      ).toBe(0);
      expect(await store.liveSalesRequest("eligible")).toBeNull();
      expect(liveBackfillMode(undefined, "https://facilitator.example")).toBeNull();
      expect(liveBackfillMode("eip155:8453", undefined)).toBeNull();
      expect(liveBackfillMode("unknown", "https://facilitator.example")).toBeNull();
      expect(liveBackfillMode("eip155:8453", "sandbox:scripted")).toBe("sandbox");
      expect(liveBackfillMode("eip155:84532", "https://facilitator.example")).toBe("test");
      expect(liveBackfillMode("eip155:8453", "https://facilitator.example")).toBe("live");
      expect(await run()).toEqual({ kind: "done", count: 1 });
    });
    it("rolls back requests and the one-time marker if an actual mail row cannot be inserted, then safely retries", async () => {
      await old("eligible");
      await pool.query(
        "alter table dashboard_live_sales_mail add constraint refuse_backfill_mail check (false) not valid",
      );
      try {
        await expect(run()).rejects.toThrow();
        expect(await store.liveSalesRequest("eligible")).toBeNull();
        expect(
          (await pool.query("select count(*)::int as count from merchant_live_request_backfill"))
            .rows[0].count,
        ).toBe(0);
      } finally {
        await pool.query(
          "alter table dashboard_live_sales_mail drop constraint refuse_backfill_mail",
        );
      }
      const together = await Promise.all([run(), run()]);
      expect(together.map((result) => result.kind).sort()).toEqual(["already_done", "done"]);
      expect(
        (await pool.query("select count(*)::int as count from dashboard_live_sales_mail")).rows[0]
          .count,
      ).toBe(1);
    });
  });
}

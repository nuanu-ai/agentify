/**
 * The operator's journal against PostgreSQL, for what only the database can
 * show: the table's own checks refuse a row the application would never write,
 * even one written past the application; an action and its row commit or roll
 * back together, in the store's transaction and in one a dashboard action opens
 * for itself; and forgetting a merchant leaves the rows that name it.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { JournalEntry, JournalPress } from "../../ports/journal.js";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "../../testing/database.js";
import { countedIds } from "../../testing/harness.js";
import { journalAlong } from "./journal.js";
import { merchants } from "./schema.js";
import { connect, PostgresStore } from "./store.js";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_operator_journal";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);
const migrationsIn = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "drizzle",
);

const A = "mch_journal";

const withdrawal = (at: number): JournalPress => ({
  at,
  actor: { kind: "account", id: "acc_operator" },
  action: "withdraw",
  subject: { kind: "merchant", id: A },
  reason: "The seller asked to stop",
});

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));
  describe("the operator's journal on a real database", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const migrating = new Pool({ connectionString: databaseUrl });
  await migrating.query("drop schema public cascade");
  await migrating.query("create schema public");
  await migrating.query("drop schema if exists drizzle cascade");
  await migrate(drizzle(migrating), { migrationsFolder: migrationsIn });
  await migrating.end();

  const { db, pool } = connect(databaseUrl, { max: 4 });
  const store = PostgresStore.over(db, "eip155:84532", countedIds());

  /** A row as it would be written past the application, straight in SQL. */
  const raw = (columns: Record<string, string | null>) => {
    const row = {
      at: "2026-10-23T12:00:00Z",
      actor_kind: "account",
      actor_id: "acc_operator",
      action: "withdraw",
      subject_kind: "merchant",
      subject_id: A,
      subject_merchant: A,
      reason: null,
      outcome: "done",
      refusal: null,
      ...columns,
    };
    const names = Object.keys(row);
    return pool.query(
      `insert into operator_journal (${names.join(", ")}) values (${names.map((_, at) => `$${at + 1}`).join(", ")})`,
      Object.values(row),
    );
  };

  beforeEach(async () => {
    await pool.query("truncate table operator_journal, merchant_keys, merchants cascade");
    await store.addMerchant({ id: A, name: "A merchant" }, 1_000);
    await store.grantLiveApproval(A, 1_500);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("the operator's journal on a real database", () => {
    it("takes a row the application writes, and refuses each that breaks one of its rules", async () => {
      await raw({});

      const broken: Record<string, string | null>[] = [
        { actor_kind: "account", actor_id: null },
        { actor_kind: "terminal", actor_id: "acc_operator" },
        { actor_kind: "somebody" },
        { action: "move_money" },
        { subject_kind: "merchant", subject_merchant: "mch_other" },
        { subject_kind: "key", subject_id: "mk_1", subject_merchant: null },
        { subject_kind: "account", subject_id: "acc_1", subject_merchant: A },
        { outcome: "refused", refusal: null },
        { outcome: "done", refusal: "no_reason" },
        { outcome: "maybe" },
        { reason: "" },
        { reason: "x".repeat(2_001) },
      ];
      for (const columns of broken) {
        await expect(raw(columns), JSON.stringify(columns)).rejects.toThrow(/check constraint/);
      }
      expect((await store.journal({ limit: 50 })).total).toBe(1);
    });

    it("rolls a withdrawal back with a row the table refuses", async () => {
      // Past the application's own check, which would refuse it first: the
      // table's refusal must take the change down with it too.
      await expect(
        db.transaction(async (tx) => {
          await tx.update(merchants).set({ liveApprovedAt: null }).where(eq(merchants.id, A));
          await tx.execute(
            `insert into operator_journal (at, actor_kind, action, subject_kind, subject_id, outcome) values (now(), 'account', 'withdraw', 'merchant', '${A}', 'done')`,
          );
        }),
      ).rejects.toThrow();

      expect((await store.merchantById(A))?.liveApprovedAt).toBe(1_500);
      expect((await store.journal({ limit: 10 })).total).toBe(0);
    });

    it("commits a dashboard action's change with its row, and neither when the transaction fails after the row", async () => {
      const row: JournalEntry = { ...withdrawal(2_000), outcome: { kind: "done" } };

      await expect(
        db.transaction(async (tx) => {
          await tx.update(merchants).set({ liveApprovedAt: null }).where(eq(merchants.id, A));
          await journalAlong(tx, row);
          throw new Error("the action failed after its row");
        }),
      ).rejects.toThrow("the action failed after its row");
      expect((await store.merchantById(A))?.liveApprovedAt).toBe(1_500);
      expect((await store.journal({ limit: 10 })).total).toBe(0);

      await db.transaction(async (tx) => {
        await tx.update(merchants).set({ liveApprovedAt: null }).where(eq(merchants.id, A));
        await journalAlong(tx, row);
      });
      expect((await store.merchantById(A))?.liveApprovedAt).toBeNull();
      expect((await store.journal({ limit: 10 })).rows.map((one) => one.outcome)).toStrictEqual([
        { kind: "done" },
      ]);
    });

    it("records two withdrawals pressed at once as one done and one unchanged", async () => {
      const both = await Promise.all([
        store.withdrawLiveApproval(A, withdrawal(2_000)),
        store.withdrawLiveApproval(A, withdrawal(2_001)),
      ]);

      expect(both.filter((one) => one?.changed === true)).toHaveLength(1);
      const { rows } = await store.journal({ limit: 10 });
      expect(rows.map((one) => one.outcome.kind).sort()).toStrictEqual(["done", "unchanged"]);
    });

    it("keeps a forgotten merchant's rows, naming an identifier that no longer resolves", async () => {
      await store.withdrawLiveApproval(A, withdrawal(2_000));

      await pool.query("delete from merchants where id = $1", [A]);

      expect(await store.merchantById(A)).toBeNull();
      expect((await store.journal({ about: { merchant: A }, limit: 10 })).total).toBe(1);
    });
  });
}

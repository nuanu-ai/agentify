import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  noDatabaseHere,
  readyDatabase,
  testDatabaseUrl,
} from "@agentify/commerce-gateway/testing/database";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_commerce_test_release_fingerprint";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));
  describe("the retained-data release fingerprint", () => {
    it.skip("is skipped: there is no Postgres to run it against", () => {});
  });
} else {
  const pool = new Pool({ connectionString: databaseUrl });
  const here = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(
    join(here, "../../../deploy/ansible/release-data-fingerprint.sql"),
    "utf8",
  );
  const generator = source
    .slice(source.indexOf("SELECT format("), source.indexOf("\\gexec"))
    .replaceAll(":'identity_cutover'::boolean", "false");

  const fingerprint = async (): Promise<unknown> => {
    const generated = await pool.query<{ format: string }>(generator);
    return Promise.all(
      generated.rows.map(({ format }) => pool.query(format).then(({ rows }) => rows)),
    );
  };

  afterAll(async () => {
    await pool.end();
  });

  describe("the retained-data release fingerprint", () => {
    it("normalizes only the Woo revision added with the migration default", async () => {
      await pool.query("drop table if exists cabinet_woo_shops");
      await pool.query(`create table cabinet_woo_shops (
        account_id text primary key,
        shop_url text not null,
        consumer_key text not null,
        consumer_secret text not null,
        permissions text not null,
        connected_at timestamp with time zone not null
      )`);
      await pool.query(
        "insert into cabinet_woo_shops values ('account_1', 'https://shop.example', 'key', 'secret', 'read_write', '2026-09-18T10:00:00Z')",
      );
      const beforeMigration = await fingerprint();

      await pool.query(
        "alter table cabinet_woo_shops add column revision text default 'legacy' not null",
      );
      expect(await fingerprint()).toStrictEqual(beforeMigration);

      await pool.query("update cabinet_woo_shops set revision = 'grant_new'");
      expect(await fingerprint()).not.toStrictEqual(beforeMigration);
      await pool.query("update cabinet_woo_shops set revision = 'legacy'");

      for (const [column, changed, original] of [
        ["shop_url", "https://changed.example", "https://shop.example"],
        ["consumer_key", "changed-key", "key"],
        ["consumer_secret", "changed-secret", "secret"],
        ["permissions", "read", "read_write"],
        ["connected_at", "2026-09-18T11:00:00Z", "2026-09-18T10:00:00Z"],
      ] as const) {
        await pool.query(`update cabinet_woo_shops set ${column} = $1`, [changed]);
        expect(await fingerprint(), column).not.toStrictEqual(beforeMigration);
        await pool.query(`update cabinet_woo_shops set ${column} = $1`, [original]);
      }

      await pool.query(
        "insert into cabinet_woo_shops values ('account_2', 'https://second.example', 'key-2', 'secret-2', 'read_write', '2026-09-18T10:00:00Z', 'legacy')",
      );
      expect(await fingerprint(), "row count").not.toStrictEqual(beforeMigration);
    });
  });
}

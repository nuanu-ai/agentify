import { fileURLToPath } from "node:url";
import { telemetryDatabase } from "@agentify/observability/source";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMERCE_SNAPSHOT_QUERY } from "./telemetry.js";
import { testDatabaseUrl } from "./testing/database.js";

const url = testDatabaseUrl();
const writer = new Pool({ connectionString: url });
const reader = telemetryDatabase(url);
const merchant = "telemetry-database-observation";

beforeAll(async () => {
  await migrate(drizzle(writer), {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  await writer.query(
    "insert into merchants (id,name,selling,created_at,updated_at) values ($1,'Telemetry test','open',now(),now())",
    [merchant],
  );
});
afterAll(async () => {
  await writer.query("delete from orders where merchant_id=$1", [merchant]);
  await writer.query("delete from merchants where id=$1", [merchant]);
  await Promise.all([reader.end(), writer.end()]);
});

describe("operational reads on the migrated order database", () => {
  it("includes old closed unknown payments while excluding old settled closed orders", async () => {
    for (const [id, payment, open] of [
      ["unknown", "outcome_unknown", false],
      ["closed", "settled", false],
      ["open", "verified", true],
    ] as const) {
      await writer.query(
        `insert into orders
        (id,state,open,merchant_id,item_id,merchant_item_id,record,created_at,updated_at)
        values ($1,'rejected',$2,$3,'item','item',$4,now()-interval '1 day',now()-interval '1 day')`,
        [`telemetry-${id}`, open, merchant, JSON.stringify({ order: { payment } })],
      );
    }
    const result = await reader.query(COMMERCE_SNAPSHOT_QUERY, [
      new Date(Date.now() - 900_000),
      1_001,
    ]);
    expect(result.rows.map((row) => row.record.order.payment).sort()).toEqual([
      "outcome_unknown",
      "verified",
    ]);
  });

  it("cannot change business rows and cancels slow statements at the server", async () => {
    await expect(
      reader.query("delete from orders where merchant_id=$1", [merchant]),
    ).rejects.toMatchObject({ code: "25006" });
    await expect(reader.query("select pg_sleep(5)")).rejects.toMatchObject({ code: "57014" });
    expect((await reader.query("select 1 as ready")).rows[0].ready).toBe(1);
  });
});

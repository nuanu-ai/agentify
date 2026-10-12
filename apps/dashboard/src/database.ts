import { failureNamed } from "@agentify/gateway/failure-named";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Not drizzle's default table, which is the gateway's: two sets of migrations
 * sharing one journal would each read the other's entries as their own. The
 * name must never change, because a revision that finds no history under it
 * applies every migration again from the first, onto empty tables beside the
 * real ones.
 */
const MIGRATIONS_TABLE = "cabinet_migrations";

/**
 * A pool reports the failure of a connection nobody is waiting on (a database
 * restart, a failover, an idle reaper) as an `error` event on itself, and an
 * `error` event with no listener kills the process.
 *
 * The failure is logged by its name alone: the driver's error carries the
 * query's bound values, which include session identifiers and one-time-link
 * claims, and a server's message can quote a value too.
 */
export function connect(databaseUrl: string): Pool {
  const pool = new Pool({ connectionString: databaseUrl });
  const noticeTheFailure = (failed: unknown): void => {
    console.error(`[dashboard] a database connection failed: ${failureNamed(failed)}`);
  };

  // pg-pool removes its listener from a client while the client is checked out,
  // and a transaction holds a client across statements; `acquire` and `release`
  // cover that gap.
  pool.on("error", noticeTheFailure);
  pool.on("acquire", (client) => client.on("error", noticeTheFailure));
  pool.on("release", (_failed, client) => client.removeListener("error", noticeTheFailure));
  return pool;
}

export async function migrateAccounts(pool: Pool, migrationsFolder: string): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder, migrationsTable: MIGRATIONS_TABLE });
}

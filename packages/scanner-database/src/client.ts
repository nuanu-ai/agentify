import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema.js";

export function normalizeNodePostgresConnectionString(
  connectionString: string,
): string {
  const url = new URL(connectionString);
  if (
    url.searchParams.get("sslmode") === "require" &&
    !url.searchParams.has("uselibpqcompat")
  ) {
    url.searchParams.set("uselibpqcompat", "true");
  }
  return url.toString();
}

export function createDatabase(
  connectionString: string,
  options: Omit<PoolConfig, "connectionString"> = {},
) {
  const pool = new Pool({
    connectionString: normalizeNodePostgresConnectionString(connectionString),
    max: 10,
    ...options,
  });
  return { db: drizzle(pool, { schema }), pool };
}

export type Database = ReturnType<typeof createDatabase>["db"];
export type DatabaseTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

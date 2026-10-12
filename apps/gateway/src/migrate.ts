/**
 * Applies the checked-in migrations to the database DATABASE_URL names. It is a
 * separate step rather than part of startup, because replicas that migrate on
 * boot race each other over the same tables.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.error("DATABASE_URL is not set, so there is no database to migrate.");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const pool = new Pool({ connectionString: databaseUrl });

try {
  await migrate(drizzle(pool), { migrationsFolder: join(here, "..", "drizzle") });
  console.log("The database is up to date.");
} finally {
  await pool.end();
}

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { Database } from "./client.js";

/**
 * The scanner's own migration history table; the default one is the
 * gateway's. Drizzle's migrator applies every file dated after the newest
 * entry it finds and compares nothing else, so two sets sharing one table
 * would each skip the other's older files as though they had run.
 */
const MIGRATIONS_TABLE = "scanner_migrations";

/**
 * The command applies every pending migration and takes no argument. A flag it
 * ignored would still run every migration, for somebody who had asked it to do
 * less, so an argument is refused before the database is touched.
 */
export function refuseArguments(args: readonly string[]): void {
  if (args.length > 0) {
    throw new Error(
      `The scanner migration command takes no arguments; it applies every pending migration. Refused: ${args.join(" ")}`,
    );
  }
}

export async function migrateDatabase(db: Database, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder, migrationsTable: MIGRATIONS_TABLE });
}

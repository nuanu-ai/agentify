import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { Database } from "./client.js";

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
  await migrate(db, { migrationsFolder });
}

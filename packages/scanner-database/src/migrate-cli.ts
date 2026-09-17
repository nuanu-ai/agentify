import { fileURLToPath } from "node:url";

import { z } from "zod";

import { createDatabase } from "./client.js";
import {
  migrateDatabase,
  migrateDatabaseThroughIdentityPreflight,
  migrationModeFromArgs,
} from "./migrate.js";

const env = z
  .object({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) })
  .parse(process.env);
const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const { db, pool } = createDatabase(env.DATABASE_URL, { max: 1 });

try {
  const mode = migrationModeFromArgs(process.argv.slice(2));
  if (mode === "identity-preflight") {
    await migrateDatabaseThroughIdentityPreflight(db, migrationsFolder);
    process.stdout.write(
      "Scanner identity additive migrations applied through 0016.\n",
    );
  } else {
    await migrateDatabase(db, migrationsFolder);
    process.stdout.write("Database migrations applied successfully.\n");
  }
} finally {
  await pool.end();
}

import { fileURLToPath } from "node:url";

import { z } from "zod";

import { createDatabase } from "./client.js";
import { migrateDatabase, refuseArguments } from "./migrate.js";

refuseArguments(process.argv.slice(2));

const env = z.object({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) }).parse(process.env);
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const { db, pool } = createDatabase(env.DATABASE_URL, { max: 1 });

try {
  await migrateDatabase(db, migrationsFolder);
  process.stdout.write("Database migrations applied successfully.\n");
} finally {
  await pool.end();
}

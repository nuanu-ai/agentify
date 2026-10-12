import { defineConfig } from "drizzle-kit";

/**
 * The migration history is kept in its own table, not drizzle's default one,
 * which belongs to the gateway; `src/database.ts` says why its name must not
 * change.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  migrations: { table: "cabinet_migrations" },
  strict: true,
});

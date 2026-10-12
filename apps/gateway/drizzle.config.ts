import { defineConfig } from "drizzle-kit";

/**
 * The generated SQL is checked in, so a deployment applies a file somebody read
 * rather than whatever a tool works out at the time. It is applied by
 * `pnpm --filter @agentify/gateway db:migrate`, which needs only DATABASE_URL.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/adapters/postgres/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
});

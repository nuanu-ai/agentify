import { defineConfig } from "vitest/config";

/**
 * The suite that needs a database, kept out of `pnpm test` because a Postgres
 * server is neither free nor offline.
 *
 *   docker compose up -d --wait postgres
 *   pnpm test:db
 *
 * Name the service: `docker compose up -d` alone starts the whole stack.
 *
 * The suite runs against its own `agentify_test` database and creates it if
 * missing. A host whose Postgres is not on the 5432 `compose.yaml` publishes
 * (a deployment binds `127.0.0.1:55432`) says so to the command:
 *
 *   AGENTIFY_TEST_DATABASE_URL=postgres://agentify:agentify@localhost:55432/agentify_test \
 *     pnpm test:db
 *
 * DATABASE_URL also overrides the default. Either one naming `agentify` is
 * refused: this suite empties every table it finds and drops the queue's
 * schema.
 */
export default defineConfig({
  test: {
    environment: "node",
    // A run with no server reachable fails here rather than skipping every file
    // and exiting zero.
    globalSetup: ["./vitest.db.setup.ts"],
    include: ["apps/*/src/**/*.db-test.ts"],
    // The offline suite's network refusal. A database is not reached with
    // `fetch`, so this still rules out a call to somebody's live API.
    setupFiles: ["./vitest.setup.ts"],
    passWithNoTests: false,
    // Verbose so that the sentence explaining a skip is printed; "1 skipped"
    // alone reads like a pass.
    reporters: ["verbose"],
    // One database, one schema: two files writing the same tables at once would
    // be testing each other.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

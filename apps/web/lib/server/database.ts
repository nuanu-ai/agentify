import { createDatabase } from "@agentify/scanner-database";

import { getServerConfig } from "./config";
import { logBackgroundFailure } from "./http";

const globalDatabase = globalThis as typeof globalThis & {
  agentifyDatabase?: ReturnType<typeof createDatabase>;
};

/**
 * The process's one pool. A connection that fails while nobody holds it is an
 * `error` event on the pool, and one that fails while a transaction holds it
 * is an `error` event on that connection, from which pg-pool takes its own
 * listener while it is held; either with no listener ends the process. So both
 * are logged, and the statement in flight, if any, fails on its own.
 */
export function getDatabase() {
  globalDatabase.agentifyDatabase ??= (() => {
    const database = createDatabase(getServerConfig().DATABASE_URL);
    const noticed = (failed: unknown) =>
      logBackgroundFailure("web_database_connection_failed", failed);
    database.pool.on("error", noticed);
    database.pool.on("acquire", (client) => client.on("error", noticed));
    database.pool.on("release", (_failed, client) => client.removeListener("error", noticed));
    return database;
  })();
  return globalDatabase.agentifyDatabase;
}

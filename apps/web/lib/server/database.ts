import { createDatabase } from "@agentify/scanner-database";

import { getServerConfig } from "./config";

const globalDatabase = globalThis as typeof globalThis & {
  agentifyDatabase?: ReturnType<typeof createDatabase>;
};

export function getDatabase() {
  globalDatabase.agentifyDatabase ??= createDatabase(
    getServerConfig().DATABASE_URL,
  );
  return globalDatabase.agentifyDatabase;
}

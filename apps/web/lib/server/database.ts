import { createDatabase } from "@agentify/scanner-database";

import { getServerConfig } from "./config";

const globalDatabase = globalThis as typeof globalThis & {
  b2aDatabase?: ReturnType<typeof createDatabase>;
};

export function getDatabase() {
  globalDatabase.b2aDatabase ??= createDatabase(getServerConfig().DATABASE_URL);
  return globalDatabase.b2aDatabase;
}

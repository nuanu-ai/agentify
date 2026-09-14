import { createDatabase } from "@agentify/scanner-database";

import { getServerConfig } from "./config";

const globalDashboardDatabase = globalThis as typeof globalThis & {
  b2aDashboardDatabase?: ReturnType<typeof createDatabase>;
};

export function getDashboardDatabase() {
  const config = getServerConfig();
  globalDashboardDatabase.b2aDashboardDatabase ??= createDatabase(
    config.DASHBOARD_DATABASE_URL ?? config.DATABASE_URL,
  );
  return globalDashboardDatabase.b2aDashboardDatabase;
}

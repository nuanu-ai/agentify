import { createDatabase } from "@agentify/scanner-database";

import { getServerConfig } from "./config";

const globalDashboardDatabase = globalThis as typeof globalThis & {
  agentifyDashboardDatabase?: ReturnType<typeof createDatabase>;
};

export function getDashboardDatabase() {
  const config = getServerConfig();
  globalDashboardDatabase.agentifyDashboardDatabase ??= createDatabase(
    config.DASHBOARD_DATABASE_URL ?? config.DATABASE_URL,
  );
  return globalDashboardDatabase.agentifyDashboardDatabase;
}

/**
 * Starts the dashboard inside the process it shares with the gateway: its
 * listeners, the scanner's route where its secret is set, and the WooCommerce
 * worker, which fills paid orders for merchants who connected a shop instead of
 * writing code. The worker does not start on the live channel, where the
 * connector is not offered.
 *
 * Migrations are not run here: a process that migrates on boot migrates once
 * per replica and races itself.
 */

import type { Server } from "node:http";
import type { Gateway } from "@agentify/gateway";
import { closedWithin } from "./closing.js";
import type { DashboardConfig } from "./config.js";
import { connect } from "./database.js";
import { gatewayFor } from "./gateway.js";
import { identityFor } from "./identity.js";
import { isSandboxMail, postmanFor } from "./mail.js";
import { startReportIdentityServer } from "./report-identity-server.js";
import { buildApp } from "./server.js";
import { type Teller, tellerFor } from "./teller.js";
import { postgresWooShops, wooOfferedOn } from "./woo-shops.js";
import { startWooWorker } from "./woo-worker.js";

/**
 * Fixed rather than read from `PORT`, because the gateway shares this process's
 * environment and a `PORT` there could mean only one of them.
 */
export const DASHBOARD_PORT = 3001;

/**
 * The gateway is let go only after this, so it stays short of the ten seconds a
 * page gives a call to the gateway and of the ten `docker compose stop` waits
 * before killing the process.
 */
const CLOSING_GRACE_MS = 5_000;

export interface RunningDashboard {
  /**
   * Settles once in-flight requests have ended or been cut at the end of the
   * grace.
   */
  closeListeners(): Promise<void>;
  /** Settles once the turn in flight has ended. */
  stopWorker(): Promise<void>;
  close(): Promise<void>;
}

export interface Dashboard {
  /**
   * Handed to the gateway, which announces wallet and key changes through it.
   */
  readonly tell: Teller;
  start(application: Gateway): RunningDashboard;
}

const closed = (listener: Server | null): Promise<void> =>
  listener === null ? Promise.resolve() : closedWithin(listener, CLOSING_GRACE_MS);

export function dashboardFor(config: DashboardConfig): Dashboard {
  const pool = connect(config.databaseUrl);
  const identity = identityFor(config, { pool });
  const wooShops = postgresWooShops(pool);
  return {
    tell: tellerFor(config, identity, postmanFor(config)),
    start: (application) => started(config, application, identity, wooShops),
  };
}

function started(
  config: DashboardConfig,
  application: Gateway,
  identity: ReturnType<typeof identityFor>,
  wooShops: ReturnType<typeof postgresWooShops>,
): RunningDashboard {
  const reportIdentityServer = startReportIdentityServer(config.reportIdentitySecret, identity);

  const server = buildApp(config, { gateway: application, identity, wooShops }).listen(
    DASHBOARD_PORT,
    () => {
      console.log(`[dashboard] listening on ${DASHBOARD_PORT}`);
      // Says which delivery mode is in force without logging recipients or
      // links from a real provider.
      console.log(
        isSandboxMail(config.mailUrl)
          ? "[dashboard] no mail provider is configured: every message is written to this log instead"
          : `[dashboard] messages are sent through ${config.mailUrl}, from ${config.mailFrom}`,
      );
    },
  );

  const worker = !wooOfferedOn(config.surfaceMode)
    ? { stop: async () => {} }
    : startWooWorker({
        shops: wooShops,
        identity,
        clientFor: (acting) => gatewayFor(application, acting),
        now: () => new Date(),
      });

  return {
    async closeListeners() {
      await Promise.all([server, reportIdentityServer].map(closed));
    },
    stopWorker: () => worker.stop(),
    close: () => identity.close(),
  };
}

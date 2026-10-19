/**
 * Starts the dashboard inside the process it shares with the gateway: its
 * listeners, the scanner's route where its secret is set, the WooCommerce
 * worker, which fills paid orders for merchants who connected a shop instead of
 * writing code, and the loop that reports registrations from ads to the ad
 * tracker. The worker does not start on the live channel, where the connector
 * is not offered. The reports' loop starts everywhere: switched on it reports,
 * and switched off it only gives up what is left pending a day on.
 *
 * Migrations are not run here: a process that migrates on boot migrates once
 * per replica and races itself.
 */

import type { Server } from "node:http";
import type { Gateway } from "@agentify/gateway";
import type { Pool } from "pg";
import { PostgresApprovalDirectory } from "./approval-directory.js";
import { closedWithin } from "./closing.js";
import type { DashboardConfig } from "./config.js";
import { connect } from "./database.js";
import { gatewayFor } from "./gateway.js";
import { identityFor } from "./identity.js";
import { isSandboxMail, postmanFor } from "./mail.js";
import type { Pages } from "./pages.js";
import { startRegistrationReports } from "./registration-postbacks.js";
import { startReportIdentityServer } from "./report-identity-server.js";
import { buildApp } from "./server.js";
import type { CommissionRate } from "./shares.js";
import { type Teller, tellerFor } from "./teller.js";
import { postgresWooShops, wooOfferedOn } from "./woo-shops.js";
import { startWooWorker } from "./woo-worker.js";

export { builtPages, type Pages, pagesFromSource } from "./pages.js";

/**
 * Fixed rather than read from `PORT`, because the gateway shares this process's
 * environment and a `PORT` there could mean only one of them.
 */
const DASHBOARD_PORT = 3001;

/**
 * The gateway is let go only after this, so it stays short of the ten seconds a
 * page gives a call to the gateway and of the ten `docker compose stop` waits
 * before killing the process.
 */
const CLOSING_GRACE_MS = 5_000;

interface RunningDashboard {
  /**
   * Settles once in-flight requests have ended or been cut at the end of the
   * grace.
   */
  closeListeners(): Promise<void>;
  /** Settles once the turns in flight have ended. */
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

/**
 * The rate is the gateway's: the dashboard is made before the gateway it
 * announces for, and its messages name the rate the gateway records splits
 * with.
 */
export function dashboardFor(
  config: DashboardConfig,
  pages: Pages,
  rate: CommissionRate,
): Dashboard {
  const pool = connect(config.databaseUrl);
  const identity = identityFor(config, { pool });
  const wooShops = postgresWooShops(pool);
  return {
    tell: tellerFor(config, identity, postmanFor(config), rate),
    start: (application) => started(config, application, { pool, identity, wooShops }, pages),
  };
}

function started(
  config: DashboardConfig,
  application: Gateway,
  {
    pool,
    identity,
    wooShops,
  }: Readonly<{
    pool: Pool;
    identity: ReturnType<typeof identityFor>;
    wooShops: ReturnType<typeof postgresWooShops>;
  }>,
  pages: Pages,
): RunningDashboard {
  const reportIdentityServer = startReportIdentityServer(config.reportIdentitySecret, identity);

  const app = buildApp(config, {
    gateway: application,
    identity,
    wooShops,
    pages,
    approvalDirectory: new PostgresApprovalDirectory(pool),
  });
  const listening = () => {
    console.log(`[dashboard] listening on ${DASHBOARD_PORT}`);
    // Says which delivery mode is in force without logging recipients or
    // links from a real provider.
    console.log(
      isSandboxMail(config.mailUrl)
        ? "[dashboard] no mail provider is configured: every message is written to this log instead"
        : `[dashboard] messages are sent through ${config.mailUrl}, from ${config.mailFrom}`,
    );
  };
  const server =
    pages.host === undefined
      ? app.listen(DASHBOARD_PORT, listening)
      : app.listen(DASHBOARD_PORT, pages.host, listening);

  const worker = !wooOfferedOn(config.surfaceMode)
    ? { stop: async () => {} }
    : startWooWorker({
        shops: wooShops,
        identity,
        clientFor: (acting) => gatewayFor(application, acting),
        now: () => new Date(),
      });

  const reports = startRegistrationReports({ pool, target: config.registrationPostback });

  return {
    async closeListeners() {
      await Promise.all([server, reportIdentityServer].map(closed));
    },
    stopWorker: async () => {
      await Promise.all([worker.stop(), reports.stop()]);
    },
    close: async () => {
      await Promise.all([identity.close(), pages.close()]);
    },
  };
}

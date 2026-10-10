/**
 * Starting the dashboard, inside the resident process (ADR-0030).
 *
 * It opens a connection to its own tables and hands the process its way of
 * telling a merchant of a change, which the gateway announces through; then,
 * given the gateway's application, it puts the pages on a port, opens the
 * scanner's route where its secret is set, and starts the one thing in here
 * that runs without anybody looking at a screen. The process itself, its
 * signals and the order things start and stop in belong to `apps/app`, which
 * starts the gateway beside this. The tables are the people who sign in, their
 * sessions, the one-time links they are sent, and a merchant's connected
 * WooCommerce shop (ADR-0026 §2, ADR-0023): every card, order and receipt on
 * every screen comes from the gateway's application, called inside this
 * process as the merchant on the signed-in account's row (ADR-0030).
 *
 * The worker is the one part of the dashboard that is not a page. A merchant who
 * connected a WooCommerce shop wrote no code of their own, so their paid orders
 * are filled here — drawn off their own stream by the same calls a merchant's
 * worker makes over the API. A dashboard with no connected shop does nothing
 * at all in it, and on the live channel, where the connector is not offered,
 * it does not start.
 *
 * There is nothing to migrate here. `pnpm --filter @agentify/dashboard db:migrate`
 * is a step somebody takes before this starts, because a process that migrates
 * on boot migrates once per replica and races itself.
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
 * The port the merchant's pages answer on, behind Caddy at `/dashboard`. Fixed,
 * like the scanner's route on 3002, because the gateway shares this process's
 * environment and a `PORT` there could mean only one of them.
 */
export const DASHBOARD_PORT = 3001;

/**
 * How long a page already being answered at shutdown is given to finish
 * before its connection is cut. The gateway is let go only after it, so it is
 * short of the ten seconds a page gives a call to the gateway and of the ten a
 * laptop's `docker compose stop` waits before killing the process.
 */
const CLOSING_GRACE_MS = 5_000;

/** The dashboard, started, with what the process stops it by. */
export interface RunningDashboard {
  /**
   * Takes no new request on any of its ports, and settles once the ones in
   * flight have ended, or have been cut at the end of the grace.
   */
  closeListeners(): Promise<void>;
  /** Stops filling WooCommerce orders, and settles once the turn in flight has ended. */
  stopWorker(): Promise<void>;
  /** Closes the connections to its tables. */
  close(): Promise<void>;
}

/**
 * The dashboard, before it opens its doors: what the gateway needs from it
 * before either starts serving, and the start itself.
 */
export interface Dashboard {
  /**
   * Tells every account naming a merchant of a change to their wallet or their
   * keys (ADR-0019): what the process hands the gateway to announce through.
   */
  readonly tell: Teller;
  /**
   * Opens its doors and, where the connector is offered, starts the
   * WooCommerce worker, calling the gateway's application inside the process.
   */
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
      // Mail is the sign-in channel; make the configured delivery mode visible
      // without writing recipients or action links from a real provider to logs.
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

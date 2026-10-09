/**
 * Starting the dashboard, inside the resident process (ADR-0030).
 *
 * It opens a connection to its own tables, puts the pages on a port, opens the
 * two internal listeners its secrets ask for, and starts the one thing in here
 * that runs without anybody looking at a screen. The process itself, its
 * signals and the order things stop in belong to `apps/app`, which starts the
 * gateway beside this. The tables are the people who sign in, their sessions,
 * the one-time links they are sent, and a merchant's connected WooCommerce
 * shop (ADR-0009 §1, ADR-0023): every card, order and receipt on every screen
 * still comes from the gateway's public API, which is the promise ADR-0005 §3
 * is actually about.
 *
 * The worker is the one part of the dashboard that is not a page. A merchant who
 * connected a WooCommerce shop wrote no code of their own, so their paid orders
 * are filled here — drawn off their own stream with their own key, over the
 * same public API any merchant's worker uses. A dashboard with no connected shop
 * does nothing at all in it.
 *
 * There is nothing to migrate here. `pnpm --filter @agentify/dashboard db:migrate`
 * is a step somebody takes before this starts, because a process that migrates
 * on boot migrates once per replica and races itself.
 */

import type { Server } from "node:http";
import type { DashboardConfig } from "./config.js";
import { keyRenewal } from "./dashboard-key.js";
import { connect } from "./database.js";
import { gatewayFor } from "./gateway.js";
import { startGatewayServer, tellerFor } from "./gateway-server.js";
import { identityFor } from "./identity.js";
import { isSandboxMail, postmanFor } from "./mail.js";
import { startReportIdentityServer } from "./report-identity-server.js";
import { buildApp } from "./server.js";
import { postgresWooShops } from "./woo-shops.js";
import { startWooWorker } from "./woo-worker.js";

/**
 * The port the merchant's pages answer on, behind Caddy at `/dashboard`. Fixed,
 * like the scanner's route on 3002 and the gateway's on 3003, because the
 * gateway shares this process's environment and a `PORT` there could mean only
 * one of them.
 */
export const DASHBOARD_PORT = 3001;

/** The dashboard, started, with what the process stops it by. */
export interface RunningDashboard {
  /** Takes no new request on any of its ports, and settles once the ones in flight have ended. */
  closeListeners(): Promise<void>;
  /** Stops filling WooCommerce orders, and settles once the turn in flight has ended. */
  stopWorker(): Promise<void>;
  /** Closes the connections to its tables. */
  close(): Promise<void>;
}

const closed = (listener: Server | null): Promise<void> =>
  listener === null
    ? Promise.resolve()
    : new Promise<void>((resolve) => listener.close(() => resolve()));

export function startDashboard(config: DashboardConfig): RunningDashboard {
  const pool = connect(config.databaseUrl);
  const identity = identityFor(config, { pool });
  const wooShops = postgresWooShops(pool);
  const reportIdentityServer = startReportIdentityServer(
    config.reportIdentitySecret,
    identity,
    keyRenewal(identity, (key, answerWithinMs) =>
      gatewayFor(config.gatewayUrl, key, answerWithinMs),
    ),
  );
  // The gateway's route, for telling a merchant of a change to their wallet or
  // their keys (ADR-0019), on a port of its own behind a secret of its own.
  const gatewayServer = startGatewayServer(
    config.gatewayDashboardSecret,
    tellerFor(config, identity, postmanFor(config)),
  );

  const server = buildApp(config, { identity, wooShops }).listen(DASHBOARD_PORT, () => {
    console.log(`[dashboard] listening on ${DASHBOARD_PORT}, reading ${config.gatewayUrl}`);
    // Mail is the sign-in channel; make the configured delivery mode visible
    // without writing recipients or action links from a real provider to logs.
    console.log(
      isSandboxMail(config.mailUrl)
        ? "[dashboard] no mail provider is configured: every message is written to this log instead"
        : `[dashboard] messages are sent through ${config.mailUrl}, from ${config.mailFrom}`,
    );
  });

  const worker = startWooWorker({
    shops: wooShops,
    identity,
    clientFor: (key) => gatewayFor(config.gatewayUrl, key),
    now: () => new Date(),
  });

  return {
    async closeListeners() {
      await Promise.all([server, reportIdentityServer, gatewayServer].map(closed));
    },
    stopWorker: () => worker.stop(),
    close: () => identity.close(),
  };
}

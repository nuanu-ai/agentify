/**
 * Starting the cabinet.
 *
 * It reads its configuration, opens a connection to its own tables, puts the
 * pages on a port, starts the one thing in here that runs without anybody
 * looking at a screen, and stops on a signal. The tables are the people who
 * sign in, their sessions, the one-time links they are sent,
 * and a merchant's connected WooCommerce shop (ADR-0009 §1, ADR-0023): every
 * card, order and receipt on every screen still comes from the gateway's public
 * API, which is the promise ADR-0005 §3 is actually about.
 *
 * The worker is the one part of this process that is not a page. A merchant who
 * connected a WooCommerce shop wrote no code of their own, so their paid orders
 * are filled here — drawn off their own stream with their own key, over the
 * same public API any merchant's worker uses. A cabinet with no connected shop
 * does nothing at all in it.
 *
 * There is nothing to migrate here. `pnpm --filter @agentify/cabinet db:migrate`
 * is a step somebody takes before this starts, because a process that migrates
 * on boot migrates once per replica and races itself.
 */

import { keyRenewal } from "./cabinet-key.js";
import { loadConfig } from "./config.js";
import { connect } from "./database.js";
import { gatewayFor } from "./gateway.js";
import { startGatewayServer, tellerFor } from "./gateway-server.js";
import { identityFor } from "./identity.js";
import { isSandboxMail, postmanFor } from "./mail.js";
import { startReportIdentityServer } from "./report-identity-server.js";
import { buildApp } from "./server.js";
import { postgresWooShops } from "./woo-shops.js";
import { startWooWorker } from "./woo-worker.js";

const config = loadConfig(process.env);
const pool = connect(config.databaseUrl);
const identity = identityFor(config, { pool });
const wooShops = postgresWooShops(pool);
const reportIdentityServer = startReportIdentityServer(
  config.reportIdentitySecret,
  identity,
  keyRenewal(identity, (key, answerWithinMs) => gatewayFor(config.gatewayUrl, key, answerWithinMs)),
);
// The gateway's route, for telling a merchant of a change to their wallet or
// their keys (ADR-0019), on a port of its own behind a secret of its own.
const gatewayServer = startGatewayServer(
  config.gatewayCabinetSecret,
  tellerFor(config, identity, postmanFor(config)),
);

const server = buildApp(config, { identity, wooShops }).listen(config.port, () => {
  console.log(`[cabinet] listening on ${config.port}, reading ${config.gatewayUrl}`);
  // Mail is the sign-in channel; make the configured delivery mode visible
  // without writing recipients or action links from a real provider to logs.
  console.log(
    isSandboxMail(config.mailUrl)
      ? "[cabinet] no mail provider is configured: every message is written to this log instead"
      : `[cabinet] messages are sent through ${config.mailUrl}, from ${config.mailFrom}`,
  );
});

const worker = startWooWorker({
  shops: wooShops,
  identity,
  clientFor: (key) => gatewayFor(config.gatewayUrl, key),
  now: () => new Date(),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    const publicClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    const privateClosed = [reportIdentityServer, gatewayServer].map((listener) =>
      listener === null
        ? Promise.resolve()
        : new Promise<void>((resolve) => listener.close(() => resolve())),
    );
    void Promise.all([publicClosed, ...privateClosed])
      .then(() => worker.stop())
      .finally(() => identity.close())
      .finally(() => process.exit(0));
  });
}

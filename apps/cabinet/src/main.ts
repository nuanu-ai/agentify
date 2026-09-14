/**
 * Starting the cabinet.
 *
 * It reads its configuration, opens a connection to its own tables, puts the
 * pages on a port, starts the one thing in here that runs without anybody
 * looking at a screen, and stops on a signal. The tables are the people who
 * sign in, their sessions, their passwords, the one-time links they are sent,
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
 * There is nothing to migrate here. `pnpm --filter @agentify/commerce-cabinet db:migrate`
 * is a step somebody takes before this starts, because a process that migrates
 * on boot migrates once per replica and races itself.
 */

import { loadConfig } from "./config.js";
import { connect } from "./database.js";
import { gatewayFor } from "./gateway.js";
import { identityFor } from "./identity.js";
import { isSandboxMail } from "./mail.js";
import { buildApp } from "./server.js";
import { postgresWooShops } from "./woo-shops.js";
import { startWooWorker } from "./woo-worker.js";

const config = loadConfig(process.env);
const pool = connect(config.databaseUrl);
const identity = identityFor(config, { pool });
const wooShops = postgresWooShops(pool);

const server = buildApp(config, { identity, wooShops }).listen(config.port, () => {
  console.log(`[cabinet] listening on ${config.port}, reading ${config.gatewayUrl}`);
  // Said at start-up rather than discovered on the day somebody loses a
  // password. A cabinet that writes its messages to the log is a working
  // cabinet and not a broken one, and the difference is worth one line.
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
    server.close(() => {
      void worker
        .stop()
        .finally(() => identity.close())
        .finally(() => process.exit(0));
    });
  });
}

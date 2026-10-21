/**
 * The application: the gateway and the dashboard in one process.
 *
 * The gateway serves the merchant API under `/v0` and the storefront an agent
 * buys at under `/x402`; the dashboard serves the merchant's pages. They share
 * the process but keep their own listeners: 3000 for the gateway, 3001 for the
 * dashboard's pages and 3002 for the scanner's route to the dashboard. A defect
 * in the dashboard therefore stops sales as well; orders survive in Postgres
 * and resume after the restart.
 *
 * Both configurations are read and refused before anything starts, and so are
 * the dashboard's pages: a gateway that started and then went down over the
 * dashboard's settings would have taken work off the queue for nothing, once
 * per restart.
 *
 * `--dashboard-from-source` compiles the dashboard's pages from their source on
 * each request and reloads them on an edit, for a developer; without it the
 * process serves the build the image compiled.
 */

import { loadConfig as dashboardConfigOf } from "@agentify/dashboard/config";
import { builtPages, dashboardFor, pagesFromSource } from "@agentify/dashboard/start";
import { loadConfig as gatewayConfigOf } from "@agentify/gateway/config";
import { failureNamed } from "@agentify/gateway/failure-named";
import { startGateway } from "@agentify/gateway/start";
import { listenForMetrics } from "@agentify/observability/source";

const startedOrStopped = async () => {
  try {
    const gatewayConfig = gatewayConfigOf(process.env);
    const dashboardConfig = dashboardConfigOf(process.env);
    const pages = process.argv.includes("--dashboard-from-source")
      ? await pagesFromSource({ live: true })
      : await builtPages();
    // The dashboard is made first because the gateway announces changes
    // through it, but the gateway starts first because the dashboard's pages
    // and its WooCommerce worker call the gateway from the moment they are up.
    const made = dashboardFor(dashboardConfig, pages, gatewayConfig.payoutSplit);
    const gateway = await startGateway(gatewayConfig, { announce: made.tell });
    const dashboard = made.start(gateway.application);
    return { gateway, dashboard };
  } catch (thrown) {
    // The whole error with its stack: a database that did not answer needs
    // more than the message.
    console.error(thrown);
    process.exit(1);
  }
};

const { gateway, dashboard } = await startedOrStopped();
const metrics = listenForMetrics();

/**
 * A shutdown in the order that lets each part finish what the others need.
 *
 * The dashboard's listeners close first, so the requests in flight through them
 * end while the gateway they call still answers. The gateway then stops
 * together with the WooCommerce worker, not after it: the worker may be parked
 * on a poll to the gateway, and only the gateway's queue stopping releases
 * parked polls and purchases. The database connections close last.
 */
let stopping = false;
const shutDown = async (signal: string): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log(`[app] ${signal}: stopping`);
  metrics?.close();
  metrics?.closeAllConnections();
  await dashboard.closeListeners();
  gateway.closeListener();
  await Promise.all([dashboard.stopWorker(), gateway.stop()]);
  await dashboard.close();
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutDown(signal).then(
      () => process.exit(0),
      (thrown: unknown) => {
        console.error(`[app] the shutdown did not finish cleanly: ${failureNamed(thrown)}`);
        process.exit(1);
      },
    );
  });
}

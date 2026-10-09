/**
 * The application: the gateway and the dashboard in one process (ADR-0030).
 *
 * The gateway is the money path, the merchant API under `/v0` and the
 * storefront an agent buys at under `/x402`; the dashboard is the merchant's
 * pages and the people who sign in to them. They were two processes released
 * and restarted together, writing one database as one account, so the
 * boundary between them protected little and cost a network call with a
 * credential for everything that crossed it. Here they share a process and
 * keep their own listeners: 3000 for the gateway, 3001 for the dashboard's
 * pages, 3002 for the scanner's route to the dashboard and 3003 for the
 * gateway's. The two still call each other over those ports, on loopback.
 *
 * What one process costs is said in ADR-0030: a defect in the dashboard now
 * stops sales as well. Orders survive in Postgres and resume after the restart.
 *
 * Everything below is wiring, run through tsx like the rest of the workspace
 * (ADR-0003 §1). Both configurations are read and refused before anything
 * starts, because a gateway that started and then went down with the process
 * over the dashboard's settings would have taken work off the queue for
 * nothing, once per restart.
 */

import { loadConfig as dashboardConfigOf } from "@agentify/dashboard/config";
import { startDashboard } from "@agentify/dashboard/start";
import { loadConfig as gatewayConfigOf } from "@agentify/gateway/config";
import { startGateway } from "@agentify/gateway/start";

const startedOrStopped = async () => {
  try {
    const gatewayConfig = gatewayConfigOf(process.env);
    const dashboardConfig = dashboardConfigOf(process.env);
    // The gateway first, because the dashboard's pages and its WooCommerce
    // worker call it from the moment they are up.
    const gateway = await startGateway(gatewayConfig);
    const dashboard = startDashboard(dashboardConfig);
    return { gateway, dashboard };
  } catch (thrown) {
    console.error(thrown instanceof Error ? thrown.message : thrown);
    process.exit(1);
  }
};

const { gateway, dashboard } = await startedOrStopped();

/**
 * A shutdown in the order that lets each part finish what the others need.
 *
 * The dashboard's doors close first, and the requests in flight through them
 * end while the gateway they call still answers. Then the gateway takes no new
 * connection, and it stops at the same time as the WooCommerce worker rather
 * than after it: the worker's turn may be a poll parked on the gateway, and it
 * is the gateway stopping that wakes it, with nothing, as it wakes every
 * merchant's parked poll and every agent's parked purchase. Only then do the
 * connections to the database close.
 */
let stopping = false;
const shutDown = async (signal: string): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log(`[app] ${signal}: stopping`);
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
        console.error("[app] the shutdown did not finish cleanly", thrown);
        process.exit(1);
      },
    );
  });
}

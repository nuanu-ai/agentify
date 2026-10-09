/**
 * Private exact-order recovery. It never scans WooCommerce or retries itself.
 *
 * Run beside the application that is already up, it builds the gateway's
 * application in its own process on the same database, with a queue that
 * writes and does not consume (ADR-0030), and reads and delivers the one order
 * as the merchant on the account that connected the shop.
 */

import { loadConfig as gatewayConfigOf, openCommandApplication } from "@agentify/gateway";
import { loadConfig } from "./config.js";
import { connect } from "./database.js";
import { gatewayFor } from "./gateway.js";
import { identityFor } from "./identity.js";
import { recoverWooOrder } from "./woo-recovery.js";
import { postgresWooShops } from "./woo-shops.js";

const usage =
  "Usage: pnpm --filter @agentify/dashboard woo:recover --order ord_... [--woo-order 123]";

const argumentsOf = (argv: readonly string[]): { orderId: string; wooOrderId?: string } | null => {
  if (argv.length !== 2 && argv.length !== 4) return null;
  if (argv[0] !== "--order" || argv[1] === undefined || argv[1] === "") return null;
  if (argv.length === 4 && (argv[2] !== "--woo-order" || !/^\d+$/.test(argv[3] ?? ""))) {
    return null;
  }
  return argv.length === 4 ? { orderId: argv[1], wooOrderId: argv[3] } : { orderId: argv[1] };
};

const request = argumentsOf(process.argv.slice(2));
if (request === null) {
  console.error(usage);
  process.exitCode = 2;
} else {
  let identity: ReturnType<typeof identityFor> | undefined;
  let opened: Awaited<ReturnType<typeof openCommandApplication>> | undefined;
  try {
    const config = loadConfig(process.env);
    opened = await openCommandApplication(gatewayConfigOf(process.env));
    const application = opened.application;
    const pool = connect(config.databaseUrl);
    identity = identityFor(config, { pool });
    const outcome = await recoverWooOrder(request, {
      shops: postgresWooShops(pool),
      identity,
      gatewayFor: (acting) => gatewayFor(application, acting),
      now: () => new Date(),
    });
    if (outcome.ok) {
      console.log(
        `Recovered ${outcome.orderId} with WooCommerce order ${outcome.wooOrderId}; Agentify reads delivered.`,
      );
      process.exitCode = 0;
    } else {
      console.error(outcome.why);
      process.exitCode = 1;
    }
  } catch {
    console.error(
      "WooCommerce recovery could not be completed; no secret or response body was printed.",
    );
    process.exitCode = 1;
  } finally {
    await identity?.close();
    await opened?.close();
  }
}

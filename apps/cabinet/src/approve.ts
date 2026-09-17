/**
 * The server-side half of `pnpm approve <email>`.
 *
 * It reads the address from standard input, shares one database pool between
 * the cabinet resolver and gateway store, and refuses every payment network
 * except the existing live network classification. There is no HTTP route and
 * no merchant credential involved.
 */

import { environmentOf } from "@agentify/commerce-core";
import {
  connect,
  grantLiveApproval,
  PostgresStore,
  randomIds,
  systemClock,
} from "@agentify/commerce-gateway";
import { runApproval } from "./approval-command.js";
import { PostgresApprovalDirectory } from "./approval-directory.js";

const liveNetwork = (): boolean => {
  const network = process.env.PAYMENT_NETWORK;
  if (network === undefined || network === "") {
    console.error("PRODUCTION approval refused: PAYMENT_NETWORK is not set.");
    return false;
  }

  try {
    if (environmentOf(network) !== "live") {
      console.error("PRODUCTION approval refused: PAYMENT_NETWORK is not the live network.");
      return false;
    }
  } catch {
    console.error("PRODUCTION approval refused: PAYMENT_NETWORK is not a recognized network.");
    return false;
  }
  return true;
};

const emailFromStdin = async (): Promise<string> => {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
};

const main = async (): Promise<number> => {
  if (!liveNetwork()) {
    return 1;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error("PRODUCTION approval refused: DATABASE_URL is not set.");
    return 1;
  }

  let connected: ReturnType<typeof connect> | undefined;
  try {
    connected = connect(databaseUrl);
    const rawEmail = await emailFromStdin();
    const store = new PostgresStore(connected.db, randomIds);
    return await runApproval(
      rawEmail,
      new PostgresApprovalDirectory(connected.pool),
      {
        grant: async (merchantId) => await grantLiveApproval(store, merchantId, systemClock()),
      },
      { say: (line) => console.log(line) },
    );
  } catch {
    console.error(
      "The PRODUCTION approval outcome could not be inspected. Retry the same command; no database details were printed.",
    );
    return 1;
  } finally {
    await connected?.pool.end().catch(() => undefined);
  }
};

process.exitCode = await main();

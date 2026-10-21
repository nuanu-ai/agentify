/**
 * The server-side half of `pnpm approve <email>` and, given `--withdraw`, of
 * `pnpm approve --withdraw <email>`.
 *
 * It reads the address from standard input, shares one database pool between
 * the dashboard resolver and gateway store, and refuses every payment network
 * except the existing live network classification. The administrative screen
 * grants the same approval; no merchant credential can grant or withdraw it.
 */

import { environmentOf } from "@agentify/core";
import {
  connect,
  grantLiveApproval,
  PostgresStore,
  randomIds,
  systemClock,
  withdrawLiveApproval,
} from "@agentify/gateway";
import { type ApprovalAction, runApproval } from "./approval-command.js";
import { PostgresApprovalDirectory } from "./approval-directory.js";

/** The live network `PAYMENT_NETWORK` names, or null, said, where it names none. */
const liveNetwork = (): string | null => {
  const network = process.env.PAYMENT_NETWORK;
  if (network === undefined || network === "") {
    console.error("PRODUCTION approval refused: PAYMENT_NETWORK is not set.");
    return null;
  }

  try {
    if (environmentOf(network) !== "live") {
      console.error("PRODUCTION approval refused: PAYMENT_NETWORK is not the live network.");
      return null;
    }
  } catch {
    console.error("PRODUCTION approval refused: PAYMENT_NETWORK is not a recognized network.");
    return null;
  }
  return network;
};

const emailFromStdin = async (): Promise<string> => {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
};

/** Null, said, for anything but no argument or the one flag. */
const actionAsked = (): ApprovalAction | null => {
  const asked = process.argv.slice(2);
  if (asked.length === 0) return "grant";
  if (asked.length === 1 && asked[0] === "--withdraw") return "withdraw";
  console.error("PRODUCTION approval refused: the only argument this takes is --withdraw.");
  return null;
};

const main = async (): Promise<number> => {
  const action = actionAsked();
  if (action === null) {
    return 1;
  }
  const network = liveNetwork();
  if (network === null) {
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
    const store = PostgresStore.over(connected.db, network, randomIds);
    return await runApproval(
      rawEmail,
      new PostgresApprovalDirectory(connected.pool),
      {
        grant: async (merchantId) => await grantLiveApproval(store, merchantId, systemClock()),
        withdraw: async (merchantId) => await withdrawLiveApproval(store, merchantId),
      },
      { say: (line) => console.log(line) },
      action,
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

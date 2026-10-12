/**
 * The server-side half of `pnpm forget <email>`. It refuses before opening a
 * connection unless the payment network is set, known and a test network, so
 * pointed at the live deployment it can only say no. The work itself is in
 * `forget-account.ts`.
 */

import { environmentOf } from "@agentify/core";
import { connect } from "./database.js";
import { runForget } from "./forget-account.js";

const refusalOf = (network: string | undefined): string | null => {
  if (network === undefined || network === "") return "PAYMENT_NETWORK is not set";
  try {
    if (environmentOf(network) === "test") return null;
  } catch {
    return "PAYMENT_NETWORK is not a recognised network";
  }
  return "PAYMENT_NETWORK is the live network, and this command runs only on the test deployment";
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
  const refusal = refusalOf(process.env.PAYMENT_NETWORK);
  if (refusal !== null) {
    console.error(`TEST forget refused: ${refusal}.`);
    return 1;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error("TEST forget refused: DATABASE_URL is not set.");
    return 1;
  }
  // Sign-in sends are keyed with this secret; without it the wait before the
  // next link could not be cleared.
  const authSecret = process.env.AUTH_SECRET;
  if (authSecret === undefined || authSecret === "") {
    console.error("TEST forget refused: AUTH_SECRET is not set.");
    return 1;
  }

  const pool = connect(databaseUrl);
  try {
    const rawEmail = await emailFromStdin();
    return await runForget(pool, rawEmail, authSecret, { say: (line) => console.log(line) });
  } catch {
    console.error("The TEST forget could not finish, and removed nothing.");
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
};

process.exitCode = await main();

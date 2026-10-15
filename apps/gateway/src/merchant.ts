/**
 * The merchant command, wired to the database. It lists merchants and their
 * keys, disables a key and takes a listing name away; it makes no merchant and
 * issues no key, since a merchant comes into being only through the dashboard.
 * Against the local stack:
 *
 *   docker compose exec app \
 *     pnpm --filter @agentify/gateway merchant list
 *
 * Outside Docker it needs only the DATABASE_URL the gateway is given:
 *
 *   DATABASE_URL=postgres://agentify:agentify@localhost:5432/agentify \
 *     pnpm --filter @agentify/gateway merchant list
 */

import { connect, PostgresStore } from "./adapters/postgres/store.js";
import { DEFAULT_PAYMENT_NETWORK } from "./config.js";
import { runMerchant } from "./merchant-command.js";
import { randomIds, systemClock } from "./ports/clock.js";

/** Postgres's own answer for "there is no table by that name". */
const NO_SUCH_TABLE = "42P01";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.error(
    "DATABASE_URL is not set, so there is no database to keep a merchant in." +
      " It is the same address the gateway is given.",
  );
  process.exit(1);
}

const { db, pool } = connect(databaseUrl);
let code = 1;
try {
  code = await runMerchant(
    process.argv.slice(2),
    // A wallet's split is read on the deployment's network. This command shows
    // none, so where the variable is unset the gateway's own default serves.
    PostgresStore.over(db, process.env.PAYMENT_NETWORK || DEFAULT_PAYMENT_NETWORK, randomIds),
    systemClock,
    (line) => {
      console.log(line);
    },
  );
} catch (thrown) {
  // Missing tables get their own message, because the database's own names a
  // table and does not say what to run.
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    String((thrown as { code: unknown }).code) === NO_SUCH_TABLE
  ) {
    console.error(
      "The gateway's tables are not in this database yet." +
        " Run: pnpm --filter @agentify/gateway db:migrate",
    );
  } else {
    console.error(thrown);
  }
} finally {
  await pool.end();
}

// `process.exitCode` and not `process.exit`, because writes to stdout are
// asynchronous when it is a pipe — which is what it is under
// `docker compose exec` — and `process.exit` does not wait for them.
process.exitCode = code;

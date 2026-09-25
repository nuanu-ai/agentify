/**
 * The merchant command, wired to the database.
 *
 * It lists the merchants there are and their keys, disables a key and takes a
 * listing name away; it makes no merchant and issues no key, since a merchant
 * comes into being only through the link mailed to a person and the cabinet's
 * one control (ADR-0014). Against the local stack it is one line, run on the
 * gateway that is already up:
 *
 *   docker compose exec gateway \
 *     pnpm --filter @agentify/gateway merchant list
 *
 * Outside Docker it needs the same DATABASE_URL the gateway itself is given,
 * and nothing else — no key of any kind, because nothing here goes over the
 * API:
 *
 *   DATABASE_URL=postgres://agentify:agentify@localhost:5432/agentify \
 *     pnpm --filter @agentify/gateway merchant list
 *
 * What this file does is only the wiring. The commands are in
 * `merchant-command.ts`, where they are tested without a database.
 */

import { connect, PostgresStore } from "./adapters/postgres/store.js";
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
    new PostgresStore(db, randomIds),
    systemClock,
    (line) => {
      console.log(line);
    },
  );
} catch (thrown) {
  // The tables are not there. Said as its own thing, because the database's own
  // sentence names a table nobody has heard of and does not say what to run.
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

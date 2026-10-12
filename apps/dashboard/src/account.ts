/**
 * The account command wired to the database. It creates no account: an account
 * is made when its person opens the sign-in link mailed to them. Locally:
 *
 *   docker compose exec app \
 *     pnpm --filter @agentify/dashboard account list
 */

import { runAccount } from "./account-command.js";
import { loadConfig } from "./config.js";
import { connect } from "./database.js";
import { identityFor } from "./identity.js";

// The whole configuration, not only the database address: the identity
// component needs the same secret and public address as the dashboard process.
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (thrown) {
  console.error(thrown instanceof Error ? thrown.message : String(thrown));
  process.exit(1);
}

const identity = identityFor(config, { pool: connect(config.databaseUrl) });
let code = 1;
try {
  code = await runAccount(process.argv.slice(2), identity, {
    say: (line) => {
      console.log(line);
    },
  });
} catch (thrown) {
  // An unmigrated database is recognised inside `runAccount`, not here, because
  // the store's error and the driver's are different objects.
  console.error(thrown);
} finally {
  await identity.close();
}

// `exitCode`, not `exit`: stdout is asynchronous when it is a pipe, as under
// `docker compose exec`, and `exit` does not wait for it.
process.exitCode = code;

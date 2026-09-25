/**
 * The account command, wired to the database.
 *
 * It lists the accounts there are, ends a person's sessions and moves the
 * operator flag; it makes no account, since an account is made when its person
 * opens the link the cabinet mails to their address (ADR-0026 §1). In the
 * local stack it is one line, run against the cabinet that is already up:
 *
 *   docker compose exec cabinet \
 *     pnpm --filter @agentify/cabinet account list
 *
 * Outside Docker it needs the same configuration the cabinet itself is given,
 * because the identity component reads the same secret and public address.
 *
 * What the file itself does is only the wiring. The commands are in
 * `account-command.ts`, where they are tested without a database.
 */

import { runAccount } from "./account-command.js";
import { loadConfig } from "./config.js";
import { connect } from "./database.js";
import { identityFor } from "./identity.js";

// The whole configuration, not the database address alone. The identity
// component needs the same secret and public address as the cabinet process.
// Reading them here produces the same refusal, in the same words, before
// anything is written.
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
  // Whatever the command did not have a better sentence for. The one failure
  // that has a better sentence — a database the migrations have never been run
  // against — is answered inside `runAccount`, where it is tested; putting the
  // recognition here is what made it unreachable, because the store's own error
  // and the driver's are not the same object.
  console.error(thrown);
} finally {
  await identity.close();
}

// `process.exitCode` and not `process.exit`, because Node's own documentation
// says writes to stdout are asynchronous when it is a pipe — which is what it
// is under `docker compose exec` — and `process.exit` does not wait for them.
process.exitCode = code;

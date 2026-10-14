/**
 * The operator's payout command, wired to the database. Run on the gateway
 * that is already up:
 *
 *   docker compose exec app pnpm --filter @agentify/gateway payout
 */

import { openReadingApplication } from "./command-application.js";
import { loadConfig } from "./config.js";
import { runPayout } from "./payout-command.js";

const NO_SUCH_TABLE = "42P01";

const config = loadConfig(process.env);
let opened: ReturnType<typeof openReadingApplication> | undefined;

let code = 1;
try {
  opened = openReadingApplication(config);
  code = await runPayout(process.argv.slice(2), opened.application, (line) => {
    console.log(line);
  });
} catch (thrown) {
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
    console.error("No payout was printed: the command did not finish.");
    console.error(thrown);
  }
} finally {
  await opened?.close();
}

process.exitCode = code;

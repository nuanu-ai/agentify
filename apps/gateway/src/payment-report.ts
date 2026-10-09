/**
 * The payment-report command, wired to the database.
 *
 * Run on the gateway that is already up, the same way the merchant command is:
 *
 *   docker compose exec app \
 *     pnpm --filter @agentify/gateway report-payment <order>
 *
 * It writes through the order machine. It does not start the reminder worker:
 * a second consumer on that queue would take deadlines away from the gateway
 * that applies them. And it does not ask the facilitator. The fact it records
 * was read somewhere else; asking again is the thing this command exists
 * because we cannot do.
 */

import { openCommandApplication } from "./command-application.js";
import { loadConfig } from "./config.js";
import { runPaymentReport } from "./payment-report-command.js";

const NO_SUCH_TABLE = "42P01";

const config = loadConfig(process.env);
let opened: Awaited<ReturnType<typeof openCommandApplication>> | undefined;

let code = 1;
try {
  opened = await openCommandApplication(config);
  const gateway = opened.application;
  code = await runPaymentReport(
    process.argv.slice(2),
    {
      read: (orderId) => gateway.runtime.store.orderById(orderId),
      record: (orderId, event, facts) => gateway.runner.apply(orderId, event, facts),
      now: () => gateway.runtime.clock(),
    },
    (line) => {
      console.log(line);
    },
  );
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
    console.error(
      "The outcome of this command is unknown because it did not finish. Run it again with only the order identifier to see what was recorded.",
    );
    console.error(thrown);
  }
} finally {
  await opened?.close();
}

process.exitCode = code;

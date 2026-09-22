/**
 * The payment-report command, wired to the database.
 *
 * Run on the gateway that is already up, the same way the merchant command is:
 *
 *   docker compose exec gateway \
 *     pnpm --filter @agentify/commerce-gateway report-payment <order>
 *
 * It writes through the order machine. It does not start the reminder worker:
 * a second consumer on that queue would take deadlines away from the gateway
 * that applies them. And it does not ask the facilitator. The fact it records
 * was read somewhere else; asking again is the thing this command exists
 * because we cannot do.
 */

import { queueOn } from "./adapters/pgboss/queue.js";
import { connect, PostgresStore } from "./adapters/postgres/store.js";
import { Gateway } from "./app/gateway.js";
import { loadConfig } from "./config.js";
import { runPaymentReport } from "./payment-report-command.js";
import { randomIds, systemClock } from "./ports/clock.js";
import type { Facilitator } from "./ports/facilitator.js";

const NO_SUCH_TABLE = "42P01";

const refusesToAsk: Facilitator = {
  verify() {
    return Promise.reject(new Error("report-payment does not ask the facilitator"));
  },
  settle() {
    return Promise.reject(new Error("report-payment does not ask the facilitator"));
  },
};

const config = loadConfig(process.env);
const { db, pool } = connect(config.databaseUrl);
const queue = queueOn(config.databaseUrl, {
  pollIntervalMs: 250,
  reminders: {
    attempts: config.reminderAttempts,
    retryDelayMs: config.reminderRetryDelayMs,
  },
});

let code = 1;
try {
  await queue.startWriter();
  const gateway = new Gateway({
    config,
    store: new PostgresStore(db, randomIds, queue.envelopes()),
    queue,
    facilitator: refusesToAsk,
    clock: systemClock,
    ids: randomIds,
  });
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
        " Run: pnpm --filter @agentify/commerce-gateway db:migrate",
    );
  } else {
    console.error(
      "The outcome of this command is unknown because it did not finish. Run it again with only the order identifier to see what was recorded.",
    );
    console.error(thrown);
  }
} finally {
  await queue.stop().catch(() => undefined);
  await pool.end();
}

process.exitCode = code;

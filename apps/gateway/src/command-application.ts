/**
 * The gateway's application for a command run beside a gateway that is already
 * up, such as `report-payment`. Its queue writes and does not consume, because
 * a second consumer on the reminders queue would take deadlines away from the
 * gateway that applies them. It never asks the facilitator, since a command
 * records what was learned elsewhere, and it announces nothing.
 */

import { queueOn } from "./adapters/pgboss/queue.js";
import { connect, PostgresStore } from "./adapters/postgres/store.js";
import { Gateway } from "./app/gateway.js";
import type { GatewayConfig } from "./config.js";
import { nobodyAnnounces } from "./ports/announcer.js";
import { randomIds, systemClock } from "./ports/clock.js";
import type { Facilitator } from "./ports/facilitator.js";

const refusesToAsk: Facilitator = {
  verify() {
    return Promise.reject(new Error("a command does not ask the facilitator"));
  },
  settle() {
    return Promise.reject(new Error("a command does not ask the facilitator"));
  },
};

export interface CommandApplication {
  readonly application: Gateway;
  close(): Promise<void>;
}

export async function openCommandApplication(config: GatewayConfig): Promise<CommandApplication> {
  const { db, pool } = connect(config.databaseUrl);
  const queue = queueOn(config.databaseUrl, {
    pollIntervalMs: 250,
    reminders: {
      attempts: config.reminderAttempts,
      retryDelayMs: config.reminderRetryDelayMs,
    },
  });
  const close = async (): Promise<void> => {
    await queue.stop().catch(() => undefined);
    await pool.end();
  };
  try {
    await queue.startWriter();
  } catch (thrown) {
    await close();
    throw thrown;
  }
  const application = new Gateway({
    config,
    store: PostgresStore.over(db, config.payment.network, randomIds, queue.envelopes()),
    queue,
    facilitator: refusesToAsk,
    clock: systemClock,
    ids: randomIds,
    announcer: nobodyAnnounces,
  });
  return { application, close };
}

/**
 * The gateway's application, built for a command run beside the gateway that
 * is already up: `report-payment`, and the dashboard's `woo:recover`, which
 * delivers late goods for one order (ADR-0030).
 *
 * It is the same store on the same database, and a queue that writes and does
 * not consume: a second consumer on the reminders queue would take deadlines
 * away from the gateway that applies them. It asks no payment layer, because a
 * command records or delivers what was learned somewhere else, and asking again
 * is the thing these commands exist because we cannot do. And it announces
 * nothing, since nothing a command does changes a wallet or issues a key.
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

/** The application, and what lets go of its connections when the command is done. */
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
    store: PostgresStore.over(db, randomIds, queue.envelopes()),
    queue,
    facilitator: refusesToAsk,
    clock: systemClock,
    ids: randomIds,
    announcer: nobodyAnnounces,
  });
  return { application, close };
}

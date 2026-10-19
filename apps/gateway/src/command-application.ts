/**
 * The gateway's application for a command run beside a gateway that is already
 * up, such as WooCommerce recovery. Its queue writes and does not consume, because
 * a second consumer on the reminders queue would take deadlines away from the
 * gateway that applies them. It never asks the facilitator or announces a
 * payout change. A command that
 * only reads, such as `payout`, opens one with no queue at all.
 */

import { queueOn } from "./adapters/pgboss/queue.js";
import { connect, PostgresStore } from "./adapters/postgres/store.js";
import { Gateway } from "./app/gateway.js";
import type { GatewayConfig } from "./config.js";
import { widestChallengeOn } from "./http/x402.js";
import { nobodyAnnounces } from "./ports/announcer.js";
import { randomIds, systemClock } from "./ports/clock.js";
import type { Facilitator } from "./ports/facilitator.js";
import type { Queue } from "./ports/queue.js";

const refusesToAsk: Facilitator = {
  verify() {
    return Promise.reject(new Error("a command does not ask the facilitator"));
  },
  settle() {
    return Promise.reject(new Error("a command does not ask the facilitator"));
  },
};

const ONLY_READS = "a command that only reads puts nothing on a queue and takes nothing off one";

/** Refuses every call out loud rather than dropping a merchant's work. */
const noQueue: Queue = {
  publish: () => Promise.reject(new Error(ONLY_READS)),
  draw: () => Promise.reject(new Error(ONLY_READS)),
  finish: () => Promise.reject(new Error(ONLY_READS)),
  holdsOrder: () => Promise.reject(new Error(ONLY_READS)),
  remind: () => Promise.reject(new Error(ONLY_READS)),
  onReminder: () => {
    throw new Error(ONLY_READS);
  },
  everyDay: () => Promise.reject(new Error(ONLY_READS)),
  everyMinute: () => Promise.reject(new Error(ONLY_READS)),
  start: () => Promise.reject(new Error(ONLY_READS)),
  stop: () => Promise.resolve(),
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
    widestChallenge: widestChallengeOn(config),
  });
  return { application, close };
}

/**
 * The application for a command that only reads. pg-boss is never started, so
 * its maintenance and schedules write nothing, and the store connects at its
 * first query.
 */
export function openReadingApplication(config: GatewayConfig): CommandApplication {
  const { db, pool } = connect(config.databaseUrl);
  const application = new Gateway({
    config,
    store: PostgresStore.over(db, config.payment.network, randomIds),
    queue: noQueue,
    facilitator: refusesToAsk,
    clock: systemClock,
    ids: randomIds,
    announcer: nobodyAnnounces,
    widestChallenge: widestChallengeOn(config),
  });
  return { application, close: () => pool.end() };
}

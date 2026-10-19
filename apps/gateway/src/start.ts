/**
 * Starts the gateway inside a resident process, which it needs because it
 * holds things open across HTTP calls: parked worker polls, parked synchronous
 * purchases, a queue consumer and a payment sequence that spans two calls. The
 * process, its signals and the order things stop in belong to `apps/app`,
 * which starts the dashboard beside this.
 */

import { ScriptedFacilitator } from "./adapters/memory/facilitator.js";
import { queueOn } from "./adapters/pgboss/queue.js";
import { connect, PostgresStore } from "./adapters/postgres/store.js";
import { facilitatorClientFor, refuseUnlessCoinbaseTakesTheKey } from "./adapters/x402/client.js";
import { X402Facilitator } from "./adapters/x402/facilitator.js";
import { Gateway } from "./app/gateway.js";
import { seedSandboxKey } from "./app/merchants.js";
import { RefusedToStart } from "./app/recorded-splits.js";
import type { Runtime } from "./app/runtime.js";
import { type GatewayConfig, isSandboxFacilitator, secondAttemptProblem } from "./config.js";
import { buildApp } from "./http/server.js";
import { PaymentEdge, widestChallengeOn } from "./http/x402.js";
import type { Announcer } from "./ports/announcer.js";
import { randomIds, systemClock } from "./ports/clock.js";
import type { Facilitator } from "./ports/facilitator.js";
import { REMINDER_POLL_MS } from "./ports/queue.js";

/**
 * Fixed rather than read from `PORT`: the dashboard shares this process's
 * environment, so a `PORT` there could mean only one of them.
 */
const GATEWAY_PORT = 3000;

/**
 * Work published by this process wakes a parked poll at once, so this interval
 * only bounds the lag for work published by another process.
 */
const QUEUE_POLL_INTERVAL_MS = 250;

/**
 * The credentials are made to sign once before this returns, and on Coinbase's
 * facilitator shown to Coinbase once; the process stops if they cannot sign or
 * Coinbase refuses them. A Coinbase that does not answer stops nothing: the
 * gateway starts, and its log says the key is unconfirmed.
 */
async function paymentLayer(config: GatewayConfig, edge: PaymentEdge): Promise<Facilitator> {
  if (isSandboxFacilitator(config.payment.facilitatorUrl)) {
    return new ScriptedFacilitator();
  }

  const client = facilitatorClientFor(config.payment);
  const unconfirmed = await refuseUnlessCoinbaseTakesTheKey(client, fetch);
  if (unconfirmed !== null) {
    console.warn(`[gateway] ${unconfirmed}`);
  }
  return new X402Facilitator(client, edge);
}

/**
 * The first line of the log, which tells an operator whether this process
 * settles real money, test funds or nothing at all.
 */
function announceTheEnvironment(config: GatewayConfig): void {
  const { network, facilitatorUrl } = config.payment;
  const where = `${network} through ${facilitatorUrl}`;

  switch (config.surfaceMode) {
    case "sandbox":
      console.warn(
        `[gateway] SANDBOX on ${where}: no chain stands behind this process — every payment it ` +
          "accepts is pretend, nothing arrives at the address in a challenge, and no receipt it " +
          "writes points at a transfer",
      );
      return;
    case "test":
      console.warn(
        `[gateway] TEST environment on ${where}: payments settle with test funds, every order and ` +
          "receipt is marked as a test, and every key issued here begins with csk_test_",
      );
      return;
    case "live":
      console.log(
        `[gateway] LIVE on ${where}: the money is real, nothing is marked as a test, and every key ` +
          "issued here begins with csk_live_",
      );
      return;
    default: {
      const unannounced: never = config.surfaceMode;
      throw new Error(`this gateway has no words for ${String(unannounced)}`);
    }
  }
}

/**
 * Puts the sandbox's key in the database if it is not there, so
 * `docker compose up` sells with no manual step; a restart or a second replica
 * writes nothing, and a key somebody disabled stays disabled. Every outcome is
 * logged, including the two that write nothing, because silence would read
 * the same whether the key was taken, was already there or was never set.
 */
async function seedTheSandbox(config: GatewayConfig, runtime: Runtime): Promise<void> {
  const secret = config.sandboxMerchantKey;
  const surface = config.surfaceMode.toUpperCase();
  if (secret === null) {
    console.log(
      `[gateway] ${surface}: SANDBOX_MERCHANT_KEY is not set — a name with nothing after it reads the same as no ` +
        "name at all — so no key was seeded, and every key that opens a merchant here is one somebody issued",
    );
    return;
  }

  const seeded = await seedSandboxKey(
    runtime.store,
    runtime.ids,
    secret,
    runtime.clock(),
    config.surfaceMode,
  );
  if (seeded.kind === "issued") {
    console.warn(
      `[gateway] ${surface}: the key in SANDBOX_MERCHANT_KEY now opens ${seeded.merchantId} — ` +
        "its value also remains in this stack's configuration, which is why only the laptop's stack seeds one" +
        (seeded.listedAs === null
          ? ""
          : `. It had no listing name, so this start listed it as "${seeded.listedAs}" — the seller a ` +
            `catalogue reads out of its cards; \`merchant listed-as ${seeded.merchantId} --none\` takes ` +
            "that away, and no start that finds this key already there puts it back"),
    );
    return;
  }
  if (seeded.kind === "already_there") {
    console.warn(
      `[gateway] ${surface}: the key in SANDBOX_MERCHANT_KEY was already in the database and still opens ` +
        "the seeded merchant; this start issued no key",
    );
    return;
  }
  if (seeded.kind === "disabled") {
    console.warn(
      `[gateway] ${surface}: the key in SANDBOX_MERCHANT_KEY exists and somebody disabled it; it is left disabled, ` +
        "and nothing presenting it will get in",
    );
  }
}

/**
 * The database as a log line names it: its host and name. A password may hold
 * a colon, and an address may carry it again in its query, so nothing else of
 * the address is printed.
 */
function databaseNamed(databaseUrl: string): string {
  if (!URL.canParse(databaseUrl)) {
    return "the database DATABASE_URL names";
  }
  const { host, pathname } = new URL(databaseUrl);
  return `${host}${pathname}`;
}

export interface RunningGateway {
  /**
   * The application the surface is mounted on, which the dashboard calls inside
   * the same process.
   */
  readonly application: Gateway;
  /** Takes no new connection on the gateway's port; the parked ones stay until `stop`. */
  closeListener(): void;
  /**
   * Parked workers and parked purchases are woken with nothing rather than
   * left waiting, so an agent retries across a restart instead of timing out;
   * then the store's connections close.
   */
  stop(): Promise<void>;
}

/**
 * Starts the order machine and the surface, or throws saying why it could not.
 * `announcer` is the dashboard's way of telling a merchant of a change to their
 * wallet or their keys.
 */
export async function startGateway(
  config: GatewayConfig,
  announcer: Announcer,
): Promise<RunningGateway> {
  // The Postgres queue notices a due reminder up to half a second late, and a
  // synchronous sale must still have room for a second attempt.
  const cramped = secondAttemptProblem(config, REMINDER_POLL_MS);
  if (cramped !== null) {
    throw new Error(`the gateway will not start: ${cramped}`);
  }
  const { db, pool } = connect(config.databaseUrl);
  const edge = new PaymentEdge(config.payment, config.publicBaseUrl, config.payment.timeoutSeconds);
  const queue = queueOn(config.databaseUrl, {
    pollIntervalMs: QUEUE_POLL_INTERVAL_MS,
    reminders: {
      attempts: config.reminderAttempts,
      retryDelayMs: config.reminderRetryDelayMs,
    },
  });

  announceTheEnvironment(config);

  const runtime: Runtime = {
    config,
    // An envelope that must not be lost is written in the same transaction as
    // its order, so a process that dies mid-flight did both or neither. This
    // works only because the queue and the store share one Postgres.
    store: PostgresStore.over(db, config.payment.network, randomIds, queue.envelopes()),
    queue,
    facilitator: await paymentLayer(config, edge),
    clock: systemClock,
    ids: randomIds,
    // The gateway announces only on the live deployment; elsewhere a change
    // applies at once and nobody is told.
    announcer,
    widestChallenge: widestChallengeOn(config),
  };

  const gateway = new Gateway(runtime);

  try {
    await gateway.start();
    await seedTheSandbox(config, runtime);
  } catch (thrown) {
    if (thrown instanceof RefusedToStart) {
      console.error(`[gateway] cannot start: ${thrown.message}`);
    } else {
      // Names the database that did not answer, which a stack trace from the
      // queue's internals does not.
      console.error(
        `[gateway] cannot start: the queue and the store both live in ${databaseNamed(config.databaseUrl)}, and it did not answer`,
      );
    }
    await pool.end().catch(() => undefined);
    throw thrown;
  }

  const server = buildApp(gateway).listen(GATEWAY_PORT, () => {
    console.log(`[gateway] listening on ${GATEWAY_PORT}, answering as ${config.publicBaseUrl}`);
  });

  return {
    application: gateway,
    closeListener() {
      server.close();
    },
    async stop() {
      await gateway.stop();
      await pool.end();
    },
  };
}

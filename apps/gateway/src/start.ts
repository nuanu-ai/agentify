/**
 * Starting the gateway, inside the resident process (ADR-0030).
 *
 * It is resident rather than serverless because of what it holds open: workers
 * parked on a poll, an agent parked on a synchronous purchase, a consumer of
 * the queue, and a sequence around a payment that has to survive between two
 * HTTP calls. A function that runs and exits could hold none of them. The
 * process itself, its signals and the order things stop in belong to
 * `apps/app`, which starts the dashboard beside this.
 *
 * Everything below is wiring. The configuration is read once and refused whole
 * before this is called, the three ports are given their real
 * implementations, and the surface is mounted from the contract's own table.
 * There is no logic here to test, because everything that could be got wrong
 * lives behind one of those three ports and is tested against the in-memory
 * ones.
 */

import { ScriptedFacilitator } from "./adapters/memory/facilitator.js";
import { queueOn } from "./adapters/pgboss/queue.js";
import { connect, PostgresStore } from "./adapters/postgres/store.js";
import { facilitatorClientFor, refuseUnlessCredentialsSign } from "./adapters/x402/client.js";
import { X402Facilitator } from "./adapters/x402/facilitator.js";
import { Gateway } from "./app/gateway.js";
import { seedSandboxKey } from "./app/merchants.js";
import type { Runtime } from "./app/runtime.js";
import { type GatewayConfig, isSandboxFacilitator } from "./config.js";
import { buildApp } from "./http/server.js";
import { PaymentEdge } from "./http/x402.js";
import type { Announcer } from "./ports/announcer.js";
import { randomIds, systemClock } from "./ports/clock.js";
import type { Facilitator } from "./ports/facilitator.js";

/**
 * The port the gateway's surface answers on: `/v0`, `/x402` and `/healthz`.
 * Fixed, like the dashboard's three, because the dashboard shares this
 * process's environment and a `PORT` there could mean only one of them.
 */
export const GATEWAY_PORT = 3000;

/**
 * How long a poll leans on the queue's own polling before coming back empty on
 * this turn. Work published by this process wakes a parked poll with no lag at
 * all, so this only carries work published by another one.
 */
const QUEUE_POLL_INTERVAL_MS = 250;

/**
 * The payment layer, real or none at all (ADR-0008).
 *
 * The sandbox is a value of the facilitator's address rather than a flag beside
 * it, so this is a fork between two addresses and not between two modes. A
 * gateway told to talk to a facilitator talks to it; a gateway told
 * `sandbox:scripted` verifies and settles against nothing, and says so at the
 * top of its log rather than leaving it to be inferred from a quiet purchase
 * that worked with no wallet.
 *
 * Which client a real address gets, and what it authenticates with, is decided
 * in `adapters/x402/client.ts` rather than here, and that is not tidying. This
 * file is wiring and has no tests, on the stated grounds that everything which
 * could be got wrong lives behind a port — and the choice of credentials is
 * something that can be got wrong: it was, silently, and the version before
 * this one sent Coinbase a pair of headers that facilitator has never read.
 * Nothing here failed, because nothing here is exercised until a real payment
 * meets a real facilitator.
 *
 * The credentials are made to sign once before this returns, and the process
 * stops if they cannot. It asks nobody anything — a token is arithmetic over
 * the key — so an unreachable facilitator cannot stop the gateway starting,
 * which is the failure the spike's server had.
 */
async function paymentLayer(config: GatewayConfig, edge: PaymentEdge): Promise<Facilitator> {
  if (isSandboxFacilitator(config.payment.facilitatorUrl)) {
    return new ScriptedFacilitator();
  }

  const client = facilitatorClientFor(config.payment);
  await refuseUnlessCredentialsSign(client);
  return new X402Facilitator(client, edge);
}

/**
 * The first line of the log, and what an operator reads to know which of the
 * three things this process is.
 *
 * It used to announce only the sandbox, because there was only one other
 * thing to be. There are three now, and the difference between "settles with
 * test funds" and "settles against nothing" is one somebody acts on.
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
 * The sandbox's one key, put in the database if it is not there already.
 *
 * It is what makes `docker compose up` sell with no manual step: the same
 * string is given to the merchant process in that file, and without a row to
 * match it the door would turn that process away. Writing it
 * is idempotent — the key is looked up by its digest first — so a restart and a
 * second replica both write nothing.
 *
 * It is a seed and not a door. Nothing compares a request against this value;
 * once the row is there the key is read like every other key, and disabling it
 * at a terminal keeps it disabled through a restart, which is the point of
 * saying so out loud rather than quietly re-issuing it.
 *
 * This runs before the migrations in any deployment that has them, in the sense
 * that matters: the migration is a separate step that has already finished, and
 * it is what wrote the merchant row and gave every existing card, order and
 * receipt an owner. All this does is hang a key on it — and, on the one start
 * that hangs the first key, list that merchant under a name a catalogue can
 * read, because a database brought up from nothing has nobody to run the
 * command that would.
 *
 * Every way this can go says which one it was, including the two that write
 * nothing. `compose.yaml` tells an operator to close the sandbox by handing the
 * process the name with nothing after it, and promises the log will say which
 * of the two it did — so silence is the one answer that cannot be given: it
 * reads the same whether the key was taken and honoured, was already there, or
 * was never configured at all.
 *
 * It is the laptop's stack that seeds. A deployed channel hands this process
 * nothing to seed, and its release refuses one that would (ADR-0014): a
 * merchant there comes into being only through the link mailed to a person
 * and the dashboard's one control.
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

/** The gateway, started, with what the process stops it by. */
export interface RunningGateway {
  /**
   * The application the surface is mounted on, which the dashboard calls
   * inside the same process (ADR-0030).
   */
  readonly application: Gateway;
  /** Takes no new connection on the gateway's port; the parked ones stay until `stop`. */
  closeListener(): void;
  /**
   * Lets go of what it is holding. Parked workers and parked purchases are
   * woken with nothing rather than left waiting on a process that is going
   * away, which is the difference between a restart an agent retries and one
   * it times out on; then the store's connections close.
   */
  stop(): Promise<void>;
}

/**
 * Starts the order machine and the surface, or throws saying why it could not.
 * `announcer` is how a merchant is told of a change to their wallet or their
 * keys: the dashboard's way of telling, which the process hands over (ADR-0030).
 */
export async function startGateway(
  config: GatewayConfig,
  announcer: Announcer,
): Promise<RunningGateway> {
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
    // The store is given the queue's way of writing an envelope inside its own
    // transaction: an envelope that must not be lost is written where the order
    // is, so a process that dies mid-flight either did both or did neither
    // (ADR-0013). Both live in the same Postgres, which is what makes it possible.
    store: PostgresStore.over(db, randomIds, queue.envelopes()),
    queue,
    facilitator: await paymentLayer(config, edge),
    clock: systemClock,
    ids: randomIds,
    // The dashboard's telling. The gateway itself decides to announce only on
    // the live deployment; elsewhere a change applies at once and nobody is
    // told (ADR-0019).
    announcer,
  };

  const gateway = new Gateway(runtime);

  try {
    await gateway.start();
    await seedTheSandbox(config, runtime);
  } catch (thrown) {
    // The first thing an engineer bringing this up sees. A stack trace out of the
    // queue's own internals says "something about Postgres" and makes them go
    // looking; this says which database was not there.
    console.error(
      `[gateway] cannot start: the queue and the store both live in ${config.databaseUrl.replace(/:[^:@/]*@/, ":***@")}, and it did not answer`,
    );
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

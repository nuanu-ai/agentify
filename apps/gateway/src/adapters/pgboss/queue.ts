/**
 * The queue, on pg-boss, in the same Postgres as everything else. All the
 * durable machinery is the library's.
 *
 * A parked poll is woken in-process the moment this process publishes, so an
 * agent waiting on a purchase sees no polling lag. Work published by another
 * process reaches a poll only through the loop in `draw` calling `fetch`
 * again. pg-boss's own retries are off for envelopes: whether an unanswered
 * delivery is repeated is the order machine's decision alone.
 */

import type { WorkerEnvelope } from "@nuanu-ai/agentify-contracts";
import { sql } from "drizzle-orm";
import {
  type DrizzleTransactionLike,
  fromDrizzle,
  type Job,
  type JobResult,
  PgBoss,
} from "pg-boss";
import {
  type DrawnEnvelope,
  type Queue,
  REMINDER_POLL_MS,
  type Reminder,
  type ReminderPatience,
} from "../../ports/queue.js";
import { failingWithoutValues, withoutValues } from "../database-failure.js";
import type { Envelopes } from "../postgres/store.js";

/**
 * What pg-boss will take as a queue name, copied from the library's own rule;
 * a database test checks it still agrees. It is checked here because a merchant
 * identifier pg-boss refused would otherwise surface only at that merchant's
 * first sale, as orders reaching nobody.
 */
export const A_NAME_PG_BOSS_ACCEPTS = /^[\w.\-/]+$/;

/** The prefix each merchant's stream is named under, and the reminders queue. */
export const ENVELOPES = "agentify_envelopes";
export const REMINDERS = "agentify_reminders";

/** How often reminders are looked for, in seconds: pg-boss's floor. */
const REMINDER_POLL_SECONDS = REMINDER_POLL_MS / 1_000;

const REMINDER_BATCH = 20;

/**
 * One merchant's stream, a pg-boss queue of its own. pg-boss fetches only by
 * queue name, so a shared queue would mean drawing a stranger's envelope to
 * look at it, and a drawn envelope is never offered again. With partitioning
 * off (the default) a queue costs one row. Jobs under any other name are never
 * read.
 */
export const streamOf = (merchantId: string): string => {
  if (!A_NAME_PG_BOSS_ACCEPTS.test(merchantId)) {
    throw new Error(
      `the merchant ${JSON.stringify(merchantId)} cannot name a queue: pg-boss holds a name to alphanumerics, underscores, hyphens, periods and forward slashes`,
    );
  }
  return `${ENVELOPES}_${merchantId}`;
};

export interface PgBossQueueOptions {
  /**
   * How long a parked poll waits before fetching again. It matters only for
   * work published by another process; this process wakes a poll at once.
   */
  readonly pollIntervalMs: number;
  readonly reminders: ReminderPatience;
}

export class PgBossQueue implements Queue {
  readonly #boss: PgBoss;
  readonly #options: PgBossQueueOptions;
  readonly #waiters = new Map<string, Set<() => void>>();
  /**
   * The streams this process has already asked pg-boss to make. Asking twice is
   * harmless but costs a round trip per publish.
   */
  readonly #made = new Set<string>();
  #fire: ((reminder: Reminder) => Promise<void>) | null = null;
  #running = false;

  /**
   * The only way to make a queue: database failures leave it stripped of the
   * values bound to the statement (`database-failure.ts`), which for a job is
   * the envelope it carries. Envelopes written inside an order's transaction
   * are stripped by the store instead.
   *
   * pg-boss's `error` event is handled here for the same reason, and because
   * an unhandled one kills the process, and with it every parked purchase and
   * worker.
   */
  static over(boss: PgBoss, options: PgBossQueueOptions): PgBossQueue {
    boss.on("error", (error: unknown) => {
      console.error(
        "[gateway] the queue reported a failure",
        withoutValues(error, "the queue's own upkeep"),
      );
    });
    return failingWithoutValues(new PgBossQueue(boss, options), "the queue");
  }

  private constructor(boss: PgBoss, options: PgBossQueueOptions) {
    this.#boss = boss;
    this.#options = options;
  }

  async publish(merchantId: string, envelope: WorkerEnvelope, afterMs?: number): Promise<void> {
    const stream = await this.#stream(merchantId);
    const sent = await this.#boss.send(stream, envelope as unknown as object, {
      // Retries are the order machine's to decide, so the queue keeps none.
      retryLimit: 0,
      ...(afterMs === undefined || afterMs <= 0
        ? {}
        : { startAfter: new Date(Date.now() + afterMs) }),
    });

    // Null means no job was made: an order that would silently reach nobody.
    if (sent === null) {
      throw new Error(`the queue would not take the envelope ${envelope.id}`);
    }

    if (afterMs === undefined || afterMs <= 0) {
      this.#wakeEverybody(stream);
    }
  }

  /**
   * The same publish, inside the caller's transaction, so the job commits or
   * rolls back with the order. Nothing sees it until the commit, so parked
   * polls are woken by `envelopesCommitted`, not here.
   *
   * Making the stream is deliberately outside the transaction. pg-boss takes
   * one advisory lock for every queue creation, so two merchants making their
   * first stream at once wait for each other while each holds an order row;
   * it is short, and happens once per merchant per process.
   */
  async publishWithin(
    tx: DrizzleTransactionLike,
    merchantId: string,
    envelope: WorkerEnvelope,
    afterMs?: number,
  ): Promise<void> {
    const stream = await this.#stream(merchantId);
    const sent = await this.#boss.send(stream, envelope as unknown as object, {
      retryLimit: 0,
      ...(afterMs === undefined || afterMs <= 0
        ? {}
        : { startAfter: new Date(Date.now() + afterMs) }),
      db: fromDrizzle(tx, sql),
    });

    // The throw rolls back the order with it: an order saying the merchant was
    // handed the work is never written unless the work was enqueued.
    if (sent === null) {
      throw new Error(`the queue would not take the envelope ${envelope.id}`);
    }
  }

  /**
   * Deletes, inside the caller's transaction, every job on the stream that
   * carries a parcel's address: the order's hand-overs and the named price
   * question, in any state. Finished jobs count, because pg-boss keeps them
   * for days. They are gone exactly when the erasure commits. Finishing a
   * deleted job later does nothing.
   */
  async forgetWithin(
    tx: DrizzleTransactionLike,
    merchantId: string,
    orderId: string,
    priceQuestion: string | null,
  ): Promise<void> {
    const stream = await this.#stream(merchantId);
    const db = fromDrizzle(tx, sql);
    const carrying = [
      ...(await this.#boss.findJobs(stream, {
        data: { kind: "order", payload: { id: orderId } },
        db,
      })),
      ...(priceQuestion === null
        ? []
        : await this.#boss.findJobs(stream, {
            data: { kind: "quote_request", payload: { price_id: priceQuestion } },
            db,
          })),
    ];
    if (carrying.length > 0) {
      await this.#boss.deleteJob(
        stream,
        carrying.map((job) => job.id),
        { db },
      );
    }
  }

  /**
   * Wakes the polls parked on these streams once the transaction has
   * committed. Woken earlier they would find nothing and go back to waiting a
   * full interval.
   */
  envelopesCommitted(merchantIds: readonly string[]): void {
    for (const merchantId of new Set(merchantIds)) {
      this.#wakeEverybody(streamOf(merchantId));
    }
  }

  envelopes(): Envelopes {
    return {
      within: (tx, merchantId, envelope, afterMs) =>
        this.publishWithin(tx, merchantId, envelope, afterMs),
      forgetWithin: (tx, merchantId, orderId, priceQuestion) =>
        this.forgetWithin(tx, merchantId, orderId, priceQuestion),
      committed: (merchantIds) => {
        this.envelopesCommitted(merchantIds);
      },
    };
  }

  async draw(
    merchantId: string,
    max: number,
    waitMs: number,
    gone?: AbortSignal,
  ): Promise<readonly DrawnEnvelope[]> {
    const stream = await this.#stream(merchantId);
    if (gone?.aborted) {
      return [];
    }
    const first = await this.#take(stream, max);
    if (first.length > 0 || waitMs <= 0) {
      return first;
    }

    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await this.#park(stream, Math.min(this.#options.pollIntervalMs, until - Date.now()), gone);
      // A worker that left takes nothing; what arrives stays for the next poll.
      if (gone?.aborted) {
        return [];
      }
      const drawn = await this.#take(stream, max);
      if (drawn.length > 0) {
        return drawn;
      }
    }
    return [];
  }

  async holdsOrder(merchantId: string, orderId: string): Promise<boolean> {
    const stream = await this.#stream(merchantId);
    // `queued` is a job not yet handed out, delayed redeliveries included. A
    // drawn job is `active` and one drawn and never answered ends `failed`;
    // neither is counted. For a `failed` job that is right, since the sweep
    // should resend. An `active` one is still in a poll's hands, and what keeps
    // the sweep off it is `sweepDispatchGraceMs`, not this answer.
    //
    // Unlike `fetch`, this does not exclude jobs waiting on dependencies. No
    // envelope is ever sent with one; if one ever were, this would answer
    // "held" for an envelope nobody will be handed, and the sweep would leave
    // that order alone for good.
    const held = await this.#boss.findJobs(stream, {
      data: { kind: "order", payload: { id: orderId } },
      queued: true,
    });
    return held.length > 0;
  }

  async finish(merchantId: string, handle: string): Promise<void> {
    // Naming the queue means a handle cannot finish another merchant's job.
    await this.#boss.complete(streamOf(merchantId), handle);
  }

  async remind(reminder: Reminder, afterMs: number): Promise<void> {
    const { attempts, retryDelayMs } = this.#options.reminders;
    const sent = await this.#boss.send(REMINDERS, reminder as unknown as object, {
      // The library's durable retries, not a handler re-arming itself against
      // the database that just refused it.
      retryLimit: Math.max(attempts - 1, 0),
      retryDelay: Math.max(Math.round(retryDelayMs / 1_000), 1),
      startAfter: new Date(Date.now() + Math.max(afterMs, 0)),
    });

    // An unwritten reminder is a deadline that never fires, and only a deadline
    // closes an overdue order.
    if (sent === null) {
      throw new Error(
        `the queue would not take the ${reminder.kind} reminder for ${reminder.orderId}`,
      );
    }
  }

  onReminder(fire: (reminder: Reminder) => Promise<void>): void {
    if (this.#running) {
      throw new Error("where reminders go is set before the queue is started, not after");
    }
    this.#fire = fire;
  }

  async everyDay(name: string, work: () => Promise<unknown>): Promise<void> {
    await this.#boss.createQueue(name);
    await this.#boss.work(name, { batchSize: 1 }, async () => {
      await work();
    });
    // Scheduling the same name again replaces the schedule.
    await this.#boss.schedule(name, "17 3 * * *");
  }

  /**
   * Starts the library so this process can send, without consuming. A second
   * process calling {@link start} would take reminders away from the gateway
   * that must apply them; the operator command that records a payment fact
   * uses this instead.
   */
  async startWriter(): Promise<void> {
    await this.#boss.start();
    await this.#boss.createQueue(REMINDERS);
  }

  async start(): Promise<void> {
    const fire = this.#fire;
    if (fire === null) {
      throw new Error("the queue has nowhere to put reminders and will not start");
    }

    await this.#boss.start();
    // Merchant streams are made on first use. Both kinds of queue run on
    // pg-boss's defaults, including the fifteen minutes a job may be held
    // before it fails; nobody has decided whether that suits reminders. Queue
    // settings are written only when a queue is first made, so options added
    // here would be silently ignored on an existing database: change them with
    // `updateQueue` or a migration.
    await this.#boss.createQueue(REMINDERS);

    // How promptly reminders are taken is how promptly a deadline closes, so
    // they are polled every half second, in batches, refetched at once while
    // a batch is full. These are worker options, so they apply on every
    // database. Each reminder is settled on its own, so one that throws does
    // not spend its neighbours' attempts.
    await this.#boss.work<Reminder>(
      REMINDERS,
      {
        batchSize: REMINDER_BATCH,
        burstWhenBatchFull: true,
        pollingIntervalSeconds: REMINDER_POLL_SECONDS,
        perJobResults: true,
      },
      async (jobs: Job<Reminder>[]): Promise<JobResult[]> => {
        const results: JobResult[] = [];
        for (const job of jobs) {
          try {
            await fire(job.data);
            results.push({ id: job.id, status: "completed" });
          } catch (error) {
            console.error(
              `[gateway] a ${job.data.kind} reminder for ${job.data.orderId} failed; it is tried again on its own while it has attempts left`,
              error,
            );
            results.push({
              id: job.id,
              status: "failed",
              output: { message: error instanceof Error ? error.message : String(error) },
            });
          }
        }
        return results;
      },
    );

    this.#running = true;
  }

  async stop(): Promise<void> {
    this.#running = false;
    for (const stream of [...this.#waiters.keys()]) {
      this.#wakeEverybody(stream);
    }
    await this.#boss.stop({ graceful: true });
  }

  async #stream(merchantId: string): Promise<string> {
    const name = streamOf(merchantId);
    if (!this.#made.has(name)) {
      await this.#boss.createQueue(name);
      this.#made.add(name);
    }
    return name;
  }

  async #take(stream: string, max: number): Promise<DrawnEnvelope[]> {
    const jobs = await this.#boss.fetch<WorkerEnvelope>(stream, {
      batchSize: Math.max(max, 1),
    });
    return jobs.map((job) => ({ envelope: job.data, handle: job.id }));
  }

  #park(stream: string, waitMs: number, gone?: AbortSignal): Promise<void> {
    const parked = this.#waiters.get(stream) ?? new Set<() => void>();
    this.#waiters.set(stream, parked);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        parked.delete(wake);
        gone?.removeEventListener("abort", wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.max(waitMs, 0));
      parked.add(wake);
      gone?.addEventListener("abort", wake, { once: true });
    });
  }

  /** Wakes the workers parked on one stream, and only them. */
  #wakeEverybody(stream: string): void {
    for (const wake of [...(this.#waiters.get(stream) ?? [])]) {
      wake();
    }
  }
}

export function queueOn(databaseUrl: string, options: PgBossQueueOptions): PgBossQueue {
  return PgBossQueue.over(new PgBoss(databaseUrl), options);
}

/**
 * The queue against a real Postgres, under `pnpm test:db`. Almost everything
 * this adapter promises is pg-boss keeping it, and none of that is visible
 * offline.
 *
 * Nothing here starts a gateway, so these tests stay out of
 * `adapters.db-test.ts`: a started gateway polls `agentify_reminders`, and
 * pg-boss would rightly hand a test's job to that worker instead of the test's
 * handler.
 */

import type { WorkerEnvelope } from "@nuanu-ai/agentify-contracts";
import { Pool } from "pg";
import { type Queue as LibraryQueueOptions, PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Reminder } from "../../ports/queue.js";
import { readyDatabase, testDatabaseUrl } from "../../testing/database.js";
import { A_NAME_PG_BOSS_ACCEPTS, ENVELOPES, PgBossQueue, REMINDERS, streamOf } from "./queue.js";

const databaseUrl = await readyDatabase(testDatabaseUrl());

/** Real time, because a queue that lives in a database keeps its own. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The merchant whose stream this suite publishes to and draws from. */
const A = "mch_a";
/** That merchant's stream, which is a pg-boss queue of its own. */
const STREAM = streamOf(A);

/**
 * One pg-boss schema per test. Queue settings are written once (`create_queue`
 * does nothing on conflict), so in a shared schema one test's one-second
 * visibility window would stay on its queue for every test after it.
 */
const SCHEMAS = [
  "pgboss_reminder_retry",
  "pgboss_reminder_bound",
  "pgboss_reminder_delay",
  "pgboss_reminder_together",
  "pgboss_reminder_neighbours",
  "pgboss_reminder_expiry",
  "pgboss_envelope_expiry",
  "pgboss_envelope_delay",
  "pgboss_envelope_left",
  "pgboss_every_day",
  "pgboss_every_minute",
  "pgboss_queue_names",
  "pgboss_queue_settings",
  "pgboss_holds_order",
  "pgboss_holds_failed",
] as const;

if (databaseUrl === null) {
  // Quiet: the adapters suite prints the instructions, and printing them twice
  // would read like two different problems.
  describe("the queue on a real database", () => {
    it.skip("is skipped: there is no Postgres to run it against", () => {
      // Intentionally empty: the skip is the message.
    });
  });
} else {
  const url = databaseUrl;

  describe("the queue on a real database", () => {
    let pool: Pool;
    const running: PgBossQueue[] = [];

    beforeAll(async () => {
      pool = new Pool({ connectionString: url });
      // Dropped rather than emptied, before anything starts: pg-boss's
      // deleteAllJobs truncates a partitioned table, which deadlocks against a
      // polling worker, and would leave queues and schedules behind.
      for (const schema of SCHEMAS) {
        await pool.query(`drop schema if exists ${schema} cascade`);
      }
    }, 60_000);

    afterAll(async () => {
      // Stopped rather than left: a boss still polling holds connections open,
      // and the next file's first act is to drop the schema underneath it.
      await Promise.all(running.map((queue) => queue.stop().catch(() => undefined)));
      // Dropped again so the database holds only the gateway's tables. The
      // drop in beforeAll stays too: a run that dies midway leaves its schemas
      // behind.
      for (const schema of SCHEMAS) {
        await pool.query(`drop schema if exists ${schema} cascade`);
      }
      await pool.end();
    });

    /**
     * A started boss on its own schema, and the adapter over it. Queues named
     * in `queues` are made first, so their settings are the ones that stand:
     * the adapter's own `createQueue` on an existing queue changes nothing.
     */
    async function labQueue(
      schema: (typeof SCHEMAS)[number],
      queues: Record<string, Omit<LibraryQueueOptions, "name">> = {},
    ): Promise<{ boss: PgBoss; queue: PgBossQueue }> {
      const boss = new PgBoss({ connectionString: url, schema });
      boss.on("error", (error: unknown) => {
        console.error(`[${schema}] the queue reported a failure`, error);
      });
      await boss.start();
      for (const [name, options] of Object.entries(queues)) {
        await boss.createQueue(name, options);
      }
      const queue = PgBossQueue.over(boss, {
        pollIntervalMs: 50,
        reminders: { attempts: 3, retryDelayMs: 1_000 },
      });
      running.push(queue);
      return { boss, queue };
    }

    it("agrees with the rule the queue names are held to", async () => {
      // Offline the adapter's name rule can only agree with itself; here
      // pg-boss answers.
      const { boss } = await labQueue("pgboss_queue_names");

      const taken = [ENVELOPES, REMINDERS, STREAM, "agentify.envelopes", "agentify-envelopes"];
      for (const name of taken) {
        expect(name, name).toMatch(A_NAME_PG_BOSS_ACCEPTS);
        await expect(boss.createQueue(name)).resolves.toBeUndefined();
      }

      const refused = ["agentify envelopes", "agentify:envelopes", "agentify#envelopes"];
      for (const name of refused) {
        expect(name, name).not.toMatch(A_NAME_PG_BOSS_ACCEPTS);
        await expect(boss.createQueue(name)).rejects.toThrow();
      }

      // An identifier pg-boss would refuse is refused where the stream name is
      // built, not at that merchant's first sale.
      expect(() => streamOf("a merchant")).toThrow(/cannot name a queue/);
    }, 30_000);

    it("delivers a reminder, and delivers it again when the handler throws", async () => {
      // A reminder is the only thing that declares an order overdue, so one
      // dropped is a paid order never marked for a refund. The retry is the
      // queue's: a handler re-arming its own reminder would write to the thing
      // that had just thrown at it.
      const seen: Reminder[] = [];
      let failures = 0;
      const { queue } = await labQueue("pgboss_reminder_retry");
      queue.onReminder(async (reminder) => {
        seen.push(reminder);
        if (failures < 1) {
          failures += 1;
          throw new Error("the handler was briefly unhappy");
        }
      });
      await queue.start();

      await queue.remind(
        { kind: "deadline", orderId: "ord_r", deadline: "quote_expiry", at: 1 },
        0,
      );
      await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 25_000, interval: 100 });

      expect(failures).toBe(1);
      expect(seen).toStrictEqual([
        { kind: "deadline", orderId: "ord_r", deadline: "quote_expiry", at: 1 },
        { kind: "deadline", orderId: "ord_r", deadline: "quote_expiry", at: 1 },
      ]);
    }, 40_000);

    it("gives up on a reminder that never succeeds, after the number of attempts it was given", async () => {
      // Retrying forever would turn a defect into a loop. labQueue gives
      // reminders three attempts, so the third failure is the last.
      const seen: Reminder[] = [];
      // Named once: the second use is inside SQL the compiler cannot check.
      const schema = "pgboss_reminder_bound" satisfies (typeof SCHEMAS)[number];
      const { boss, queue } = await labQueue(schema);
      queue.onReminder(async (reminder) => {
        seen.push(reminder);
        throw new Error("this handler is never going to work");
      });
      await queue.start();

      await queue.remind(
        { kind: "deadline", orderId: "ord_doomed", deadline: "quote_expiry", at: 1 },
        0,
      );

      await vi.waitFor(
        async () => {
          const { rows } = await pool.query<{ state: string }>(
            `select state from ${schema}.job where name = $1`,
            [REMINDERS],
          );
          expect(rows.map((row) => row.state)).toStrictEqual(["failed"]);
        },
        { timeout: 30_000, interval: 250 },
      );
      expect(seen).toHaveLength(3);

      // A supervision pass does not pick a failed reminder up again.
      await boss.supervise();
      expect(seen).toHaveLength(3);
    }, 60_000);

    it("fires reminders that fall due together in one pass, not one poll apart", async () => {
      // Reminders fall due in clusters. Taken one per poll, the last of five
      // would land seconds late, long enough to decide whether a synchronous
      // sale went through.
      const firedAt: number[] = [];
      const { queue } = await labQueue("pgboss_reminder_together");
      queue.onReminder(async () => {
        firedAt.push(Date.now());
      });
      await queue.start();

      for (const orderId of ["ord_1", "ord_2", "ord_3", "ord_4", "ord_5"]) {
        await queue.remind({ kind: "deadline", orderId, deadline: "quote_expiry", at: 1 }, 0);
      }

      await vi.waitFor(() => expect(firedAt).toHaveLength(5), { timeout: 25_000, interval: 50 });
      // One poll apart, five would span four polls of two seconds each.
      expect(Math.max(...firedAt) - Math.min(...firedAt)).toBeLessThan(2_000);
    }, 40_000);

    it("lets one failing reminder fail alone, without holding back the ones beside it", async () => {
      // A batch settled as a whole would spend every reminder's attempts on the
      // one that threw, until their deadlines were lost.
      const seen: string[] = [];
      const schema = "pgboss_reminder_neighbours" satisfies (typeof SCHEMAS)[number];
      const { queue } = await labQueue(schema, { [REMINDERS]: {} });
      queue.onReminder(async (reminder) => {
        seen.push(reminder.orderId);
        if (reminder.orderId === "ord_broken") {
          throw new Error("this one never works");
        }
      });
      // All three are waiting before the worker starts, so its first fetch
      // takes them together, in one batch.
      for (const orderId of ["ord_broken", "ord_fine_1", "ord_fine_2"]) {
        await queue.remind({ kind: "deadline", orderId, deadline: "quote_expiry", at: 1 }, 0);
      }
      await queue.start();

      const states = async () => {
        const { rows } = await pool.query<{ order_id: string; state: string }>(
          `select data->>'orderId' as order_id, state from ${schema}.job where name = $1 order by 1`,
          [REMINDERS],
        );
        return Object.fromEntries(rows.map((row) => [row.order_id, row.state]));
      };
      await vi.waitFor(async () => expect((await states()).ord_broken).toBe("failed"), {
        timeout: 30_000,
        interval: 250,
      });

      expect(await states()).toStrictEqual({
        ord_broken: "failed",
        ord_fine_1: "completed",
        ord_fine_2: "completed",
      });
      expect(seen.filter((orderId) => orderId === "ord_fine_1")).toHaveLength(1);
      expect(seen.filter((orderId) => orderId === "ord_fine_2")).toHaveLength(1);
    }, 60_000);

    it("takes nothing for a worker that left while its draw was waiting", async () => {
      // An event is sent once, so a draw for a worker that has left must take
      // nothing: what is published afterwards stays for the next draw.
      const { queue } = await labQueue("pgboss_envelope_left");
      const left = new AbortController();
      const waiting = queue.draw(A, 10, 20_000, left.signal);
      await sleep(300);
      const startedAt = Date.now();
      left.abort();

      expect(await waiting).toStrictEqual([]);
      expect(Date.now() - startedAt).toBeLessThan(1_000);

      await queue.publish(A, {
        kind: "order_event",
        id: "env_after_left",
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          type: "order.payment_failed_after_delivery",
          order_id: "ord_left",
          at: "2026-08-26T12:00:00.000Z",
        },
      });
      const next = await queue.draw(A, 10, 2_000);
      expect(next.map((delivery) => delivery.envelope.id)).toStrictEqual(["env_after_left"]);
    }, 40_000);

    it("holds a delayed reminder back until its moment", async () => {
      // Every deadline is armed through this; a reminder fired early would
      // close an order whose merchant is still inside its deadline.
      const seen: Reminder[] = [];
      const { queue } = await labQueue("pgboss_reminder_delay");
      queue.onReminder(async (reminder) => {
        seen.push(reminder);
      });
      await queue.start();

      await queue.remind(
        { kind: "delivery_unanswered", orderId: "ord_delayed", handOver: "dlv_1" },
        4_000,
      );

      // Reminders are polled every half second, so by now this one has been
      // passed over several times; otherwise "nothing yet" would prove nothing.
      await sleep(2_800);
      expect(seen).toStrictEqual([]);

      await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 25_000, interval: 100 });
      expect(seen[0]).toStrictEqual({
        kind: "delivery_unanswered",
        orderId: "ord_delayed",
        handOver: "dlv_1",
      });
    }, 40_000);

    it("gives a reminder back when the process that took it never answers", async () => {
      // A gateway that dies holding a deadline reminder must not take the
      // deadline with it: nothing else will ever declare that paid order
      // overdue. The window is one second here, and dying is taking the job
      // without answering it.
      const { boss, queue } = await labQueue("pgboss_reminder_expiry", {
        [REMINDERS]: { expireInSeconds: 1 },
      });

      await queue.remind(
        { kind: "deadline", orderId: "ord_lost", deadline: "settle_response", at: 7 },
        0,
      );

      const taken = await boss.fetch<Reminder>(REMINDERS, { batchSize: 1 });
      expect(taken).toHaveLength(1);
      // While it is out, nobody else is given it, or two processes would both
      // act on the deadline.
      expect(await boss.fetch<Reminder>(REMINDERS, { batchSize: 1 })).toStrictEqual([]);

      await sleep(1_500);
      // pg-boss runs supervision itself about once a minute; calling it by
      // hand only compresses that wait.
      await boss.supervise();

      const again = await vi.waitFor(
        async () => {
          const jobs = await boss.fetch<Reminder>(REMINDERS, { batchSize: 1 });
          expect(jobs).toHaveLength(1);
          return jobs;
        },
        { timeout: 25_000, interval: 250 },
      );
      // The same job comes back; the deadline is not duplicated.
      expect(again[0]?.id).toBe(taken[0]?.id);
      expect(again[0]?.data).toStrictEqual({
        kind: "deadline",
        orderId: "ord_lost",
        deadline: "settle_response",
        at: 7,
      });
    }, 60_000);

    it("does not give a drawn envelope back after its window, and that is the known gap", async () => {
      // Publish keeps no retries, because redelivering an order is the order
      // machine's call. An order event has no such machine behind it, so one
      // drawn but never received is gone; closing that gap needs an
      // acknowledgement the contract does not have.
      // Named once: the second use is inside SQL the compiler cannot check.
      const schema = "pgboss_envelope_expiry" satisfies (typeof SCHEMAS)[number];
      const { boss, queue } = await labQueue(schema, {
        [STREAM]: { expireInSeconds: 1 },
      });
      const envelope: WorkerEnvelope = {
        kind: "order_event",
        id: "env_expiry_1",
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          type: "order.payment_failed_after_delivery",
          order_id: "ord_expiry",
          at: "2026-08-26T12:00:00.000Z",
        },
      };

      await queue.publish(A, envelope);
      const drawn = await queue.draw(A, 10, 5_000);
      expect(drawn.map((delivery) => delivery.envelope.id)).toStrictEqual(["env_expiry_1"]);

      // Out with one worker, so not handed to a second.
      expect(await queue.draw(A, 10, 200)).toStrictEqual([]);

      await sleep(1_500);
      await boss.supervise();

      // And still not once the window has run out.
      expect(await queue.draw(A, 10, 1_000)).toStrictEqual([]);

      // Recorded as failed, so a lost delivery can be found rather than
      // silently dropped.
      const { rows } = await pool.query<{ state: string }>(
        `select state from ${schema}.job where name = $1`,
        [STREAM],
      );
      expect(rows.map((row) => row.state)).toStrictEqual(["failed"]);
    }, 60_000);

    it("makes both queues with the fifteen-minute window a lost delivery waits out", async () => {
      // The other tests make their queues with a one-second window; this reads
      // back the window production gets. For a reminder it is how late an
      // overdue order can be declared when the gateway holding it dies. Options
      // passed to `createQueue` do not reach a database that already has the
      // queue, so changing it is `updateQueue` or a migration.
      const { boss, queue } = await labQueue("pgboss_queue_settings");
      queue.onReminder(async () => undefined);
      await queue.start();
      // A merchant's stream is made the first time it is reached for; the
      // process holds no list of merchants at start-up.
      await queue.draw(A, 1, 0);

      for (const name of [STREAM, REMINDERS]) {
        const made = await boss.getQueue(name);
        expect(made?.expireInSeconds, name).toBe(900);
      }
    }, 30_000);

    it("holds a delayed envelope back, and reaches a poll in another process when it lands", async () => {
      // Two setups. A delayed publish deliberately wakes no parked poll, so the
      // first half checks the wait itself. An immediate publish wakes only its
      // own instance's polls, so the second half checks that another
      // instance's `draw` still finds it by fetching again: pg-boss's own
      // polling lives in `work()`, which envelopes never go through.
      const publisher = await labQueue("pgboss_envelope_delay", { [STREAM]: {} });
      const drawer = await labQueue("pgboss_envelope_delay");
      const envelopeAt = (id: string): WorkerEnvelope => ({
        kind: "order_event",
        id,
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          type: "order.payment_failed_after_delivery",
          order_id: "ord_delayed_env",
          at: "2026-08-26T12:00:00.000Z",
        },
      });

      await publisher.queue.publish(A, envelopeAt("env_delayed_1"), 4_000);

      // Not yet, and long enough after publishing for a draw that ignored the
      // wait to have found it.
      expect(await drawer.queue.draw(A, 10, 2_500)).toStrictEqual([]);

      const drawn = await drawer.queue.draw(A, 10, 20_000);
      expect(drawn.map((delivery) => delivery.envelope.id)).toStrictEqual(["env_delayed_1"]);
      await drawer.queue.finish(A, drawn[0]?.handle ?? "");

      // And now one with no wait on it, which wakes the publisher's own parked
      // polls and none of the drawer's. It arrives all the same.
      await publisher.queue.publish(A, envelopeAt("env_immediate_1"));
      const carried = await drawer.queue.draw(A, 10, 20_000);
      expect(carried.map((delivery) => delivery.envelope.id)).toStrictEqual(["env_immediate_1"]);
      await drawer.queue.finish(A, carried[0]?.handle ?? "");
    }, 60_000);

    it("says whether a stream is still holding an order, and only about orders", async () => {
      // The sweep asks this before sending an order again, and every hand-over
      // counts toward an attempt cap that ends in a refund, so a wrong answer
      // costs a merchant a retry. The answer is a containment filter pg-boss
      // builds, which only a real database can check.
      const { queue } = await labQueue("pgboss_holds_order", { [STREAM]: {} });
      const orderEnvelope = (id: string, orderId: string): WorkerEnvelope => ({
        kind: "order",
        id,
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          id: orderId,
          merchant_item_id: "sku-1",
          params: {},
          price: {
            amount: "12.00",
            currency: "USD",
            at: "2026-08-26T12:00:00.000Z",
            as_of: "2026-08-26T12:00:00.000Z",
          },
          test: true,
        },
      });

      expect(await queue.holdsOrder(A, "ord_held")).toBe(false);

      await queue.publish(A, orderEnvelope("env_held_1", "ord_held"));
      expect(await queue.holdsOrder(A, "ord_held")).toBe(true);
      expect(await queue.holdsOrder(A, "ord_somebody_else")).toBe(false);

      // A redelivery waiting out its delay counts as held: it will be handed
      // over.
      await queue.publish(A, orderEnvelope("env_held_2", "ord_delayed_hold"), 60_000);
      expect(await queue.holdsOrder(A, "ord_delayed_hold")).toBe(true);

      // Drawn is not held: an envelope in a worker's hands looks like one never
      // written, which is why the sweep also waits.
      const drawn = await queue.draw(A, 10, 2_000);
      expect(drawn.map((delivery) => delivery.envelope.id)).toStrictEqual(["env_held_1"]);
      expect(await queue.holdsOrder(A, "ord_held")).toBe(false);

      // An event about an order does not hold the order: nothing re-sends
      // events.
      await queue.publish(A, {
        kind: "order_event",
        id: "env_held_3",
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          type: "order.payment_failed_after_delivery",
          order_id: "ord_held",
          at: "2026-08-26T12:00:00.000Z",
        },
      });
      expect(await queue.holdsOrder(A, "ord_held")).toBe(false);
    }, 60_000);

    it("says a failed envelope is not held, which is what the repair rests on", async () => {
      // An envelope whose window ran out is failed and never offered again.
      // Answering "held" for it would leave a paid order with nobody ever handed
      // the work until its fulfilment deadline made it a debt.
      const schema = "pgboss_holds_failed" satisfies (typeof SCHEMAS)[number];
      const { boss, queue } = await labQueue(schema, {
        [STREAM]: { expireInSeconds: 1 },
      });
      const envelope: WorkerEnvelope = {
        kind: "order",
        id: "env_failed_1",
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          id: "ord_failed",
          merchant_item_id: "sku-1",
          params: {},
          price: {
            amount: "12.00",
            currency: "USD",
            at: "2026-08-26T12:00:00.000Z",
            as_of: "2026-08-26T12:00:00.000Z",
          },
          test: true,
        },
      };

      await queue.publish(A, envelope);
      expect(await queue.holdsOrder(A, "ord_failed")).toBe(true);

      // Drawn and never answered, which is the process that died holding it.
      const drawn = await queue.draw(A, 10, 5_000);
      expect(drawn.map((delivery) => delivery.envelope.id)).toStrictEqual(["env_failed_1"]);

      await sleep(1_500);
      await boss.supervise();

      const { rows } = await pool.query<{ state: string }>(
        `select state from ${schema}.job where name = $1`,
        [STREAM],
      );
      expect(rows.map((row) => row.state)).toStrictEqual(["failed"]);
      expect(await queue.holdsOrder(A, "ord_failed")).toBe(false);
    }, 60_000);

    it("takes on work to run every day, runs it, and does not stack up schedules", async () => {
      // The gateway registers its daily sweep on every start, so a refused
      // schedule takes start-up down, and registering again must replace the
      // schedule rather than add one.
      const { boss, queue } = await labQueue("pgboss_every_day");
      let ran = 0;

      await queue.everyDay("agentify_a_daily_sweep", async () => {
        ran += 1;
      });

      await boss.send("agentify_a_daily_sweep", {});
      await vi.waitFor(() => expect(ran).toBe(1), { timeout: 25_000, interval: 100 });

      const schedules = await boss.getSchedules("agentify_a_daily_sweep");
      expect(schedules.map((schedule) => schedule.cron)).toStrictEqual(["17 3 * * *"]);

      await queue.everyDay("agentify_a_daily_sweep", async () => {
        ran += 1;
      });
      expect(await boss.getSchedules("agentify_a_daily_sweep")).toHaveLength(1);
    }, 60_000);

    it("runs persisted payment recovery every minute and replaces its schedule on restart", async () => {
      const { boss, queue } = await labQueue("pgboss_every_minute");
      let ran = 0;
      await queue.everyMinute("agentify_recovery_test", async () => {
        ran += 1;
      });
      await boss.send("agentify_recovery_test", {});
      await vi.waitFor(() => expect(ran).toBe(1), { timeout: 25_000, interval: 100 });
      expect(
        (await boss.getSchedules("agentify_recovery_test")).map((schedule) => schedule.cron),
      ).toEqual(["* * * * *"]);
      await queue.everyMinute("agentify_recovery_test", async () => {
        ran += 1;
      });
      expect(await boss.getSchedules("agentify_recovery_test")).toHaveLength(1);
    }, 60_000);
  });
}

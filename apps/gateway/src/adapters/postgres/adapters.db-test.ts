/**
 * The real adapters, against a real Postgres. Not part of `pnpm test`: they run
 * under `pnpm test:db`, which needs a Postgres (`docker compose up -d --wait
 * postgres`) and skips itself with a sentence saying so when there is none. The
 * database is `agentify_test`, this suite's own, never the one the stack runs on.
 *
 * What both store adapters promise is one shared suite in
 * `testing/store-contract.ts`, run at the foot of this file. This file holds only
 * what cannot be checked in memory: the JSONB round trip, the queue that is a
 * table, the driver's refusals, the pool and its listeners, the advisory lock,
 * the migrations, and above all `withOrder` under two clients that share nothing,
 * where a row lock is what stands between two events about one order and a
 * double charge.
 *
 * The queue's own promises are tested in `pgboss/queue.db-test.ts`, not here: a
 * gateway started here already has a worker on `agentify_reminders`, so a test
 * waiting for its own second consumer to get a job would be waiting for the queue
 * to misbehave.
 */

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import type { Card, Receipt, WorkerEnvelope } from "@nuanu-ai/agentify-contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Gateway } from "../../app/gateway.js";
import { setPayoutWallet } from "../../app/merchants.js";
import type { Runtime } from "../../app/runtime.js";
import { openCommandApplication } from "../../command-application.js";
import { loadConfig } from "../../config.js";
import { widestChallengeOn } from "../../http/x402.js";
import { nobodyAnnounces } from "../../ports/announcer.js";
import type { OrderChange } from "../../ports/store.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "../../split/networks.js";
import { payoutSplitFor } from "../../split/parameters.js";
import { startGateway } from "../../start.js";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "../../testing/database.js";
import {
  authorisation,
  countedIds,
  loggedWhile,
  serve,
  testConfig,
  workUntilStopped,
} from "../../testing/harness.js";
import { anOrder, describeStore } from "../../testing/store-contract.js";
import { describeWalletSpelling } from "../../testing/wallet-spelling.js";
import { ScriptedFacilitator } from "../memory/facilitator.js";
import { MemoryQueue } from "../memory/queue.js";
import { PgBossQueue, streamOf } from "../pgboss/queue.js";
import { connect, type Database, PostgresStore } from "./store.js";

/** The merchant everything in this suite belongs to. */
const A = "mch_a";

// Created if missing, so an existing volume needs nothing done to it.
const wanted = testDatabaseUrl();
const databaseUrl = await readyDatabase(wanted);

/**
 * This suite's own pg-boss schema, apart from a deployment's and from the other
 * db-test file's, because `DATABASE_URL` can still point at a database somebody
 * else is using.
 */
const QUEUE_SCHEMA = "pgboss_adapters";

/**
 * Every table in the schema, emptied in one statement, here before the file
 * starts and by the store contract before each of its cases. It must be every
 * table: a payment claim left behind owns the fingerprint the next run presents
 * and refuses every purchase, and a merchant row left paused turns away every
 * later run's purchases. A table added to `schema.ts` belongs in this list.
 */
const EMPTY_EVERY_TABLE =
  "truncate table cards, orders, receipts, payment_claims, merchant_keys, merchants, payout_splits";

/**
 * Terminates one backend, named by its pid, from a connection of its own.
 * Searching for the session instead kills the wrong one: everything holding an
 * advisory lock includes the gateway's own connections, and the shared pool
 * leaves idle connections whose last statement was `pg_try_advisory_lock` too.
 * The result is checked because `pg_terminate_backend` only warns about a pid
 * that is not running, and every assertion downstream would still pass with
 * nothing terminated.
 */
async function terminate(pid: number): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl ?? "", max: 1 });
  try {
    const { rows } = await pool.query<{ gone: boolean }>(
      "select pg_terminate_backend($1) as gone",
      [pid],
    );
    if (rows[0]?.gone !== true) {
      throw new Error(
        `backend ${pid} was not terminated, so nothing below is testing what it says it is`,
      );
    }
  } finally {
    await pool.end();
  }
}

/**
 * Runs the work and returns whatever reached Node as an uncaught exception
 * meanwhile. An `error` event on a client with no listener is one, and the
 * runner reports it beside the results while the test itself stays green, so
 * the test collects it to assert on.
 */
async function whatWentUnlistened(work: () => Promise<void>): Promise<string[]> {
  const unlistened: string[] = [];
  const collect = (thrown: unknown) => {
    unlistened.push(String(thrown));
  };
  process.on("uncaughtException", collect);
  try {
    await work();
  } finally {
    process.removeListener("uncaughtException", collect);
  }
  return unlistened;
}

/** Which server session a connection is, so a lock can be attributed to it. */
async function backendPid(of: Pool): Promise<number> {
  const { rows } = await of.query<{ pid: number }>("select pg_backend_pid() as pid");
  const pid = rows[0]?.pid;
  if (pid === undefined) {
    throw new Error("a connection would not say which backend it is");
  }
  return pid;
}

/** The address the payments below were checked against; nothing here turns on which. */
const PAID_AT = "0x0000000000000000000000000000000000000009";

const syncCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

if (databaseUrl === null) {
  // Said out loud as well as in the skipped test's name, because a run that
  // reports "1 skipped" and nothing else looks like a suite that passed.
  console.log(noDatabaseHere(wanted));

  describe("the real adapters", () => {
    it.skip("are skipped: there is no Postgres to run them against", () => {
      // Intentionally empty: the message above is the whole point.
    });
  });
} else {
  describe("the real adapters", () => {
    let pool: Pool;
    let store: PostgresStore;
    /**
     * The pool the shared store contract runs on, apart from the one this file's
     * store and gateway share. Two of the contract's cases hold a transaction
     * open while a second runs, so on a pool of one the second would wait for a
     * connection rather than a lock, and the pool, not the database, would
     * answer.
     */
    let contract: ReturnType<typeof connect>;
    let queue: PgBossQueue;
    let boss: PgBoss;
    let gateway: Gateway;
    let facilitator: ScriptedFacilitator;
    let now = Date.parse("2026-08-26T12:00:00.000Z");

    beforeAll(async () => {
      // The schema first, from the same checked-in migrations a deployment
      // applies, so this suite fails on a migration that does not apply rather
      // than on a table it happened to find.
      const here = dirname(fileURLToPath(import.meta.url));
      const migrating = new Pool({ connectionString: databaseUrl });
      await migrate(drizzle(migrating), {
        migrationsFolder: join(here, "..", "..", "..", "drizzle"),
      });
      await migrating.end();

      const connected = connect(databaseUrl);
      pool = connected.pool;
      // Through `connect`, so its connections carry the same error listeners.
      // Four is more than the two its cases need at once and small enough that
      // exhaustion by something else still fails visibly.
      contract = connect(databaseUrl, { max: 4 });
      // Every run starts from an empty catalog, or the counts below would be
      // reading somebody else's leftovers.
      await pool.query(EMPTY_EVERY_TABLE);
      // The queue's tables are dropped, not emptied, and before the gateway
      // starts: pg-boss's deleteAllJobs truncates `pgboss.job` under an
      // exclusive lock that races the reminder worker's polling into an
      // intermittent deadlock. Dropping also clears the queues and the cron
      // schedules `everyDay` leaves on the volume. The schema is this suite's
      // own because the database may be the one the containers use, and a
      // running gateway whose schema is dropped goes on reporting itself
      // healthy with no queue. The cost: pg-boss's migration of an existing
      // installation is exercised nowhere, so check it at the next upgrade.
      await pool.query(`drop schema if exists ${QUEUE_SCHEMA} cascade`);

      boss = new PgBoss({ connectionString: databaseUrl, schema: QUEUE_SCHEMA });
      queue = PgBossQueue.over(boss, {
        pollIntervalMs: 50,
        reminders: { attempts: 3, retryDelayMs: 1_000 },
      });
      // The queue is made first because the store writes through it: an
      // envelope that must not be lost goes into the same transaction as the
      // order that implies it, as `start.ts` arranges.
      store = PostgresStore.over(connected.db, "eip155:84532", countedIds(), queue.envelopes());
      facilitator = new ScriptedFacilitator();

      const config = testConfig({ PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000001" });
      const runtime: Runtime = {
        config,
        store,
        queue,
        facilitator,
        clock: () => now,
        ids: countedIds(),
        announcer: nobodyAnnounces,
        widestChallenge: widestChallengeOn(config),
      };
      gateway = new Gateway(runtime);
      await gateway.start();
    }, 60_000);

    // The merchant is written back after each truncate: every card, order and
    // receipt references it by foreign key.
    const theMerchantOfThisSuite = async () => {
      await store.addMerchant({ id: A, name: "The merchant of this suite" }, now);
      // Outside the sandbox a card is on sale only if its merchant has a wallet,
      // and this config names a real facilitator.
      await setPayoutWallet(
        store,
        testConfig().payoutSplit,
        A,
        "0x0000000000000000000000000000000000000001",
        now,
      );
      // And a name, because a payment request names its seller; without one
      // nothing is on sale.
      await store.setServiceName(A, "The merchant of this suite", now);
    };
    beforeEach(theMerchantOfThisSuite);

    afterAll(async () => {
      await gateway.stop();
      // Dropped here so the database keeps no test run's pg-boss; the drop in
      // beforeAll stays too, for a run that dies midway.
      await pool.query(`drop schema if exists ${QUEUE_SCHEMA} cascade`);
      await pool.end();
      await contract.pool.end();
    });

    afterEach(() => {
      now = Date.parse("2026-08-26T12:00:00.000Z");
    });

    it("records the first live grant without moving the merchant update time", async () => {
      const before = await pool.query<{ updated_at: Date }>(
        "select updated_at from merchants where id = $1",
        [A],
      );
      const granted = await store.grantLiveApproval(A, now + 1_000);
      const repeated = await store.grantLiveApproval(A, now + 9_000);
      const after = await pool.query<{ updated_at: Date; live_approved_at: Date | null }>(
        "select updated_at, live_approved_at from merchants where id = $1",
        [A],
      );

      expect(granted).toMatchObject({
        changed: true,
        merchant: { liveApprovedAt: now + 1_000 },
      });
      expect(repeated).toMatchObject({
        changed: false,
        merchant: { liveApprovedAt: now + 1_000 },
      });
      expect(after.rows[0]?.live_approved_at?.getTime()).toBe(now + 1_000);
      expect(after.rows[0]?.updated_at).toStrictEqual(before.rows[0]?.updated_at);
    });

    it("holds no selling word the machine does not know", async () => {
      // A hand-edited row or a value from another version of this code would
      // leave every read guessing whether somebody is selling.
      await store.setSelling(A, "paused");

      await expect(
        pool.query("update merchants set selling = $1 where id = $2", ["sort-of", A]),
      ).rejects.toThrow(/merchants_selling_known/);
      expect(await store.selling(A)).toBe("paused");

      await store.setSelling(A, "open");
    });

    describe("the birth of an order and a switch of integration", () => {
      // A birth holds its merchant's row for share while it writes, and a
      // switch holds it for update while it counts the orders that hold it, so
      // neither can land inside the other. The store contract runs them one
      // after the other; only two connections can show they wait.
      const settledWithin = async (pending: Promise<unknown>, ms: number): Promise<boolean> => {
        let settled = false;
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, ms));
        return settled;
      };

      afterEach(async () => {
        await pool.query("delete from orders where merchant_id = $1", [A]);
        await pool.query("update merchants set integration = 'api' where id = $1", [A]);
      });

      it("makes a birth wait for a switch, and writes nothing once the switch has moved the merchant", async () => {
        const switching = await pool.connect();
        try {
          await switching.query("begin");
          await switching.query("select id from merchants where id = $1 for update", [A]);

          const born = store.addOrder(
            anOrder("ord_born_in_the_switch", "quoted", { merchantId: A }),
            "api",
          );
          expect(await settledWithin(born, 300)).toBe(false);

          await switching.query("update merchants set integration = 'woocommerce' where id = $1", [
            A,
          ]);
          await switching.query("commit");

          expect(await born).toBe(false);
          expect(await store.orderById("ord_born_in_the_switch")).toBeNull();
        } finally {
          switching.release();
        }
      });

      it("makes a switch wait for a birth, and counts the order it wrote", async () => {
        const birth = await pool.connect();
        try {
          await birth.query("begin");
          await birth.query("select id from merchants where id = $1 for share", [A]);

          const switched = store.switchIntegration(A, "woocommerce");
          expect(await settledWithin(switched, 300)).toBe(false);

          await birth.query(
            `insert into orders (id, state, open, merchant_id, item_id, merchant_item_id, record, created_at, updated_at)
             values ('ord_born_first', 'paid', true, $1, 'item_x', 'sku-x', '{}', now(), now())`,
            [A],
          );
          await birth.query("commit");

          expect(await switched).toStrictEqual({ switched: false, waiting: ["ord_born_first"] });
        } finally {
          birth.release();
        }
      });
    });

    it("lets one of two separate database clients take an order, and makes the other wait to find out", async () => {
      // Two pools and two connections, so only the database can make the second
      // wait: a chain of promises in one adapter would pass the store contract's
      // race just as well. Without the hold both read the order before either
      // writes, both own it, and one charge fails after the goods are handed
      // over.
      const published = await store.publishCard(
        A,
        { ...syncCard, merchant_item_id: "contested" },
        now,
      );
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");
      const orderId = offered.order.order.id;

      // One connection each: the check below names the two backends by pid, so
      // a second connection would leave it watching a session not doing the
      // work. Through `connect`, so the clients carry the error listener;
      // alice's sits idle for as long as the poll below takes.
      const alice = connect(databaseUrl, { max: 1 });
      const bob = connect(databaseUrl, { max: 1 });
      const alicePool = alice.pool;
      const bobPool = bob.pool;
      const reads: string[] = [];
      let aliceHeldBobUp = false;

      try {
        const alicePid = await backendPid(alicePool);
        const bobPid = await backendPid(bobPool);
        expect(alicePid).not.toBe(bobPid);

        let letBobIn: () => void = () => undefined;
        const bobMayStart = new Promise<void>((resolve) => {
          letBobIn = resolve;
        });

        /** What one client came away with: the order, or the name of whoever has it. */
        type Taken = { readonly took: true } | { readonly took: false; readonly heldBy: string };

        const take = (client: PostgresStore, who: string) =>
          client.withOrder(orderId, async (found): Promise<OrderChange<Taken>> => {
            reads.push(who);
            if (who === "alice") {
              letBobIn();
              // Waited for rather than slept through, until bob's transaction
              // is stuck behind alice's. It gives up rather than throwing, so a
              // lock that never took shows up below as two owners, not as a
              // timeout. The check names both backends because pg-boss runs its
              // own `for update` on this database, and any two sessions
              // contending over any row would pass a looser one: only alice's
              // lock on this order's row makes `pg_blocking_pids(bobPid)` name
              // `alicePid`.
              const until = Date.now() + 5_000;
              while (Date.now() < until && !aliceHeldBobUp) {
                const { rows } = await pool.query<{ blockers: number[] }>(
                  "select pg_blocking_pids($1) as blockers",
                  [bobPid],
                );
                aliceHeldBobUp = (rows[0]?.blockers ?? []).includes(alicePid);
                if (!aliceHeldBobUp) {
                  await new Promise((resolve) => setTimeout(resolve, 50));
                }
              }
            }

            if (found.paidBy !== null && found.paidBy !== who) {
              return { result: { took: false, heldBy: found.paidBy } };
            }
            // Noted before the write goes back. Alice reads first by
            // arrangement; only the hold makes her decide before bob reads.
            reads.push(`${who} decided`);
            return { save: { ...found, paidBy: who }, result: { took: true } };
          });

        const aliceTaking = take(
          PostgresStore.over(alice.db, "eip155:84532", countedIds()),
          "alice",
        );
        await bobMayStart;
        const bobTaking = take(PostgresStore.over(bob.db, "eip155:84532", countedIds()), "bob");
        const [first, second] = await Promise.all([aliceTaking, bobTaking]);

        const decided = [first, second].map((lookup) => (lookup.found ? lookup.result : null));
        expect(decided).toStrictEqual([{ took: true }, { took: false, heldBy: "alice" }]);
        expect(aliceHeldBobUp).toBe(true);
        // Without the lock bob reads and decides while alice polls, and the
        // marks come out "alice", "bob", "bob decided", "alice decided".
        expect(reads).toStrictEqual(["alice", "alice decided", "bob"]);
        expect((await store.orderById(orderId))?.paidBy).toBe("alice");
      } finally {
        await alicePool.end();
        await bobPool.end();
      }
    }, 30_000);

    it("gives one payment to exactly one of two orders racing for it", async () => {
      const [first, second] = await Promise.all([
        store.claimPayment("fp-db-race", "ord_race_a"),
        store.claimPayment("fp-db-race", "ord_race_b"),
      ]);

      const won = [first, second].filter((claim) => claim.claimed);
      expect(won).toHaveLength(1);
    });

    it("keeps the open column in step with the state inside the document", async () => {
      // `open` is a column written from the document by `rowFor`, and
      // `GET /orders?open=true` answers from it. The in-memory adapter has no
      // such column, so only this test catches one that fell behind and
      // dropped a live order from the list the dashboard works from.
      const published = await store.publishCard(
        A,
        { ...syncCard, merchant_item_id: "listed" },
        now,
      );
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");
      const orderId = offered.order.order.id;

      const idsOf = async (query?: { readonly open?: boolean }) =>
        (await store.orders(A, query)).map((record) => record.order.id);

      expect(await idsOf({ open: true })).toContain(orderId);

      // Closed inside the document, and nothing said about the column.
      await store.withOrder(orderId, (found) => ({
        save: { ...found, order: { ...found.order, state: "expired" } },
        result: null,
      }));

      expect(await idsOf({ open: true })).not.toContain(orderId);
      // Closed is not deleted: reconciling a day's orders reads the full list.
      expect(await idsOf()).toContain(orderId);
    });

    it("refuses a closing message cut in the middle of a character before the database sees it", async () => {
      // Postgres refuses half a surrogate pair in a document, so a message
      // that reached it would fail the write and answer as a retryable fault
      // a merchant's code could repeat forever.
      const published = await store.publishCard(
        A,
        { ...syncCard, merchant_item_id: "closed-with-half-a-character" },
        now,
      );
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");
      const orderId = offered.order.order.id;
      const { secret } = await gateway.issueMerchantKey(A, "closing", {
        kind: "signed_in",
        email: "owner@example.com",
      });
      const served = await serve({ gateway });
      try {
        const close = (message: string) =>
          served.call("POST", `/v0/orders/${orderId}/close`, {
            headers: { authorization: `Bearer ${secret}` },
            body: { message },
          });

        const cut = await close(`${"We are sorry ".repeat(10)}\uD83D`);
        expect(cut.status).toBe(400);
        expect(cut.body).toMatchObject({ error: { code: "malformed_body", retryable: false } });
        expect((await store.orderById(orderId))?.order.state).toBe("quoted");

        expect((await close("We are sorry \u{1F64F}")).body).toEqual({ ok: true });
        expect((await store.orderById(orderId))?.order.merchantClosure?.message).toBe(
          "We are sorry \u{1F64F}",
        );
      } finally {
        await served.close();
      }
    });

    it("leaves the row alone when a decision asked for nothing to be written", async () => {
      // `updated_at` is the only place a write with nothing to write shows up,
      // so the shared suite cannot ask this. A store that wrote anyway would
      // put back what it read over whatever landed in between: the lost update
      // the hold exists to prevent.
      const published = await store.publishCard(
        A,
        { ...syncCard, merchant_item_id: "untouched" },
        now,
      );
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");
      const orderId = offered.order.order.id;

      const writtenAt = async (): Promise<string> => {
        const { rows } = await pool.query<{ at: Date }>(
          "select updated_at as at from orders where id = $1",
          [orderId],
        );
        const at = rows[0]?.at;
        if (at === undefined) {
          throw new Error(`there is no order ${orderId}, so there is no row to read`);
        }
        return at.toISOString();
      };

      const before = await writtenAt();
      // The column resolves to microseconds, so twenty milliseconds leaves a
      // real write nowhere to hide.
      await new Promise((resolve) => setTimeout(resolve, 20));

      await store.withOrder(orderId, (found) => ({
        // The order this decision would have written, handed back as its answer
        // rather than named in `save`.
        result: { ...found, order: { ...found.order, state: "expired" as const } },
      }));

      expect(await writtenAt()).toBe(before);

      // Negative control: a decision that asks for a write does move the column.
      await store.withOrder(orderId, (found) => ({
        save: { ...found, priceId: "written on purpose" },
        result: null,
      }));

      expect(await writtenAt()).not.toBe(before);
    });

    it("carries an envelope through the queue and does not send it round again by itself", async () => {
      const published = await store.publishCard(
        A,
        { ...syncCard, merchant_item_id: "queued" },
        now,
      );
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");

      const drawn = await queue.draw(A, 10, 2_000);
      expect(drawn).toHaveLength(0);

      await queue.publish(A, {
        kind: "order_event",
        id: "env_db_1",
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          type: "order.unpaid_after_confirmation",
          order_id: "ord_db_1",
          at: "2026-08-26T12:00:00.000Z",
        },
      });

      const first = await queue.draw(A, 10, 2_000);
      expect(first.map((d) => d.envelope.id)).toStrictEqual(["env_db_1"]);
      await queue.finish(A, first[0]?.handle ?? "");

      expect(await queue.draw(A, 10, 200)).toStrictEqual([]);
    });

    describe("a failure in the database", () => {
      // No error leaving the store or the queue may carry a value bound to its
      // statement. Each test makes the database refuse a write that has a
      // buyer's parameter in it and reads everything a log line could print of
      // the error: the refusal quotes the failing row and the library above it
      // repeats every parameter, so the parameter is there to leak.
      const BUYER = "buyer-ord-7c1e05@example.com";
      const MARKER = "refused-by-this-test";
      const printed = (thrown: unknown): string =>
        inspect(thrown, { depth: Number.POSITIVE_INFINITY, showHidden: true });

      async function refusedBy(table: string, column: string, work: () => Promise<unknown>) {
        await pool.query(
          `alter table ${table} add constraint refuse_the_marker check (${column}::text not like '%${MARKER}%')`,
        );
        try {
          return await work().then(
            () => {
              throw new Error("the database took a write this test made it refuse");
            },
            (thrown: unknown) => thrown,
          );
        } finally {
          await pool.query(`alter table ${table} drop constraint refuse_the_marker`);
        }
      }

      it("leaves the store saying what failed, and without the buyer's parameters", async () => {
        const published = await store.publishCard(
          A,
          { ...syncCard, merchant_item_id: "refused", params: { email: { type: "string" } } },
          now,
        );
        const offered = await gateway.beginPurchase(published.id, { email: BUYER });
        if (offered.step !== "pay") throw new Error("no price was offered");
        const orderId = offered.order.order.id;

        const thrown = await refusedBy("orders", "record", () =>
          store.withOrder(orderId, (found) => ({
            save: { ...found, params: { ...found.params, note: MARKER } },
            result: null,
          })),
        );

        expect(printed(thrown)).not.toContain(BUYER);
        expect((thrown as Error).message).toContain("refuse_the_marker");
      });

      it("leaves the queue saying what failed, and without the envelope's contents", async () => {
        const thrown = await refusedBy(`${QUEUE_SCHEMA}.job`, "data", () =>
          // The refusal quotes the row only so far into each value, so what is
          // to leak goes where it is quoted: the envelope's identifier, the
          // first key of its document.
          queue.publish(A, {
            kind: "order_event",
            id: `env_${BUYER}_${MARKER}`,
            sent_at: "2026-08-26T12:00:00.000Z",
            payload: {
              type: "order.unpaid_after_confirmation",
              order_id: "ord_db_refused",
              at: "2026-08-26T12:00:00.000Z",
            },
          }),
        );

        expect(printed(thrown)).not.toContain(BUYER);
        expect((thrown as Error).message).toContain("refuse_the_marker");
      });
    });

    it("walks a parcel through the database and the queue, and keeps nothing of its address", async () => {
      // pg-boss keeps finished jobs for days, so taking the order on must erase
      // the order's copy of the address and delete both the price question and
      // the hand-over. Searched as text across every job on the stream, so a
      // field this test did not think of is found too.
      const buyer = `The buyer ${randomUUID()}`;
      const shipTo = {
        name: buyer,
        line_one: "Jl. Raya Kediri, Beraban",
        city: "Tabanan",
        country: "ID",
        phone_number: "+62 000 0000 0000",
      };
      const published = await store.publishCard(
        A,
        {
          merchant_item_id: `beans-${randomUUID()}`,
          title: "Coffee beans, one kilogram",
          description: "Roasted in Bali this week and sent by courier.",
          price: { amount: "18.00", currency: "USD" },
          fulfillment: "ship",
          ship_within_seconds: 172_800,
          price_check: "handler",
        },
        now,
      );
      const merchant = { id: A, name: "", key: "", keyId: "", wallet: "" };
      const pricing = workUntilStopped(
        { gateway, merchant },
        {
          onQuote: () => ({
            available: true,
            price: { amount: "21.00", currency: "USD" },
            as_of: "2026-08-26T10:15:00Z",
          }),
        },
      );
      const offered = await gateway.beginPurchase(published.id, {}, shipTo);
      await pricing.stop();
      if (offered.step !== "pay") throw new Error("no price was offered");
      const orderId = offered.order.order.id;

      const paid = `parcel-${randomUUID()}`;
      await gateway.payPurchase(orderId, paid, paid);
      const takingOn = workUntilStopped(
        { gateway, merchant },
        { onOrder: () => ({ accepted: {} }) },
      );
      await vi.waitFor(async () => {
        expect((await store.orderById(orderId))?.shipTo).toStrictEqual({
          erasedAt: expect.any(Number),
        });
      });
      await takingOn.stop();

      const { rows } = await pool.query<{ n: string }>(
        `select count(*) as n from ${QUEUE_SCHEMA}.job where name = $1 and data::text like $2`,
        [streamOf(A), `%${buyer}%`],
      );
      expect(Number(rows[0]?.n)).toBe(0);
      // The price question carries the place and not the person, so it is
      // found by the identifier the order kept for it.
      const kept = await store.orderById(orderId);
      const asked = await pool.query<{ n: string }>(
        `select count(*) as n from ${QUEUE_SCHEMA}.job where name = $1 and data @> $2::jsonb`,
        [streamOf(A), JSON.stringify({ payload: { price_id: kept?.priceQuestion } })],
      );
      expect(kept?.priceQuestion).toEqual(expect.any(String));
      expect(Number(asked.rows[0]?.n)).toBe(0);
      expect(JSON.stringify(kept)).not.toContain(buyer);
    }, 30_000);

    it("walks a whole synchronous sale through the database and the queue", async () => {
      // The in-memory tests walk the same flow; this adds the round trip
      // through JSONB and through a queue that is a table.
      const published = await store.publishCard(
        A,
        { ...syncCard, merchant_item_id: "walked" },
        now,
      );
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");

      const worker = workUntilStopped(
        { gateway, merchant: { id: A, name: "", key: "", keyId: "", wallet: "" } },
        { onOrder: () => ({ delivered: { access_code: "SESAME" } }) },
      );
      // A fingerprint of this run's own, so the claim left behind by a previous
      // run — or by another test in this one — is never what decides it.
      const paid = `walked-${randomUUID()}`;
      const bought = await gateway.payPurchase(offered.order.order.id, paid, paid);
      await worker.stop();

      expect(bought.step).toBe("settled");
      if (bought.step !== "settled") throw new Error("the purchase did not settle");
      expect(bought.order.order.state).toBe("delivered");
      expect(bought.delivery).toStrictEqual({ access_code: "SESAME" });

      const receipt = await store.receiptForOrder(offered.order.order.id);
      expect(receipt?.outcome).toBe("delivered");
      expect(receipt?.price.amount).toBe("80.00");
      // The list is a different query from the lookup, and a receipt that can
      // be fetched but is never listed is a day's takings that does not add up.
      const listed = await store.receipts(A);
      expect(listed.map((one) => one.order_id)).toContain(offered.order.order.id);
      expect(listed.find((one) => one.order_id === offered.order.order.id)).toStrictEqual(receipt);
    }, 30_000);
    it("charges an order written before payment references under the one the migration gave it", async () => {
      // The order is made, paid and left unpaid by a failed charge as today,
      // then put back as it was written before references existed, and the
      // migration's own statement gives it one. Its buyer was never given
      // that reference, so the payment for it here is presented directly, as
      // the purchase would once the reference had found the order.
      const published = await store.publishCard(
        A,
        { ...syncCard, merchant_item_id: "paid-again-after-the-migration" },
        now,
      );
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");
      const orderId = offered.order.order.id;
      const wallet = `0x${randomUUID().replaceAll("-", "").padEnd(40, "0")}`;
      const earlier = facilitator.settles.length;
      facilitator.willSettle(
        ...Array.from(
          { length: earlier },
          () => ({ settled: true, transaction: "0xearlier" }) as const,
        ),
        { settled: false, reason: "the transfer reverted" },
        { settled: true, transaction: "0xagain" },
      );
      try {
        const worker = workUntilStopped(
          { gateway, merchant: { id: A, name: "", key: "", keyId: "", wallet: "" } },
          { onOrder: () => ({ delivered: { access_code: "SESAME" } }) },
        );
        const first = authorisation(gateway, wallet, "0x01");
        await gateway.payPurchase(orderId, first.payment, first.fingerprint);
        await worker.stop();
        expect((await store.orderById(orderId))?.order.state).toBe("delivered_unpaid");

        await pool.query("update orders set record = record - 'paymentRef' where id = $1", [
          orderId,
        ]);
        const migration = await readFile(
          join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "..",
            "..",
            "drizzle",
            "0018_order_payment_ref.sql",
          ),
          "utf8",
        );
        const backfill = migration
          .split("--> statement-breakpoint")
          .map((statement) => statement.trim())
          .find((statement) => /^UPDATE/m.test(statement.replace(/^--.*$/gm, "").trim()));
        if (backfill === undefined) throw new Error("the migration gives no order a reference");
        await pool.query(backfill);

        const given = (await store.orderById(orderId))?.paymentRef ?? "";
        expect((await gateway.orderForPayment(given))?.order.id).toBe(orderId);
        const again = authorisation(gateway, wallet, "0x02");
        const paid = await gateway.payPurchase(orderId, again.payment, again.fingerprint);

        expect(paid.step).toBe("settled");
        if (paid.step !== "settled") throw new Error("the order was not paid again");
        expect(paid.order.order.state).toBe("delivered");
        expect(paid.delivery).toStrictEqual({ access_code: "SESAME" });
        expect(facilitator.settles.at(-1)?.paymentRef).toBe(given);
      } finally {
        facilitator.willSettle();
      }
    }, 30_000);

    /**
     * The effects that must not be lost, against the database where the losing
     * would happen. The envelope is a row pg-boss owns, written on our
     * connection through the handle it takes in its send options; whether it is
     * really in our transaction is a fact about Postgres that no offline test
     * can establish.
     */
    describe("an effect written where the state is", () => {
      /** How many jobs with this envelope's identifier are on that stream. */
      const jobsFor = async (merchantId: string, envelopeId: string): Promise<number> => {
        const { rows } = await pool.query<{ n: string }>(
          `select count(*) as n from ${QUEUE_SCHEMA}.job where name = $1 and data->>'id' = $2`,
          [streamOf(merchantId), envelopeId],
        );
        return Number(rows[0]?.n ?? "0");
      };

      const anEnvelope = (id: string): WorkerEnvelope => ({
        kind: "order_event",
        id,
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          type: "order.unpaid_after_confirmation",
          order_id: "ord_written_with_the_state",
          at: "2026-08-26T12:00:00.000Z",
        },
      });

      const aReceipt = (orderId: string, itemId: string): Receipt => ({
        id: `rcp_${randomUUID()}`,
        order_id: orderId,
        item_id: itemId,
        price: {
          amount: "80.00",
          currency: "USD",
          at: "2026-08-26T12:00:00.000Z",
          as_of: "2026-08-26T12:00:00.000Z",
        },
        paid_at: "2026-08-26T12:00:00.000Z",
        outcome: "delivered",
        test: true,
      });

      /** An order of A's, priced and waiting to be paid for. */
      const anOrder = async (name: string): Promise<{ id: string; itemId: string }> => {
        const card = await store.publishCard(A, { ...syncCard, merchant_item_id: name }, now);
        const offered = await gateway.beginPurchase(card.id, {});
        if (offered.step !== "pay") throw new Error("no price was offered");
        return { id: offered.order.order.id, itemId: card.id };
      };

      it("is not there at all when the write it went in with rolled back", async () => {
        // The envelope goes into the transaction first and the receipt after
        // it names a merchant that does not exist, so
        // Postgres refuses the second write and takes the first down with it.
        // A pg-boss insert that had gone out on the library's own connection
        // would survive that, and the count below would be one.
        const order = await anOrder("rolled-back");
        const envelopeId = `env_${randomUUID()}`;

        await expect(
          store.withOrder(order.id, (found) => ({
            save: { ...found, priceId: "the write that never happened" },
            alongside: [
              { kind: "envelope", merchantId: A, envelope: anEnvelope(envelopeId) },
              { kind: "receipt", merchantId: "mch_nobody", receipt: aReceipt(order.id, "item") },
            ],
            result: null,
          })),
        ).rejects.toThrow();

        expect(await jobsFor(A, envelopeId)).toBe(0);
        expect(await store.receiptForOrder(order.id)).toBeNull();
        expect((await store.orderById(order.id))?.priceId).not.toBe(
          "the write that never happened",
        );
      });

      it("is there with the order when the write went through", async () => {
        // The negative control for the case above: the same three writes with
        // nothing refusing, so that "no job" there means the rollback and not
        // that this never writes one.
        const order = await anOrder("went-through");
        const envelopeId = `env_${randomUUID()}`;

        await store.withOrder(order.id, (found) => ({
          save: { ...found, priceId: "the write that happened" },
          alongside: [
            { kind: "envelope", merchantId: A, envelope: anEnvelope(envelopeId) },
            { kind: "receipt", merchantId: A, receipt: aReceipt(order.id, order.itemId) },
          ],
          result: null,
        }));

        expect(await jobsFor(A, envelopeId)).toBe(1);
        expect((await store.receiptForOrder(order.id))?.order_id).toBe(order.id);
        expect((await store.orderById(order.id))?.priceId).toBe("the write that happened");
      });

      /** How many jobs on that stream carry a document containing this one, in any state. */
      const jobsCarrying = async (merchantId: string, data: object): Promise<number> => {
        const { rows } = await pool.query<{ n: string }>(
          `select count(*) as n from ${QUEUE_SCHEMA}.job where name = $1 and data @> $2::jsonb`,
          [streamOf(merchantId), JSON.stringify(data)],
        );
        return Number(rows[0]?.n ?? "0");
      };

      /** A hand-over of one order, which for a parcel carries the whole address. */
      const aHandOver = (orderId: string): WorkerEnvelope => ({
        kind: "order",
        id: `env_${randomUUID()}`,
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          id: orderId,
          merchant_item_id: "beans-1kg",
          params: {},
          price: {
            amount: "21.00",
            currency: "USD",
            at: "2026-08-26T12:00:00.000Z",
            as_of: "2026-08-26T12:00:00.000Z",
          },
          test: true,
        },
      });

      /** A price question, which for a parcel carries the place it goes. */
      const aQuestion = (priceId: string): WorkerEnvelope => ({
        kind: "quote_request",
        id: `env_${randomUUID()}`,
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          merchant_item_id: "beans-1kg",
          price_id: priceId,
          purpose: "purchase",
          expires_at: "2026-08-26T12:10:00.000Z",
        },
      });

      /**
       * An order whose question and first hand-over a worker drew and finished,
       * with a second hand-over waiting out a delay, an event about it, and
       * another order's hand-over beside them. pg-boss keeps a finished job in
       * its table for days, so "drawn" is not "gone".
       */
      const aStreamCarryingAnAddress = async (name: string) => {
        const order = await anOrder(name);
        const priceId = `prc_${randomUUID()}`;
        const otherOrderId = `ord_${randomUUID()}`;
        await queue.draw(A, 100, 0);
        await queue.publish(A, aQuestion(priceId));
        await queue.publish(A, aHandOver(order.id));
        for (const drawn of await queue.draw(A, 10, 2_000)) {
          await queue.finish(A, drawn.handle);
        }
        await queue.publish(A, aHandOver(order.id), 3_600_000);
        await queue.publish(A, {
          kind: "order_event",
          id: `env_${randomUUID()}`,
          sent_at: "2026-08-26T12:00:00.000Z",
          payload: {
            type: "order.unpaid_after_confirmation",
            order_id: order.id,
            at: "2026-08-26T12:00:00.000Z",
          },
        });
        await queue.publish(A, aHandOver(otherOrderId));
        expect(await jobsCarrying(A, { kind: "order", payload: { id: order.id } })).toBe(2);
        expect(await jobsCarrying(A, { payload: { price_id: priceId } })).toBe(1);
        return { order, priceId, otherOrderId };
      };

      it("deletes every job carrying a parcel's address with the order, finished ones included", async () => {
        // Once the merchant has the address, the order's hand-overs and its
        // price question leave the queue in the same transaction as the order
        // that says so. The event about the order carries no address and stays,
        // and so does another order's hand-over.
        const { order, priceId, otherOrderId } = await aStreamCarryingAnAddress("forgotten");

        await store.withOrder(order.id, (found) => ({
          save: found,
          alongside: [{ kind: "forget", merchantId: A, orderId: order.id, priceQuestion: priceId }],
          result: null,
        }));

        expect(await jobsCarrying(A, { kind: "order", payload: { id: order.id } })).toBe(0);
        expect(await jobsCarrying(A, { payload: { price_id: priceId } })).toBe(0);
        expect(
          await jobsCarrying(A, { kind: "order_event", payload: { order_id: order.id } }),
        ).toBe(1);
        expect(await jobsCarrying(A, { kind: "order", payload: { id: otherOrderId } })).toBe(1);
      });

      it("deletes nothing when the write it went in with rolled back", async () => {
        // The order would otherwise still hold the address while the queue had
        // let go of the hand-over that was to deliver it.
        const { order, priceId } = await aStreamCarryingAnAddress("forgotten-rolled-back");

        await expect(
          store.withOrder(order.id, (found) => ({
            save: found,
            alongside: [
              { kind: "forget", merchantId: A, orderId: order.id, priceQuestion: priceId },
              { kind: "receipt", merchantId: "mch_nobody", receipt: aReceipt(order.id, "item") },
            ],
            result: null,
          })),
        ).rejects.toThrow();

        expect(await jobsCarrying(A, { kind: "order", payload: { id: order.id } })).toBe(2);
        expect(await jobsCarrying(A, { payload: { price_id: priceId } })).toBe(1);
      });
    });

    it("lets one gateway run the sweep and tells the other it is taken", async () => {
      // The lock must hold across processes: the overlap is two gateways, or
      // one handed its own job again after the queue's window ran out, so this
      // uses two stores on two pools. Without it both runs find the same
      // envelope missing and both send it, spending one of the order's
      // attempts, and closing at the attempt cap is a refund.
      const oneGateway = connect(databaseUrl, { max: 2 });
      const otherGateway = connect(databaseUrl, { max: 2 });
      const onePool = oneGateway.pool;
      const otherPool = otherGateway.pool;
      try {
        const one = PostgresStore.over(oneGateway.db, "eip155:84532", countedIds());
        const other = PostgresStore.over(otherGateway.db, "eip155:84532", countedIds());

        // The first is held inside the work, so the second arrives while it is
        // genuinely still running rather than after it.
        let letGo: () => void = () => undefined;
        const holding = new Promise<void>((resolve) => {
          letGo = resolve;
        });
        let started: () => void = () => undefined;
        const hasStarted = new Promise<void>((resolve) => {
          started = resolve;
        });

        const first = one.runAlone("a_test_sweep", async () => {
          started();
          await holding;
          return "the one that ran";
        });
        await hasStarted;

        const second = await other.runAlone("a_test_sweep", async () => "should not happen");
        expect(second).toStrictEqual({ ran: false });

        letGo();
        expect(await first).toStrictEqual({ ran: true, result: "the one that ran" });

        // A lock that leaked would silently stop every later sweep.
        expect(await other.runAlone("a_test_sweep", async () => "free again")).toStrictEqual({
          ran: true,
          result: "free again",
        });
      } finally {
        await onePool.end();
        await otherPool.end();
      }
    }, 30_000);

    it("does not pile a listener onto a connection every time it is handed out", async () => {
      // The error listener goes on at checkout and must come off at check-in,
      // or every query leaves one behind: Node warns past ten listeners on one
      // emitter, and a failing connection is then reported once per listener.
      // Twenty turns through one connection is twice that limit; the warning
      // is asserted on because it is what an operator would meet.
      const guarded = connect(databaseUrl, { max: 1 });
      const complaints: string[] = [];
      const noteIt = (warning: Error) => complaints.push(warning.name);
      process.on("warning", noteIt);
      try {
        for (let turn = 0; turn < 20; turn += 1) {
          await guarded.pool.query("select 1");
        }
        // Warnings are emitted on a later tick than the call that caused them.
        await new Promise((resolve) => setImmediate(resolve));
        expect(complaints.filter((name) => name === "MaxListenersExceededWarning")).toStrictEqual(
          [],
        );
      } finally {
        process.removeListener("warning", noteIt);
        await guarded.pool.end();
      }
    }, 30_000);

    it("survives the connection holding an order's transaction being terminated under it", async () => {
      // `withOrder` holds a pool client for the whole callback, and the client
      // sits idle while the runner arms the order's deadlines on pg-boss's own
      // pool. A backend terminated then (an administrator, a failover, a pooler
      // dropping an idle session) emits `error` on that client; with no
      // listener that is an uncaught exception and a dead process, on the path
      // that takes money. Checked: nothing reached Node unlistened, the caller
      // gets a failure, and the decision was not written.
      const owner = connect(databaseUrl, { max: 1 });
      const ownPool = owner.pool;
      try {
        const published = await store.publishCard(
          A,
          { ...syncCard, merchant_item_id: "cut-off-mid-decision" },
          now,
        );
        const offered = await gateway.beginPurchase(published.id, {});
        if (offered.step !== "pay") throw new Error("no price was offered");
        const orderId = offered.order.order.id;

        const own = PostgresStore.over(owner.db, "eip155:84532", countedIds());
        // One connection in the pool, so this is the one the transaction will
        // check out and the one terminated inside it.
        const pinned = await backendPid(ownPool);

        const unlistened = await whatWentUnlistened(async () => {
          const deciding = own.withOrder(orderId, async (found) => {
            await terminate(pinned);
            // Long enough for the client to notice and emit, with nothing in
            // flight on it.
            await new Promise((resolve) => setTimeout(resolve, 250));
            return { save: { ...found, paidBy: "whoever" }, result: "decided" };
          });

          // A named matcher, not a bare `toThrow()`: `terminate`'s own
          // complaint is rolled back and rethrown too, and would satisfy a bare
          // one with nothing terminated. The connection dying makes the
          // rollback fail, which leaves the store as a database failure
          // stripped of its parameters.
          await expect(deciding).rejects.toThrow(/the store's withOrder failed in the database/);
        });

        expect(unlistened).toStrictEqual([]);

        expect((await store.orderById(orderId))?.paidBy).toBeNull();

        // The pool drew a fresh connection rather than handing the broken one
        // back out, so the store still works.
        expect((await own.orderById(orderId))?.order.id).toBe(orderId);
      } finally {
        await ownPool.end();
      }
    }, 30_000);

    it("survives the connection holding the lock being terminated under it", async () => {
      // `runAlone` pins a connection and leaves it idle for the whole run, and
      // a checked-out client carries none of the pool's error listeners, so a
      // terminated backend would be an uncaught exception and a dead process,
      // taking every parked purchase and worker with it. Checked: nothing
      // reached Node unlistened, and the work's result comes back rather than
      // the unlock's failure from its `finally`, which would report a finished
      // sweep as failed and hand its work out again.
      //
      // One connection, in a pool of its own: nothing else's connection is
      // terminated, and the second run must draw the same client, so a broken
      // one put back in the pool is the one it gets.
      const owner = connect(databaseUrl, { max: 1 });
      const ownPool = owner.pool;
      try {
        const own = PostgresStore.over(owner.db, "eip155:84532", countedIds());
        // The pool holds one connection, so this is the one `runAlone` will
        // pin and the one terminated below.
        const pinned = await backendPid(ownPool);

        let ran: unknown;
        const unlistened = await whatWentUnlistened(async () => {
          ran = await own.runAlone("a_terminated_sweep", async () => {
            await terminate(pinned);
            // Long enough for the client to notice and emit.
            await new Promise((resolve) => setTimeout(resolve, 250));
            return "the work still finished";
          });
        });

        expect(unlistened).toStrictEqual([]);
        expect(ran).toStrictEqual({ ran: true, result: "the work still finished" });

        // The broken client was destroyed rather than handed back to the pool,
        // and the lock went with the backend.
        expect(await own.runAlone("a_terminated_sweep", async () => "free")).toStrictEqual({
          ran: true,
          result: "free",
        });
      } finally {
        await ownPool.end();
      }
    }, 30_000);

    it("gives back the work's own failure and not the connection's", async () => {
      // When the work fails and the unlock fails behind it, the work's reason
      // is the one returned and the connection's is logged; swapped, an
      // operator would find a database error in place of what went wrong.
      const owner = connect(databaseUrl, { max: 1 });
      const ownPool = owner.pool;
      try {
        const own = PostgresStore.over(owner.db, "eip155:84532", countedIds());
        const pinned = await backendPid(ownPool);

        const failing = own.runAlone("a_failing_terminated_sweep", async () => {
          await terminate(pinned);
          await new Promise((resolve) => setTimeout(resolve, 250));
          throw new Error("the sweep fell over on its own");
        });

        await expect(failing).rejects.toThrow("the sweep fell over on its own");
      } finally {
        await ownPool.end();
      }
    }, 30_000);

    it("lets go of the lock when the work it was holding for throws", async () => {
      // Held past a failure, the lock would stop every later sweep for the life
      // of the process. The second store has a pool of its own because
      // Postgres grants a session an advisory lock it already holds, so asking
      // on the same connection would succeed whether the first run let go or
      // not.
      const its = connect(databaseUrl, { max: 1 });
      const otherPool = its.pool;
      try {
        const other = PostgresStore.over(its.db, "eip155:84532", countedIds());

        await expect(
          store.runAlone("a_failing_sweep", async () => {
            throw new Error("the sweep fell over");
          }),
        ).rejects.toThrow("the sweep fell over");

        expect(await other.runAlone("a_failing_sweep", async () => "free")).toStrictEqual({
          ran: true,
          result: "free",
        });
      } finally {
        await otherPool.end();
      }
    }, 30_000);

    it("lets go of the name when the unlock fails on a connection that is still alive", async () => {
      // A terminated backend takes its locks with it, but an unlock that fails
      // on a live session (a statement timeout, SQLSTATE 57014) leaves the
      // name held by a client that goes back into the pool. Every later sweep
      // would skip with the same line a healthy skip logs, and the daily safety
      // net would be off with nothing saying so. The unlock is made to fail
      // directly rather than by racing a timeout; the session and its lock are
      // real, and the state is asked from a connection that shares nothing
      // with it.
      const held = connect(databaseUrl, { max: 1 });
      const asking = connect(databaseUrl, { max: 1 });
      try {
        const realConnect = held.pool.connect.bind(held.pool);
        Object.assign(held.pool, {
          connect: async () => {
            const client = await realConnect();
            const realQuery = client.query.bind(client);
            Object.assign(client, {
              query: (...args: Parameters<typeof realQuery>) => {
                if (typeof args[0] === "string" && args[0].includes("pg_advisory_unlock")) {
                  return Promise.reject(
                    Object.assign(new Error("canceling statement due to statement timeout"), {
                      code: "57014",
                    }),
                  );
                }
                return realQuery(...args);
              },
            });
            return client;
          },
        });

        const stubborn = PostgresStore.over(held.db, "eip155:84532", countedIds());
        // The run itself is a success and is reported as one. An unlock nobody
        // could complete is not the sweep's failure to hand back to the queue.
        expect(await stubborn.runAlone("a_wedged_sweep", async () => "swept")).toStrictEqual({
          ran: true,
          result: "swept",
        });

        // The pool ends the session the failed unlock ran on. Ending is
        // asynchronous, so this waits two seconds, well inside the ten the pool
        // takes to reap an idle connection: a window that reached the reaper
        // would pass even if the session were kept.
        const next = PostgresStore.over(asking.db, "eip155:84532", countedIds());
        const until = Date.now() + 2_000;
        let free = await next.runAlone("a_wedged_sweep", async () => "free");
        while (!free.ran && Date.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          free = await next.runAlone("a_wedged_sweep", async () => "free");
        }

        expect(free).toStrictEqual({ ran: true, result: "free" });
      } finally {
        await held.pool.end();
        await asking.pool.end();
      }
    }, 30_000);

    describe("the sweep of what an order is still owed", () => {
      const asyncCard: Card = {
        merchant_item_id: "swept-esim",
        title: "A seven day eSIM",
        description: "Seven days of data",
        price: { amount: "12.00", currency: "USD" },
        result: { activation_code: { type: "string" } },
        fulfillment: "async",
        fulfill_deadline_seconds: 3_600,
      };

      beforeEach(async () => {
        // The sweep asks about every order, so earlier tests' orders would be
        // counted too.
        await pool.query("truncate table receipts, orders");
        // Earlier tests' envelopes are still on the stream, and these tests
        // count what arrives.
        await queue.draw(A, 100, 0);
      });

      it("commits recovered late payment and its debt event together without a fulfillment handover", async () => {
        const card = await store.publishCard(
          A,
          { ...asyncCard, merchant_item_id: "recovered-late", fulfill_deadline_seconds: 1 },
          now,
        );
        const offered = await gateway.beginPurchase(card.id, {});
        if (offered.step !== "pay") throw new Error("no price was offered");
        const orderId = offered.order.order.id;
        facilitator.willSettle({ settled: "unknown", reason: "response lost" });
        try {
          await gateway.runner.presentVerifiedPayment(
            orderId,
            "payer",
            "authorization",
            PAID_AT,
            now,
          );
          const attempt = (await store.orderById(orderId))?.paymentAttempt;
          if (attempt === undefined) throw new Error("no submitted attempt");
          const executedAt = now;
          now += 2000;
          const proof = { settled: true as const, transaction: `0x${"a".repeat(64)}`, executedAt };
          const publish = queue.publishWithin.bind(queue);
          queue.publishWithin = async () => {
            throw new Error("debt event write interrupted");
          };
          try {
            await expect(
              gateway.runner.completePaymentAttempt(orderId, attempt.id, proof, "chain"),
            ).rejects.toThrow();
            expect((await store.orderById(orderId))?.order.payment).toBe("settling");
            expect((await store.orderById(orderId))?.paymentAttempt?.completion).toBeNull();
            expect(await queue.draw(A, 100, 0)).toEqual([]);
          } finally {
            queue.publishWithin = publish;
          }
          await gateway.runner.completePaymentAttempt(orderId, attempt.id, proof, "chain");
          await gateway.runner.completePaymentAttempt(orderId, attempt.id, proof, "chain");
          expect((await store.orderById(orderId))?.order.state).toBe("unfulfilled");
          expect((await queue.draw(A, 100, 0)).map((delivery) => delivery.envelope.kind)).toEqual([
            "order_event",
          ]);
          expect(await store.receiptForOrder(orderId)).toBeNull();
        } finally {
          facilitator.willSettle();
        }
      });

      it("is a no-op on the second run once the first has been acted on", async () => {
        // Two of the three arms are no-ops on a second run for a reason in the
        // orders themselves: an order with a receipt is not missing one, and an
        // order the merchant has taken is not sitting in paid.
        const card = await store.publishCard(A, asyncCard, now);
        const offered = await gateway.beginPurchase(card.id, {});
        if (offered.step !== "pay") throw new Error("no price was offered");
        const orderId = offered.order.order.id;

        const paid = `swept-${randomUUID()}`;
        await gateway.runner.presentVerifiedPayment(orderId, paid, paid, PAID_AT, now);
        expect((await store.orderById(orderId))?.order.state).toBe("paid");

        // The envelope this sale wrote is drawn off and thrown away: the
        // dispatch commits with the order, so the state the sweep exists for
        // has to be arranged.
        expect(await queue.draw(A, 10, 2_000)).toHaveLength(1);

        now += gateway.runtime.config.sweepDispatchGraceMs + 60_000;

        const first = await gateway.runner.sweep();
        // Nothing else is running it, so it ran. `null` is how a run says it
        // found the work already in somebody else's hands.
        expect(first).not.toBeNull();
        expect(first?.dispatched).toBe(1);
        expect(first?.refused).toBe(0);

        const worker = workUntilStopped(
          { gateway, merchant: { id: A, name: "", key: "", keyId: "", wallet: "" } },
          { onOrder: () => ({ accepted: {} }) },
        );
        await vi.waitFor(async () => {
          expect((await store.orderById(orderId))?.order.state).toBe("dispatched");
        });
        await worker.stop();

        const second = await gateway.runner.sweep();
        expect(second).toStrictEqual({ dispatched: 0, receipted: 0, rearmed: 0, refused: 0 });
      }, 30_000);

      it("writes the receipt a delivered order has none of, once", async () => {
        const card = await store.publishCard(A, { ...asyncCard, merchant_item_id: "swept-r" }, now);
        const offered = await gateway.beginPurchase(card.id, {});
        if (offered.step !== "pay") throw new Error("no price was offered");
        const orderId = offered.order.order.id;

        const paid = `swept-r-${randomUUID()}`;
        await gateway.runner.presentVerifiedPayment(orderId, paid, paid, PAID_AT, now);
        const worker = workUntilStopped(
          { gateway, merchant: { id: A, name: "", key: "", keyId: "", wallet: "" } },
          { onOrder: () => ({ delivered: { activation_code: "CODE" } }) },
        );
        await vi.waitFor(async () => {
          expect((await store.orderById(orderId))?.order.state).toBe("delivered");
        });
        await worker.stop();

        // A delivered order without a receipt, as a record written by an
        // older version of this code looks.
        await pool.query("delete from receipts where order_id = $1", [orderId]);
        expect(await store.receiptForOrder(orderId)).toBeNull();

        const first = await gateway.runner.sweep();
        expect(first?.receipted).toBe(1);
        const written = await store.receiptForOrder(orderId);
        expect(written?.outcome).toBe("delivered");

        const second = await gateway.runner.sweep();
        expect(second?.receipted).toBe(0);
        expect(await store.receiptForOrder(orderId)).toStrictEqual(written);
      }, 30_000);
    });

    describe("the registry of payout splits", () => {
      const network = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532");
      const W1 = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
      const W2 = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
      const splitOf = (merchantId: string, wallet: string) =>
        payoutSplitFor(network, merchantId, wallet);
      /** A's wallet paid now, the one `beforeEach` sets, and its split. */
      const PAID_NOW = "0x0000000000000000000000000000000000000001";

      // Every case here starts from this suite's merchant alone: the cases
      // above leave rows behind, and a recorded split can be emptied only by
      // a truncate.
      beforeEach(async () => {
        await pool.query(EMPTY_EVERY_TABLE);
        await theMerchantOfThisSuite();
      });

      /**
       * The error a call was refused with. An error and not just a rejection:
       * `rejects.toThrow` passes on a rejection with nothing in it.
       */
      const refusal = async (work: Promise<unknown>): Promise<Error> => {
        try {
          await work;
        } catch (thrown) {
          expect(thrown).toBeInstanceOf(Error);
          return thrown as Error;
        }
        throw new Error("nothing was refused, and being refused is what this is about");
      };

      const rowsOf = async (merchantId: string) =>
        (
          await pool.query(
            "select * from payout_splits where merchant_id = $1 order by recorded_at, address",
            [merchantId],
          )
        ).rows;

      const merchantRow = async (merchantId: string) =>
        (
          await pool.query(
            `select payout_wallet, pending_payout_wallet, pending_payout_wallet_from, updated_at
             from merchants where id = $1`,
            [merchantId],
          )
        ).rows;

      it("leaves the wallet as it was when its split cannot be written, and writes no split either", async () => {
        // A wallet saved without its split is a merchant who cannot sell, and
        // under a later mistake a payment address with no parameters anywhere.
        await pool.query(
          `alter table payout_splits add constraint refuse_the_wallet check (merchant_wallet <> '${W1}')`,
        );
        try {
          const before = await merchantRow(A);
          const refused = await refusal(
            store.setPayoutWallet(
              A,
              { address: PAID_NOW, pending: null },
              { address: W1, split: splitOf(A, W1), pending: null },
              now + 1_000,
            ),
          );
          expect(refused.message).toMatch(/refuse_the_wallet/);
          expect(await merchantRow(A)).toStrictEqual(before);
          expect(await store.payoutSplitAt(splitOf(A, W1).address)).toBeNull();

          // Another wallet goes through, both halves of it.
          await store.setPayoutWallet(
            A,
            { address: PAID_NOW, pending: null },
            { address: W2, split: splitOf(A, W2), pending: null },
            now + 2_000,
          );
          expect((await merchantRow(A))[0]?.payout_wallet).toBe(W2);
          expect(await store.payoutSplitAt(splitOf(A, W2).address)).not.toBeNull();
        } finally {
          await pool.query("alter table payout_splits drop constraint refuse_the_wallet");
        }
      });

      it("refuses to change or delete a recorded split, whoever asks", async () => {
        // The parameters of a split nobody has deployed exist only here; a row
        // rewritten or removed by hand strands whatever was paid to it.
        const [before] = await rowsOf(A);
        expect(before).toBeDefined();

        for (const change of [
          "update payout_splits set commission_wallet = merchant_wallet",
          "update payout_splits set recorded_at = now()",
          "delete from payout_splits",
          `insert into payout_splits select * from payout_splits
           on conflict (network, merchant_id, lower(merchant_wallet)) do update set salt = excluded.salt`,
        ]) {
          expect((await refusal(pool.query(change))).message, change).toMatch(
            /never changed or deleted/,
          );
        }
        expect(await rowsOf(A)).toStrictEqual([before]);

        // Recording the same row again is a no-op, not a change.
        await pool.query(
          "insert into payout_splits select * from payout_splits on conflict do nothing",
        );
        expect(await rowsOf(A)).toStrictEqual([before]);
      });

      it("keeps one split for one merchant and wallet on one network, and one row for one address, each in either spelling", async () => {
        // Two rows for one wallet would leave the payment address and the
        // payout instruction free to name two different contracts; a second
        // spelling of one address is the same contract, and of one wallet the
        // same wallet.
        const other = { ...network, commissionWallet: W2 };
        const second = payoutSplitFor(other, A, PAID_NOW);
        expect((await refusal(store.recordPayoutSplits([second], now))).message).toMatch(
          /recorded/,
        );
        // At another address, so that only the key on the wallet can refuse it.
        const anotherCommission = await refusal(
          pool.query(
            `insert into payout_splits
             select $1, network, merchant_id, merchant_wallet, $2, merchant_allocation,
                    commission_allocation, total_allocation, distribution_incentive, owner, salt,
                    factory, recorded_at
             from payout_splits where merchant_id = $3`,
            [splitOf("mch_elsewhere", PAID_NOW).address, W2, A],
          ),
        );
        expect(anotherCommission).toMatchObject({
          code: "23505",
          constraint: "payout_splits_wallet_unique",
        });
        await store.recordPayoutSplits([splitOf("mch_lettered", W1)], now);
        const theWalletInLowerCase = await refusal(
          pool.query(
            `insert into payout_splits
             select $1, network, merchant_id, lower(merchant_wallet), commission_wallet,
                    merchant_allocation, commission_allocation, total_allocation,
                    distribution_incentive, owner, salt, factory, recorded_at
             from payout_splits where merchant_id = 'mch_lettered'`,
            [splitOf("mch_lettered", W2).address],
          ),
        );
        expect(theWalletInLowerCase).toMatchObject({
          code: "23505",
          constraint: "payout_splits_wallet_unique",
        });
        const anotherSpelling = await refusal(
          pool.query(
            `insert into payout_splits
             select lower(address), network, 'mch_another', merchant_wallet, commission_wallet,
                    merchant_allocation, commission_allocation, total_allocation,
                    distribution_incentive, owner, salt, factory, recorded_at
             from payout_splits where merchant_id = $1`,
            [A],
          ),
        );
        expect(anotherSpelling).toMatchObject({
          code: "23505",
          constraint: "payout_splits_address_unique",
        });
        expect(await rowsOf(A)).toHaveLength(1);
      });

      /** A gateway of its own over this database, with nothing in memory but its queue. */
      const aGatewayOn = (db: Database, table = PAYOUT_SPLIT_NETWORKS) => {
        const config = loadConfig({ DATABASE_URL: databaseUrl }, table);
        return new Gateway({
          config,
          store: PostgresStore.over(db, "eip155:84532", countedIds()),
          queue: new MemoryQueue(),
          facilitator: new ScriptedFacilitator(),
          clock: () => now,
          ids: countedIds(),
          announcer: nobodyAnnounces,
          widestChallenge: widestChallengeOn(config),
        });
      };

      /** Merchants whose wallets were written with no split recorded. */
      const withoutTheirSplits = async () => {
        await store.addMerchant({ id: "mch_old_one", name: "Old one" }, now);
        await store.addMerchant({ id: "mch_old_two", name: "Old two" }, now);
        await store.addMerchant({ id: "mch_old_none", name: "Old none" }, now);
        await pool.query("update merchants set payout_wallet = $1 where id = 'mch_old_one'", [W1]);
        await pool.query(
          `update merchants set payout_wallet = $1, pending_payout_wallet = $2,
             pending_payout_wallet_from = $3 where id = 'mch_old_two'`,
          [W1, W2, new Date(now + 3_600_000)],
        );
        await store.addOrder({
          ...anOrder("ord_old", "delivered", { merchantId: "mch_old_one", createdAt: now - 5_000 }),
          payTo: W1,
        });
      };

      it("gives every wallet found without a split its split at start, and touches no merchant and no order", async () => {
        // The SQL migration cannot compute a hash, so the rows come from the
        // start; a merchant left without one cannot sell after the release.
        await withoutTheirSplits();
        const merchantsBefore = (await pool.query("select * from merchants order by id")).rows;
        const ordersBefore = (await pool.query("select * from orders order by id")).rows;

        const logged = await loggedWhile(() => aGatewayOn(contract.db).start());

        expect((await rowsOf("mch_old_one")).map((row) => row.address)).toStrictEqual([
          splitOf("mch_old_one", W1).address,
        ]);
        expect((await rowsOf("mch_old_two")).map((row) => row.address).sort()).toStrictEqual(
          [splitOf("mch_old_two", W1).address, splitOf("mch_old_two", W2).address].sort(),
        );
        expect(await rowsOf("mch_old_none")).toStrictEqual([]);
        expect((await pool.query("select * from merchants order by id")).rows).toStrictEqual(
          merchantsBefore,
        );
        expect((await pool.query("select * from orders order by id")).rows).toStrictEqual(
          ordersBefore,
        );
        expect(logged).toMatch(/recorded 3 payout splits/);
      });

      it("records each split once when two gateways start on one database at once, and again writes nothing", async () => {
        // A restart, a retried release and two processes on one database must
        // neither duplicate a row nor fail to start.
        await withoutTheirSplits();

        const another = connect(databaseUrl);
        try {
          await Promise.all([aGatewayOn(contract.db).start(), aGatewayOn(another.db).start()]);
        } finally {
          await another.pool.end();
        }
        const first = (await pool.query("select * from payout_splits order by address")).rows;
        await aGatewayOn(contract.db).start();

        expect(first.filter((row) => row.merchant_id.startsWith("mch_old_"))).toHaveLength(3);
        expect(
          (await pool.query("select * from payout_splits order by address")).rows,
        ).toStrictEqual(first);
      });

      it("refuses to start on a recorded split of a wallet the wallet rule refuses, naming its merchant, and records none for one found without", async () => {
        // A split of Multicall3 recorded before the start held wallets to the
        // rule would be paid out to it; a wallet found without a split gets
        // none and its merchant cannot sell until they set another.
        await store.addMerchant({ id: "mch_recorded", name: "Recorded" }, now);
        await store.addMerchant({ id: "mch_found", name: "Found" }, now);
        await pool.query("update merchants set payout_wallet = $1 where id = 'mch_found'", [
          network.multicall3,
        ]);
        const logged = await loggedWhile(() => aGatewayOn(contract.db).start());
        expect(logged).toMatch(/mch_found\b.*\bmulticall3\b/);
        expect(await rowsOf("mch_found")).toStrictEqual([]);

        await pool.query(
          `insert into payout_splits values ($1, $2, 'mch_recorded', $3, $4, $5, $6, $7, 0, $8, $9, $10, now())`,
          ((split) => [
            split.address,
            split.network,
            split.merchantWallet,
            split.commissionWallet,
            split.merchantAllocation,
            split.commissionAllocation,
            split.totalAllocation,
            split.owner,
            split.salt,
            split.factory,
          ])(splitOf("mch_recorded", network.multicall3)),
        );
        await pool.query("update merchants set payout_wallet = $1 where id = 'mch_recorded'", [
          network.multicall3,
        ]);
        await expect(aGatewayOn(contract.db).start()).rejects.toThrow(/mch_recorded/);
      });

      it("records at once more splits than one statement could carry", async () => {
        // Thirteen columns a row and at most 65,535 values a statement: a
        // start over five thousand wallets without splits sent as one
        // statement would be refused on every attempt.
        const many = Array.from({ length: 6_000 }, (_, at) => splitOf(`mch_bulk_${at}`, W1));

        const recorded = await store.recordPayoutSplits(many, now);

        expect(recorded).toHaveLength(6_000);
        const [counted] = (
          await pool.query(
            "select count(*)::int as n from payout_splits where merchant_id like 'mch_bulk_%'",
          )
        ).rows;
        expect(counted?.n).toBe(6_000);
      });

      it("says why when the splits a start lacks cannot be recorded, and not that the database did not answer", async () => {
        await withoutTheirSplits();
        await pool.query(
          `alter table payout_splits add constraint refuse_the_wallet check (merchant_wallet <> '${W1}')`,
        );
        try {
          const config = loadConfig({
            DATABASE_URL: databaseUrl,
            FACILITATOR_URL: "sandbox:scripted",
          });

          let refused: unknown;
          const logged = await loggedWhile(async () => {
            refused = await startGateway(config, nobodyAnnounces).then(
              async (started) => {
                await started.stop();
                return null;
              },
              (thrown: unknown) => thrown,
            );
          });

          expect(refused).toBeInstanceOf(Error);
          expect(logged).toMatch(/payout split/);
          expect(logged).toMatch(/refuse_the_wallet/);
          expect(logged).not.toMatch(/did not answer/);
        } finally {
          await pool.query("alter table payout_splits drop constraint refuse_the_wallet");
        }
      });

      describe("on a deployment of another network than the test chain", () => {
        const base = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:8453");
        const MERCHANT = "mch_on_base";

        /**
         * A CDP API key of the shape the signer takes, made here and never
         * written down. It opens nothing: a start signs with it and shows it
         * to the stand-in for Coinbase below, and nothing here speaks to
         * Coinbase.
         */
        const anApiKeySecret = (): string => {
          const { privateKey, publicKey } = generateKeyPairSync("ed25519");
          const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
          const key = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
          return Buffer.concat([seed, key]).toString("base64");
        };

        /** The live deployment on Base, under the fixture's commission wallet. */
        const onBase = () =>
          loadConfig({
            DATABASE_URL: databaseUrl,
            PAYMENT_NETWORK: "eip155:8453",
            FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
            CDP_API_KEY_ID: "key-id",
            CDP_API_KEY_SECRET: anApiKeySecret(),
          });

        /**
         * A registry holding nothing of the test chain, and a merchant paid at
         * W1. A start asks Coinbase whether it takes the key, and the answer
         * here is the one Coinbase gives a key it knows: the empty payment
         * turned down as a bad request.
         */
        beforeEach(async () => {
          await pool.query(EMPTY_EVERY_TABLE);
          await store.addMerchant({ id: MERCHANT, name: "On Base" }, now);
          await pool.query("update merchants set payout_wallet = $1 where id = $2", [W1, MERCHANT]);
          vi.stubGlobal(
            "fetch",
            async () =>
              new Response(JSON.stringify({ errorType: "invalid_request" }), { status: 400 }),
          );
        });

        afterEach(async () => {
          vi.unstubAllGlobals();
          await pool.query("drop schema if exists pgboss cascade");
        });

        it("starts, and reads each wallet's split on that network", async () => {
          // Opened for the test chain instead, every live merchant's split
          // would read as missing and nothing would sell.
          const started = await startGateway(onBase(), nobodyAnnounces);
          try {
            started.closeListener();
            expect((await started.application.payoutSplitsOf(MERCHANT)).inForce?.address).toBe(
              payoutSplitFor(base, MERCHANT, W1).address,
            );
          } finally {
            await started.stop();
          }
        });

        it("opens a command's application that reads each wallet's split on that network", async () => {
          // WooCommerce recovery uses this writing command application.
          await store.recordPayoutSplits([payoutSplitFor(base, MERCHANT, W1)], now);

          const opened = await openCommandApplication(onBase());
          try {
            expect((await opened.application.payoutSplitsOf(MERCHANT)).inForce?.address).toBe(
              payoutSplitFor(base, MERCHANT, W1).address,
            );
          } finally {
            await opened.close();
          }
        });
      });

      it("refuses to start where the code's commission wallet is not the one recorded, before it listens", async () => {
        // The edit is refused in words in the log, and nothing the start would
        // write is written first.
        await withoutTheirSplits();
        const edited = {
          ...PAYOUT_SPLIT_NETWORKS,
          "eip155:84532": { ...network, commissionWallet: W2 },
        };
        const config = loadConfig(
          { DATABASE_URL: databaseUrl, FACILITATOR_URL: "sandbox:scripted" },
          edited,
        );

        let refused: unknown;
        const logged = await loggedWhile(async () => {
          refused = await startGateway(config, nobodyAnnounces).then(
            async (started) => {
              await started.stop();
              return null;
            },
            (thrown: unknown) => thrown,
          );
        });

        expect(String(refused)).toMatch(/commission wallet or the rate/);
        expect(logged).toMatch(/commission wallet or the rate/);
        expect(logged).not.toMatch(/did not answer/);
        expect(await rowsOf("mch_old_one")).toStrictEqual([]);
      });
    });

    describeWalletSpelling(
      "a wallet stored in another spelling than its split, on Postgres",
      async (network) => {
        await contract.pool.query(EMPTY_EVERY_TABLE);
        return {
          store: PostgresStore.over(contract.db, network, countedIds()),
          writeWalletWithoutSplit: async (merchantId, wallet) => {
            await contract.pool.query(
              `update merchants set payout_wallet = $2, pending_payout_wallet = $3,
                 pending_payout_wallet_from = $4 where id = $1`,
              [
                merchantId,
                wallet.address,
                wallet.pending?.address ?? null,
                wallet.pending === null ? null : new Date(wallet.pending.takesEffectAt),
              ],
            );
          },
        };
      },
    );

    /**
     * Everything both stores promise, against the one a merchant's money rests
     * on. Inside this suite because it needs the database, pools and emptied
     * tables `beforeAll` builds; as a sibling it would run after the pools had
     * ended.
     *
     * A store and pool of its own: this file's store shares a pool with a
     * started gateway whose pg-boss workers are polling and writes envelopes
     * onto a real stream, and the contract's transactions and truncates must
     * not run among that work. Each case empties every table, merchants
     * included; the next case in this file gets them back from its
     * `beforeEach`.
     */
    describeStore("the store on Postgres", async () => {
      await contract.pool.query(EMPTY_EVERY_TABLE);
      return PostgresStore.over(contract.db, "eip155:84532", countedIds());
    });
  });
}

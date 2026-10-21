/**
 * Reporting to the ad tracker, against PostgreSQL, because what holds the
 * reports together is the database's: a row taken by one turn only, one lock
 * across every process, which spaces the posts out, and a merchant's first
 * card as the gateway's own table records it. The tracker is a function
 * standing in for `fetch`, the clock and the pauses are the test's, and nothing
 * leaves this machine.
 */

import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  connect,
  Gateway,
  type Integration,
  MemoryQueue,
  nobodyAnnounces,
  PostgresStore,
  randomIds,
  ScriptedFacilitator,
  setPayoutWallet,
  widestChallengeOn,
} from "@agentify/gateway";
import { testConfig } from "@agentify/gateway/testing";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import type { Card } from "@nuanu-ai/agentify-contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportOnce, startAdReports } from "./ad-reports.js";
import { loadConfig } from "./config.js";
import { migrateAccounts } from "./database.js";
import { identityFor } from "./identity.js";
import type { Message } from "./mail.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_dashboard_ad_reports";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);
const here = dirname(fileURLToPath(import.meta.url));
const migrationsIn = join(here, "..", "drizzle");
const gatewayMigrationsIn = join(here, "..", "..", "gateway", "drizzle");

const ENDPOINT = "http://127.0.0.1:4010/postback";
const KEY = ["qa", "synthetic", "postback", "key"].join("-");
const TARGET = { endpoint: ENDPOINT, key: KEY } as const;
const CLICKS = [
  "qa_click_0123456789abcdef",
  "qa_click_1123456789abcdef",
  "qa_click_2123456789abcdef",
] as const;
const [CLICK = ""] = CLICKS;
const START = new Date("2026-10-15T09:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** What the tracker was asked, as it would read it. */
interface Received {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: [string, string][];
  readonly body: unknown;
  readonly redirect: RequestRedirect | undefined;
  /** The test clock's reading when the post arrived. */
  readonly at: number;
}

/** The answer a tracker gives one post: a status, or a failure to answer. */
type Answer = number | "timeout" | "network error" | "silence";

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));
  describe("reporting registrations to the ad tracker", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  // A second process, with connections of its own.
  const otherPool = new Pool({ connectionString: databaseUrl, max: 4 });

  // The schema whole, functions included: the gateway's migrations make some.
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query("drop schema if exists drizzle cascade");
  // The gateway's tables too: a turn reads a merchant's first card from them.
  await migrate(drizzle(pool), { migrationsFolder: gatewayMigrationsIn });
  await migrateAccounts(pool, migrationsIn);

  // The gateway's store and application over the same database, so a card is
  // published the way the API and the WooCommerce import publish one.
  const gatewayDatabase = connect(databaseUrl);

  afterAll(async () => {
    await Promise.all([pool.end(), otherPool.end(), gatewayDatabase.pool.end()]);
  });

  /** The test's clock, moved by the pauses the code asks for and by the tests. */
  let clock = START.getTime();
  const now = (): Date => new Date(clock);
  const pausing = new Set<Promise<void>>();
  /**
   * A pause moves the clock only once a little real time has passed, so a
   * second loop that is not held back by the lock gets to post inside it.
   */
  const wait = (ms: number): Promise<void> => {
    const pause = (async () => {
      await sleep(5);
      clock += ms;
    })();
    pausing.add(pause);
    void pause.finally(() => pausing.delete(pause));
    return pause;
  };

  /** Everything any part of the process wrote to the console during a test. */
  let told: string[] = [];

  beforeEach(async () => {
    clock = START.getTime();
    told = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...said: unknown[]) => {
        told.push(said.map(String).join(" "));
      });
    }
    await pool.query("delete from dashboard_accounts");
    await pool.query("delete from cards");
    await pool.query("delete from merchants");
  });

  afterEach(async () => {
    // Stopping a loop cuts its idle short but not the pause it asked for, which
    // still moves the clock a moment later; that has to happen before the next
    // test resets the clock.
    await Promise.all(pausing);
    // Nothing about whose registration it was, and never the key, in any line
    // any of these tests made the code write.
    for (const line of told) {
      // Every click these tests plant has this form, the listed ones and any
      // planted by one test alone.
      expect(line).not.toMatch(/qa_click_/);
      expect(line).not.toContain(KEY);
      expect(line).not.toMatch(/@example\.com/);
      expect(line).not.toMatch(/acc_report_/);
    }
    vi.restoreAllMocks();
  });

  /** A tracker that gives the answers in turn, then 200 to everything after. */
  const tracker = (...answers: Answer[]) => {
    const received: Received[] = [];
    const post = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      received.push({
        url: String(input),
        method: init?.method,
        headers: [...new Headers(init?.headers)],
        body: init?.body,
        redirect: init?.redirect,
        at: clock,
      });
      const answer = answers.shift() ?? 200;
      if (answer === "timeout") {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      if (answer === "network error") {
        throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
      }
      if (answer === "silence") {
        // Answers nothing, ever; only the request's own deadline ends it.
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }
      return new Response(null, { status: answer });
    };
    return { post: post as typeof fetch, received };
  };

  let accounts = 0;
  /**
   * An account and its pending registration, as opening a link asked for with
   * an ad's click leaves them, made `createdAgoMs` before the test clock.
   */
  const registered = async (click: string, createdAgoMs = 0): Promise<string> => {
    accounts += 1;
    const id = `acc_report_${accounts}`;
    const created = new Date(clock - createdAgoMs);
    await pool.query(
      "insert into dashboard_accounts (id, email, email_verified, name, created_at, updated_at)" +
        " values ($1, $2, true, '', $3, $3)",
      [id, `person-${accounts}@example.com`, created],
    );
    await pool.query(
      `insert into dashboard_ad_reports
         (account_id, event, click_id, state, attempts, next_attempt_at, created_at, event_at)
       values ($1, 'reg', $2, 'pending', 0, $3, $3, $3)`,
      [id, click, created],
    );
    return id;
  };

  interface Row {
    readonly account_id: string;
    readonly click_id: string | null;
    readonly state: string;
    readonly attempts: number;
    readonly next_attempt_at: Date | null;
    readonly last_outcome: string | null;
    readonly settled_at: Date | null;
  }

  const rows = async (): Promise<Row[]> =>
    (
      await pool.query<Row>(
        `select account_id, click_id, state, attempts, next_attempt_at, last_outcome, settled_at
           from dashboard_ad_reports where event = 'reg' order by account_id`,
      )
    ).rows;

  const onlyRow = async (): Promise<Row> => {
    const all = await rows();
    expect(all).toHaveLength(1);
    const [row] = all;
    if (row === undefined) throw new Error("there is no registration");
    return row;
  };

  /** Moves the clock to the moment the one registration is next due. */
  const untilDue = async (): Promise<void> => {
    const row = await onlyRow();
    if (row.next_attempt_at === null) throw new Error("the registration is not scheduled");
    clock = row.next_attempt_at.getTime();
  };

  const until = async (condition: () => boolean, within = 20_000): Promise<void> => {
    const deadline = Date.now() + within;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("the condition did not come about in time");
      await sleep(10);
    }
  };

  describe("reporting a registration to the ad tracker", () => {
    it("posts the click and the word reg to the endpoint with the key, and nothing else", async () => {
      await registered(CLICK);
      const { post, received } = tracker(200);

      expect(
        await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait }),
      ).toBe(true);

      expect(received).toHaveLength(1);
      const [request] = received;
      expect(request?.url).toBe(ENDPOINT);
      expect(request?.method).toBe("POST");
      expect(request?.headers.sort()).toStrictEqual([
        ["content-type", "application/json"],
        ["x-postback-key", KEY],
      ]);
      expect(request?.body).toBe(`{"clickid":"${CLICK}","event":"reg"}`);
      // A redirect is answered as what it is rather than followed somewhere the
      // key was never meant to go.
      expect(request?.redirect).toBe("manual");
    });

    it("marks a report the tracker took as delivered and erases the click", async () => {
      const account = await registered(CLICK);
      const { post } = tracker(200);

      await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });

      expect(await onlyRow()).toMatchObject({
        account_id: account,
        click_id: null,
        state: "delivered",
        attempts: 1,
        last_outcome: "http_200",
        settled_at: START,
      });
    });

    it("takes nothing when no report is due, and posts nothing", async () => {
      const { post, received } = tracker();

      expect(
        await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait }),
      ).toBe(false);

      expect(received).toStrictEqual([]);
    });

    for (const [failure, outcome] of [
      [429, "http_429"],
      [500, "http_500"],
      [503, "http_503"],
      ["timeout", "timeout"],
      ["network error", "network_error"],
    ] as const) {
      it(`tries again after ${outcome}, and the one row ends delivered once the tracker answers`, async () => {
        await registered(CLICK);
        const { post, received } = tracker(failure, 200);

        await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });
        const waiting = await onlyRow();
        expect(waiting).toMatchObject({
          click_id: CLICK,
          state: "pending",
          attempts: 1,
          last_outcome: outcome,
          settled_at: null,
        });
        expect(waiting.next_attempt_at?.getTime()).toBe(START.getTime() + MINUTE);

        // Not yet due: nothing is posted before the minute is up.
        clock = START.getTime() + MINUTE - 1;
        expect(
          await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait }),
        ).toBe(false);
        expect(received).toHaveLength(1);

        await untilDue();
        const recovered = clock;
        await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });

        expect(received).toHaveLength(2);
        expect(received[1]?.body).toBe(received[0]?.body);
        expect(await onlyRow()).toMatchObject({
          click_id: null,
          state: "delivered",
          attempts: 2,
          last_outcome: "http_200",
          settled_at: new Date(recovered),
        });
        expect(
          await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait }),
        ).toBe(false);
        expect(received).toHaveLength(2);
      });
    }

    it("cuts off a tracker that never answers at five seconds, and tries again later", async () => {
      await registered(CLICK);
      const { post } = tracker("silence");
      const began = performance.now();

      await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });

      const took = performance.now() - began;
      expect(took).toBeGreaterThanOrEqual(4_900);
      expect(took).toBeLessThan(8_000);
      expect(await onlyRow()).toMatchObject({
        click_id: CLICK,
        state: "pending",
        last_outcome: "timeout",
      });
    }, 20_000);

    it("waits longer after each failure: a minute, five, thirty, two hours, then six hours each time", async () => {
      await registered(CLICK);
      const { post, received } = tracker(500, 500, 500, 500, 500, 500, 500);
      const waits: number[] = [];

      for (let attempt = 0; attempt < 7; attempt += 1) {
        await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });
        const row = await onlyRow();
        waits.push((row.next_attempt_at?.getTime() ?? 0) - (received.at(-1)?.at ?? 0));
        await untilDue();
      }

      expect(waits).toStrictEqual([
        MINUTE,
        5 * MINUTE,
        30 * MINUTE,
        2 * HOUR,
        6 * HOUR,
        6 * HOUR,
        6 * HOUR,
      ]);
    });

    it("gives up once the next try would fall a day or more after the registration, and erases the click", async () => {
      await registered(CLICK);
      const { post, received } = tracker(...Array<Answer>(20).fill(503));

      for (let turn = 0; turn < 20 && (await onlyRow()).state === "pending"; turn += 1) {
        await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });
        if ((await onlyRow()).state === "pending") await untilDue();
      }

      // Failures at 0, 1m, 6m, 36m, 2h36m, 8h36m, 14h36m and 20h36m; the
      // ninth try would be at 26h36m.
      expect(received).toHaveLength(8);
      expect(received.at(-1)?.at ?? 0).toBeLessThan(START.getTime() + 24 * HOUR);
      expect(await onlyRow()).toMatchObject({
        click_id: null,
        state: "given_up",
        attempts: 8,
        last_outcome: "http_503",
      });
      expect((await onlyRow()).settled_at).not.toBeNull();
    });

    it("gives up rather than schedule a try for the very moment the day ends", async () => {
      const account = await registered(CLICK, 18 * HOUR);
      // Four failures behind it, so the next wait is six hours: to the
      // millisecond a day after the registration.
      await pool.query("update dashboard_ad_reports set attempts = 4 where account_id = $1", [
        account,
      ]);
      const { post } = tracker(503);

      await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });

      expect(await onlyRow()).toMatchObject({
        click_id: null,
        state: "given_up",
        attempts: 5,
        last_outcome: "http_503",
      });
    });

    it("gives up without posting a report found a day or more after the registration", async () => {
      await registered(CLICK, 24 * HOUR);
      const { post, received } = tracker(200);

      expect(
        await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait }),
      ).toBe(true);

      expect(received).toStrictEqual([]);
      expect(await onlyRow()).toMatchObject({
        click_id: null,
        state: "given_up",
        attempts: 0,
        last_outcome: null,
        settled_at: START,
      });
    });

    it("keeps the last failure's outcome on a report given up a day after the registration", async () => {
      // The outcome is what the tracker last answered; the end of the window
      // is said by the state and when it settled.
      const account = await registered(CLICK, 24 * HOUR);
      await pool.query(
        "update dashboard_ad_reports set attempts = 2, last_outcome = 'http_503' where account_id = $1",
        [account],
      );
      const { post, received } = tracker(200);

      await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });

      expect(received).toStrictEqual([]);
      expect(await onlyRow()).toMatchObject({
        click_id: null,
        state: "given_up",
        attempts: 2,
        last_outcome: "http_503",
        settled_at: START,
      });
    });

    it("still posts a report found just under a day after the registration", async () => {
      await registered(CLICK, 24 * HOUR - 1);
      const { post, received } = tracker(200);

      await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });

      expect(received).toHaveLength(1);
      expect((await onlyRow()).state).toBe("delivered");
    });

    for (const status of [302, 400, 401, 403, 404, 422, 204]) {
      it(`marks a report the tracker answered ${status} as refused, erases the click and never posts it again`, async () => {
        await registered(CLICK);
        const { post, received } = tracker(status);

        await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });
        clock += 48 * HOUR;
        expect(
          await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait }),
        ).toBe(false);

        expect(received).toHaveLength(1);
        expect(await onlyRow()).toMatchObject({
          click_id: null,
          state: "refused",
          attempts: 1,
          last_outcome: `http_${status}`,
          settled_at: START,
        });
      });
    }

    it("posts two due reports at least 1.1 seconds apart", async () => {
      await registered(CLICKS[0]);
      await registered(CLICKS[1]);
      const { post, received } = tracker(200, 200);

      await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });
      await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });

      expect(received.map((request) => request.body)).toStrictEqual([
        `{"clickid":"${CLICKS[0]}","event":"reg"}`,
        `{"clickid":"${CLICKS[1]}","event":"reg"}`,
      ]);
      expect((received[1]?.at ?? 0) - (received[0]?.at ?? 0)).toBeGreaterThanOrEqual(1_100);
    });

    it("holds the next post back 1.1 seconds even when a post's outcome could not be recorded", async () => {
      // The rollback leaves the row pending, so the next turn, from any
      // process, posts it again; the lock must not let that post begin sooner.
      await registered(CLICK);
      await pool.query(`
        create function fail_registration_update() returns trigger language plpgsql as $$
        begin raise exception 'injected update failure'; end $$
      `);
      await pool.query(`
        create trigger fail_registration_update before update on dashboard_ad_reports
        for each row execute function fail_registration_update()
      `);
      const { post, received } = tracker(200, 200);
      try {
        await expect(
          reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait }),
        ).rejects.toThrow();
      } finally {
        await pool.query("drop trigger fail_registration_update on dashboard_ad_reports");
        await pool.query("drop function fail_registration_update()");
      }

      await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });

      expect(received).toHaveLength(2);
      expect((received[1]?.at ?? 0) - (received[0]?.at ?? 0)).toBeGreaterThanOrEqual(1_100);
      expect((await onlyRow()).state).toBe("delivered");
    });

    it("posts the report that has waited longest first", async () => {
      const later = await registered(CLICKS[0]);
      const sooner = await registered(CLICKS[1]);
      await pool.query(
        "update dashboard_ad_reports set next_attempt_at = $2 where account_id = $1",
        [later, new Date(clock - MINUTE)],
      );
      await pool.query(
        "update dashboard_ad_reports set next_attempt_at = $2 where account_id = $1",
        [sooner, new Date(clock - 10 * MINUTE)],
      );
      const { post, received } = tracker(200, 200);

      await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });

      expect(received.map((request) => request.body)).toStrictEqual([
        `{"clickid":"${CLICKS[1]}","event":"reg"}`,
      ]);
    });

    it("leaves alone, without waiting for it, a report whose account is being deleted at that moment", async () => {
      // Waiting would hold the lock every process shares for as long as the
      // other transaction runs.
      const account = await registered(CLICK);
      const deleting = await otherPool.connect();
      const { post, received } = tracker(200);
      try {
        await deleting.query("begin");
        await deleting.query("delete from dashboard_accounts where id = $1", [account]);

        const took = await Promise.race([
          reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait }),
          sleep(3_000).then(() => "still waiting"),
        ]);

        expect(took).toBe(false);
        expect(received).toStrictEqual([]);
        await deleting.query("commit");
      } finally {
        // A no-op once committed; otherwise the connection goes back clean.
        await deleting.query("rollback");
        deleting.release();
      }
      expect(await rows()).toStrictEqual([]);
    });

    it("never posts one report twice from two processes running at once, and spaces their posts too", async () => {
      for (const click of CLICKS) await registered(click);
      const { post, received } = tracker();
      const parts = { target: TARGET, storeConnected: true, fetch: post, now, wait, idleMs: 50 };

      const one = startAdReports({ ...parts, pool });
      const other = startAdReports({ ...parts, pool: otherPool });
      try {
        await until(() => received.length >= CLICKS.length);
        // Room for a second post of any of them, had one been taken twice.
        await sleep(200);
      } finally {
        await Promise.all([one.stop(), other.stop()]);
      }

      const posted = received.map((request) => request.body);
      expect([...posted].sort()).toStrictEqual(
        CLICKS.map((click) => `{"clickid":"${click}","event":"reg"}`),
      );
      const times = received.map((request) => request.at);
      for (let at = 1; at < times.length; at += 1) {
        expect((times[at] ?? 0) - (times[at - 1] ?? 0)).toBeGreaterThanOrEqual(1_100);
      }
      expect((await rows()).map((row) => row.state)).toStrictEqual([
        "delivered",
        "delivered",
        "delivered",
      ]);
    });

    it("keeps going after a turn the database failed, and delivers once it is back", async () => {
      await registered(CLICK);
      await pool.query("alter table dashboard_ad_reports rename to ad_reports_away");
      const { post, received } = tracker();
      const running = startAdReports({
        pool,
        target: TARGET,
        storeConnected: true,
        fetch: post,
        now,
        wait,
        idleMs: 20,
      });
      try {
        await until(() => told.length >= 2);
        await pool.query("alter table ad_reports_away rename to dashboard_ad_reports");
        await until(() => received.length === 1);
      } finally {
        await running.stop();
      }

      expect((await onlyRow()).state).toBe("delivered");
    });

    it("says each outcome in one line, by its state and status alone", async () => {
      await registered(CLICK);
      await registered(CLICKS[1], 24 * HOUR);
      const { post } = tracker(503, 403);

      await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });
      await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });
      clock += 2 * MINUTE;
      await reportOnce({ pool, target: TARGET, storeConnected: true, fetch: post, now, wait });

      expect(told).toHaveLength(3);
      expect(told.filter((line) => line.includes("retry_window_exhausted"))).toHaveLength(1);
      expect(told.filter((line) => line.includes("http_503"))).toHaveLength(1);
      expect(told.filter((line) => line.includes("http_403"))).toHaveLength(1);
    });

    it("stops between turns without waiting out the pause", async () => {
      const running = startAdReports({
        pool,
        target: TARGET,
        storeConnected: true,
        fetch: tracker().post,
        idleMs: 60_000,
      });
      await sleep(100);
      const began = performance.now();

      await running.stop();

      expect(performance.now() - began).toBeLessThan(2_000);
    });
  });

  /** Asks again until the database says yes, or fails the test. */
  const eventually = async (condition: () => Promise<boolean>, within = 20_000): Promise<void> => {
    const deadline = Date.now() + within;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error("the condition did not come about in time");
      await sleep(10);
    }
  };

  describe("the loop every dashboard starts, whichever way the report is switched", () => {
    it("reports what is due when switched on", async () => {
      await registered(CLICK);
      const { post, received } = tracker(200);
      const running = startAdReports({
        pool,
        target: TARGET,
        storeConnected: true,
        fetch: post,
        now,
        wait,
        idleMs: 20,
      });
      try {
        await until(() => received.length === 1);
      } finally {
        await running.stop();
      }

      expect(received[0]?.body).toBe(`{"clickid":"${CLICK}","event":"reg"}`);
      expect((await onlyRow()).state).toBe("delivered");
    });

    it("posts nothing when switched off, and gives up every report a day old so its click goes", async () => {
      // Pending rows from before the switch went off would otherwise keep
      // their click for as long as it stays off.
      const unasked = await registered(CLICKS[0], 24 * HOUR);
      const failed = await registered(CLICKS[1], 30 * HOUR);
      await pool.query(
        "update dashboard_ad_reports set attempts = 3, last_outcome = 'http_503' where account_id = $1",
        [failed],
      );
      const young = await registered(CLICKS[2], 23 * HOUR);
      // Final already, and older than a day: not the loop's to touch.
      const delivered = await registered("qa_click_3123456789abcdef", 30 * HOUR);
      const deliveredAt = new Date(clock - 29 * HOUR);
      await pool.query(
        `update dashboard_ad_reports
            set state = 'delivered', click_id = null, next_attempt_at = null, attempts = 1,
                last_outcome = 'http_200', settled_at = $2
          where account_id = $1`,
        [delivered, deliveredAt],
      );
      const { post, received } = tracker();

      const running = startAdReports({
        pool,
        target: null,
        storeConnected: false,
        fetch: post,
        now,
        wait,
        idleMs: 20,
      });
      try {
        await eventually(async () =>
          (await rows())
            .filter((row) => row.account_id === unasked || row.account_id === failed)
            .every((row) => row.state === "given_up"),
        );
        // Room for a post, had the loop been going to make one.
        await sleep(100);
      } finally {
        await running.stop();
      }

      expect(received).toStrictEqual([]);
      const byAccount = new Map((await rows()).map((row) => [row.account_id, row]));
      expect(byAccount.get(unasked)).toMatchObject({
        click_id: null,
        state: "given_up",
        attempts: 0,
        next_attempt_at: null,
        last_outcome: null,
      });
      expect(byAccount.get(unasked)?.settled_at).not.toBeNull();
      expect(byAccount.get(failed)).toMatchObject({
        click_id: null,
        state: "given_up",
        attempts: 3,
        next_attempt_at: null,
        last_outcome: "http_503",
      });
      expect(byAccount.get(delivered)).toStrictEqual({
        account_id: delivered,
        click_id: null,
        state: "delivered",
        attempts: 1,
        next_attempt_at: null,
        last_outcome: "http_200",
        settled_at: deliveredAt,
      });
      // Untouched: nobody was asked about it.
      expect(byAccount.get(young)).toMatchObject({
        click_id: CLICKS[2],
        state: "pending",
        attempts: 0,
        last_outcome: null,
        settled_at: null,
      });
    });

    it("switched off, gives up a report the moment its day ends, and not a moment sooner", async () => {
      const ended = await registered(CLICKS[0], 24 * HOUR);
      const almost = await registered(CLICKS[1], 24 * HOUR - 1);
      // The clock stands still, so only the turn's own reading of it decides.
      const running = startAdReports({
        pool,
        target: null,
        storeConnected: false,
        fetch: tracker().post,
        now,
        wait: () => sleep(5),
        idleMs: 20,
      });
      try {
        await eventually(
          async () => (await rows()).find((row) => row.account_id === ended)?.state === "given_up",
          5_000,
        );
        await sleep(100);
      } finally {
        await running.stop();
      }

      expect((await rows()).find((row) => row.account_id === almost)).toMatchObject({
        click_id: CLICKS[1],
        state: "pending",
      });
    });
  });

  const gatewayConfig = testConfig();
  const store = PostgresStore.over(gatewayDatabase.db, gatewayConfig.payment.network, randomIds);
  const gateway = new Gateway({
    config: gatewayConfig,
    store,
    // Publishing a card puts nothing on a queue.
    queue: new MemoryQueue({ attempts: 1, retryDelayMs: 1_000 }),
    facilitator: new ScriptedFacilitator(),
    clock: () => clock,
    ids: randomIds,
    announcer: nobodyAnnounces,
    widestChallenge: widestChallengeOn(gatewayConfig),
  });

  let merchants = 0;
  /** A merchant the gateway lets publish, selling through `integration`. */
  const aMerchant = async (integration: Integration = "api"): Promise<string> => {
    merchants += 1;
    const name = `Merchant ${merchants}`;
    const made = await store.addMerchant({ id: `mch_report_${merchants}`, name }, clock);
    if (made === null) throw new Error("the merchant was not made");
    await store.setServiceName(made.id, name, clock);
    await setPayoutWallet(
      store,
      gatewayConfig.payoutSplit,
      made.id,
      `0x${merchants.toString(16).padStart(40, "0")}`,
      clock,
    );
    if (integration === "woocommerce") await store.switchIntegration(made.id, "woocommerce");
    return made.id;
  };

  const card = (item: string): Card => ({
    merchant_item_id: item,
    title: "A room for the night",
    description: "One night in a room",
    price: { amount: "80.00", currency: "USD" },
    result: { access_code: { type: "string" } },
    fulfillment: "sync",
  });

  /** Publishes through the gateway at the test clock, as both integrations do. */
  const publish = async (
    merchantId: string,
    item: string,
    integration: Integration = "api",
  ): Promise<void> => {
    expect(await gateway.publishCard(merchantId, card(item), integration)).toMatchObject({
      ok: true,
    });
  };

  let storeAccounts = 0;
  /**
   * An account of `merchantId` an ad brought, registered `createdAgoMs` before
   * the test clock, with its store report waiting as a sign-in with that
   * report switched on leaves it. Its registration's report is already
   * delivered unless `registration` says it is still pending.
   */
  const fromAnAd = async (
    click: string,
    merchantId: string | null,
    createdAgoMs = 0,
    registration: "delivered" | "pending" = "delivered",
  ): Promise<string> => {
    storeAccounts += 1;
    // Padded, so the order of the identifiers is the order they were made in.
    const id = `acc_report_s${String(storeAccounts).padStart(4, "0")}`;
    const created = new Date(clock - createdAgoMs);
    await pool.query(
      `insert into dashboard_accounts
         (id, email, email_verified, name, created_at, updated_at, merchant_id)
       values ($1, $2, true, '', $3, $3, $4)`,
      [id, `store-${storeAccounts}@example.com`, created, merchantId],
    );
    await pool.query(
      registration === "pending"
        ? `insert into dashboard_ad_reports
             (account_id, event, click_id, state, attempts, next_attempt_at, created_at, event_at)
           values ($1, 'reg', $2, 'pending', 0, $3, $3, $3)`
        : `insert into dashboard_ad_reports
             (account_id, event, click_id, state, attempts, last_outcome, created_at, event_at,
              settled_at)
           values ($1, 'reg', null, 'delivered', 1, 'http_200', $2, $2, $2)`,
      registration === "pending" ? [id, click, created] : [id, created],
    );
    await pool.query(
      `insert into dashboard_ad_reports (account_id, event, click_id, state, created_at)
       values ($1, 'store_connected', $2, 'waiting', $3)`,
      [id, click, created],
    );
    return id;
  };

  interface StoreRow {
    readonly account_id: string;
    readonly click_id: string | null;
    readonly state: string;
    readonly attempts: number;
    readonly next_attempt_at: Date | null;
    readonly last_outcome: string | null;
    readonly event_at: Date | null;
    readonly settled_at: Date | null;
  }

  const storeRowOf = async (account: string): Promise<StoreRow> => {
    const [row] = (
      await pool.query<StoreRow>(
        `select account_id, click_id, state, attempts, next_attempt_at, last_outcome, event_at,
                settled_at
           from dashboard_ad_reports where event = 'store_connected' and account_id = $1`,
        [account],
      )
    ).rows;
    if (row === undefined) throw new Error("the account has no store report");
    return row;
  };

  const storeReport = (click: string, firstCardAt: number): string =>
    `{"clickid":"${click}","event":"store_connected","event_time":${Math.floor(firstCardAt / 1_000)}}`;

  const report = async (post: typeof fetch, storeConnected = true): Promise<boolean> =>
    await reportOnce({ pool, target: TARGET, storeConnected, fetch: post, now, wait });

  describe("reporting a merchant's first card to the ad tracker", () => {
    for (const [integration, through] of [
      ["api", "the API"],
      ["woocommerce", "the WooCommerce import"],
    ] as const) {
      it(`posts store_connected once, with the click and the first card's publication in Unix seconds, for a first card published through ${through}`, async () => {
        const merchant = await aMerchant(integration);
        const account = await fromAnAd(CLICK, merchant);
        clock += 2 * HOUR + 1_234;
        const firstCardAt = clock;
        await publish(merchant, "room-1", integration);
        clock += MINUTE;
        const postedAt = clock;
        const { post, received } = tracker(200);

        expect(await report(post)).toBe(true);

        expect(received).toHaveLength(1);
        const [request] = received;
        expect(request?.url).toBe(ENDPOINT);
        expect(request?.method).toBe("POST");
        expect(request?.headers.sort()).toStrictEqual([
          ["content-type", "application/json"],
          ["x-postback-key", KEY],
        ]);
        expect(request?.redirect).toBe("manual");
        expect(request?.body).toBe(storeReport(CLICK, firstCardAt));
        expect(await storeRowOf(account)).toMatchObject({
          click_id: null,
          state: "delivered",
          attempts: 1,
          last_outcome: "http_200",
          event_at: new Date(firstCardAt),
          settled_at: new Date(postedAt),
        });
        expect(await report(post)).toBe(false);
        expect(received).toHaveLength(1);
      });
    }

    it("posts nothing more for a second card, a republish or an account of the same merchant registered afterwards", async () => {
      const merchant = await aMerchant();
      await fromAnAd(CLICKS[0], merchant);
      clock += HOUR;
      await publish(merchant, "room-1");
      const { post, received } = tracker(200, 200, 200);
      await report(post);
      expect(received).toHaveLength(1);

      clock += HOUR;
      await publish(merchant, "room-2");
      await publish(merchant, "room-1");
      const later = await fromAnAd(CLICKS[1], merchant);
      clock += HOUR;
      await publish(merchant, "room-3");

      expect(await report(post)).toBe(false);

      expect(received).toHaveLength(1);
      expect(await storeRowOf(later)).toMatchObject({
        click_id: null,
        state: "lapsed",
        last_outcome: "first_card_before_registration",
        event_at: null,
        settled_at: new Date(clock),
      });
    });

    it("reports only the earliest registration when two accounts of one merchant wait for its first card, and lapses the other", async () => {
      const merchant = await aMerchant();
      // Made first, registered later: the earliest registration is not the
      // first row.
      const later = await fromAnAd(CLICKS[1], merchant, HOUR);
      const earliest = await fromAnAd(CLICKS[0], merchant, 2 * HOUR);
      const firstCardAt = clock;
      await publish(merchant, "room-1");
      const { post, received } = tracker(200, 200);

      await report(post);
      expect(await report(post)).toBe(false);

      expect(received.map((request) => request.body)).toStrictEqual([
        storeReport(CLICKS[0], firstCardAt),
      ]);
      expect(await storeRowOf(earliest)).toMatchObject({ state: "delivered", click_id: null });
      expect(await storeRowOf(later)).toMatchObject({
        state: "lapsed",
        click_id: null,
        last_outcome: "belongs_to_another_account",
      });
    });

    it("tells the tracker of one merchant once, even when an account that came from an ad before its first card joins it afterwards", async () => {
      const merchant = await aMerchant();
      // Registered first, but named no merchant when the first card came.
      const joinsLater = await fromAnAd(CLICKS[1], null, HOUR);
      await fromAnAd(CLICKS[0], merchant);
      clock += MINUTE;
      const firstCardAt = clock;
      await publish(merchant, "room-1");
      const { post, received } = tracker(200, 200);
      await report(post);
      await pool.query("update dashboard_accounts set merchant_id = $1 where id = $2", [
        merchant,
        joinsLater,
      ]);
      clock += MINUTE;

      expect(await report(post)).toBe(false);

      expect(received.map((request) => request.body)).toStrictEqual([
        storeReport(CLICKS[0], firstCardAt),
      ]);
      expect(await storeRowOf(joinsLater)).toMatchObject({
        state: "lapsed",
        click_id: null,
        last_outcome: "belongs_to_another_account",
      });
    });

    it("never reports a merchant whose first card was published before the registration, and erases the click", async () => {
      const merchant = await aMerchant();
      await publish(merchant, "room-1");
      clock += MINUTE;
      const account = await fromAnAd(CLICK, merchant);
      clock += HOUR;
      await publish(merchant, "room-2");
      const { post, received } = tracker(200);

      expect(await report(post)).toBe(false);

      expect(received).toStrictEqual([]);
      expect(await storeRowOf(account)).toMatchObject({
        click_id: null,
        state: "lapsed",
        last_outcome: "first_card_before_registration",
        event_at: null,
        settled_at: new Date(clock),
      });
    });

    it("keeps the click while it waits and erases it, posting nothing, once 30 days pass without a first card", async () => {
      const merchant = await aMerchant();
      const withMerchant = await fromAnAd(CLICKS[0], merchant);
      const withoutMerchant = await fromAnAd(CLICKS[1], null);
      const registeredAt = clock;
      const { post, received } = tracker(200);

      clock = registeredAt + 30 * DAY - 1;
      expect(await report(post)).toBe(false);
      expect(await storeRowOf(withMerchant)).toMatchObject({
        click_id: CLICKS[0],
        state: "waiting",
      });
      expect(await storeRowOf(withoutMerchant)).toMatchObject({
        click_id: CLICKS[1],
        state: "waiting",
      });

      clock = registeredAt + 30 * DAY;
      expect(await report(post)).toBe(false);
      for (const account of [withMerchant, withoutMerchant]) {
        expect(await storeRowOf(account)).toMatchObject({
          click_id: null,
          state: "lapsed",
          last_outcome: "no_first_card_in_30_days",
          event_at: null,
          settled_at: new Date(clock),
        });
      }

      await publish(merchant, "room-1");
      clock += MINUTE;
      expect(await report(post)).toBe(false);
      expect(received).toStrictEqual([]);
    });

    it("counts a first card published just inside the 30 days, and not one published at 30 days though nothing looked in between", async () => {
      const inside = await aMerchant();
      const outside = await aMerchant();
      const counted = await fromAnAd(CLICKS[0], inside);
      const uncounted = await fromAnAd(CLICKS[1], outside);
      const registeredAt = clock;
      const { post, received } = tracker(200);

      clock = registeredAt + 30 * DAY - 2_000;
      await publish(inside, "room-1");
      clock = registeredAt + 30 * DAY;
      await publish(outside, "room-1");
      clock = registeredAt + 30 * DAY - 1_000;
      await report(post);
      clock = registeredAt + 30 * DAY + MINUTE;
      expect(await report(post)).toBe(false);

      expect(received.map((request) => request.body)).toStrictEqual([
        storeReport(CLICKS[0], registeredAt + 30 * DAY - 2_000),
      ]);
      expect(await storeRowOf(counted)).toMatchObject({ state: "delivered", click_id: null });
      expect(await storeRowOf(uncounted)).toMatchObject({
        state: "lapsed",
        last_outcome: "no_first_card_in_30_days",
        click_id: null,
        event_at: null,
      });
    });

    it("gives up, without posting it or saying it became due, a store report whose first card is found only after a day has passed since it", async () => {
      const merchant = await aMerchant();
      const account = await fromAnAd(CLICK, merchant);
      const firstCardAt = clock;
      await publish(merchant, "room-1");
      clock = firstCardAt + DAY;
      const { post, received } = tracker(200);

      expect(await report(post)).toBe(false);

      expect(received).toStrictEqual([]);
      expect(await storeRowOf(account)).toMatchObject({
        click_id: null,
        state: "given_up",
        attempts: 0,
        last_outcome: null,
        event_at: new Date(firstCardAt),
        settled_at: new Date(clock),
      });
      expect(told).toHaveLength(1);
      expect(told[0]).toMatch(/given up/);
    });

    it("carries the first publication's time, not a republish's, and the card keeps that time", async () => {
      const merchant = await aMerchant();
      await fromAnAd(CLICK, merchant);
      clock += HOUR;
      const firstCardAt = clock;
      await publish(merchant, "room-1");
      clock += HOUR;
      await publish(merchant, "room-1");
      const { post, received } = tracker(200);

      await report(post);

      expect(received.map((request) => request.body)).toStrictEqual([
        storeReport(CLICK, firstCardAt),
      ]);
      expect((await pool.query("select published_at, as_of from cards")).rows).toStrictEqual([
        { published_at: new Date(firstCardAt), as_of: new Date(firstCardAt + HOUR) },
      ]);
    });

    it("reports nothing for a publish the gateway refused, and goes on waiting", async () => {
      const merchant = await aMerchant("api");
      const account = await fromAnAd(CLICK, merchant);
      clock += HOUR;
      expect(await gateway.publishCard(merchant, card("room-1"), "woocommerce")).toMatchObject({
        ok: false,
      });
      const { post, received } = tracker(200);

      expect(await report(post)).toBe(false);

      expect(received).toStrictEqual([]);
      expect(await storeRowOf(account)).toMatchObject({ click_id: CLICK, state: "waiting" });
    });

    it("tries a store report again after a 429 and delivers it once the tracker takes it", async () => {
      const merchant = await aMerchant();
      const account = await fromAnAd(CLICK, merchant);
      const firstCardAt = clock;
      await publish(merchant, "room-1");
      const { post, received } = tracker(429, 200);

      await report(post);
      expect(await storeRowOf(account)).toMatchObject({
        click_id: CLICK,
        state: "pending",
        attempts: 1,
        last_outcome: "http_429",
        next_attempt_at: new Date(firstCardAt + MINUTE),
      });
      clock = firstCardAt + MINUTE;
      await report(post);

      expect(received.map((request) => request.body)).toStrictEqual([
        storeReport(CLICK, firstCardAt),
        storeReport(CLICK, firstCardAt),
      ]);
      expect(await storeRowOf(account)).toMatchObject({
        click_id: null,
        state: "delivered",
        attempts: 2,
      });
    });

    it("tries a store report the tracker answers 503 within a day of the first card, not of the registration, then gives up and erases the click", async () => {
      const merchant = await aMerchant();
      const account = await fromAnAd(CLICK, merchant);
      clock += 10 * DAY;
      const firstCardAt = clock;
      await publish(merchant, "room-1");
      const { post, received } = tracker(...Array<Answer>(20).fill(503));

      for (let turn = 0; turn < 20; turn += 1) {
        await report(post);
        const row = await storeRowOf(account);
        if (row.state !== "pending" || row.next_attempt_at === null) break;
        clock = row.next_attempt_at.getTime();
      }

      // Failures at 0, 1m, 6m, 36m, 2h36m, 8h36m, 14h36m and 20h36m after the
      // first card; the ninth try would be at 26h36m.
      expect(received).toHaveLength(8);
      expect(received.at(-1)?.at ?? 0).toBeLessThan(firstCardAt + DAY);
      expect(await storeRowOf(account)).toMatchObject({
        click_id: null,
        state: "given_up",
        attempts: 8,
        last_outcome: "http_503",
      });
    });

    it("never posts a store report 30 days or more after the registration, however long the tracker fails, and has given it up with no click by then", async () => {
      const merchant = await aMerchant();
      const account = await fromAnAd(CLICK, merchant);
      const registeredAt = clock;
      clock = registeredAt + 30 * DAY - HOUR;
      await publish(merchant, "room-1");
      const { post, received } = tracker(...Array<Answer>(20).fill(503));

      for (let turn = 0; turn < 20; turn += 1) {
        await report(post);
        const row = await storeRowOf(account);
        if (row.state !== "pending" || row.next_attempt_at === null) break;
        clock = row.next_attempt_at.getTime();
      }

      // Failures at 0, 1m, 6m and 36m after the first card; the fifth try
      // would be at 2h36m, past the 30 days.
      expect(received).toHaveLength(4);
      for (const request of received) expect(request.at).toBeLessThan(registeredAt + 30 * DAY);
      const row = await storeRowOf(account);
      expect(row).toMatchObject({
        click_id: null,
        state: "given_up",
        attempts: 4,
        last_outcome: "http_503",
      });
      expect(row.settled_at?.getTime()).toBeLessThan(registeredAt + 30 * DAY);
    });

    it("refuses for good a store report the tracker answered 400, and erases the click", async () => {
      const merchant = await aMerchant();
      const account = await fromAnAd(CLICK, merchant);
      await publish(merchant, "room-1");
      const { post, received } = tracker(400);

      await report(post);
      clock += 2 * DAY;
      expect(await report(post)).toBe(false);

      expect(received).toHaveLength(1);
      expect(await storeRowOf(account)).toMatchObject({
        click_id: null,
        state: "refused",
        attempts: 1,
        last_outcome: "http_400",
      });
    });

    it("spaces a registration's post and a store report's post at least 1.1 seconds apart", async () => {
      const merchant = await aMerchant();
      await fromAnAd(CLICK, merchant, 0, "pending");
      await publish(merchant, "room-1");
      const { post, received } = tracker(200, 200);

      await report(post);
      await report(post);

      expect(received.map((request) => JSON.parse(String(request.body)).event)).toStrictEqual([
        "reg",
        "store_connected",
      ]);
      expect((received[1]?.at ?? 0) - (received[0]?.at ?? 0)).toBeGreaterThanOrEqual(1_100);
    });

    it("never posts one report twice from two processes running at once, registrations and stores mixed, and spaces every post", async () => {
      for (const click of CLICKS) {
        const merchant = await aMerchant();
        await fromAnAd(click, merchant, 0, "pending");
        await publish(merchant, "room-1");
      }
      const { post, received } = tracker();
      const parts = { target: TARGET, storeConnected: true, fetch: post, now, wait, idleMs: 50 };

      const one = startAdReports({ ...parts, pool });
      const other = startAdReports({ ...parts, pool: otherPool });
      try {
        await until(() => received.length >= 2 * CLICKS.length);
        await sleep(200);
      } finally {
        await Promise.all([one.stop(), other.stop()]);
      }

      const bodies = received.map((request) => JSON.parse(String(request.body)));
      expect(bodies).toHaveLength(2 * CLICKS.length);
      for (const click of CLICKS) {
        expect(
          bodies
            .filter((body) => body.clickid === click)
            .map((body) => body.event)
            .sort(),
        ).toStrictEqual(["reg", "store_connected"]);
      }
      const times = received.map((request) => request.at);
      for (let at = 1; at < times.length; at += 1) {
        expect((times[at] ?? 0) - (times[at - 1] ?? 0)).toBeGreaterThanOrEqual(1_100);
      }
    });

    it("tells the tracker once of the registration and once of the store, with one click, for a person who signs in from an ad, makes a merchant and publishes", async () => {
      const messages: Message[] = [];
      const identity = identityFor(
        loadConfig({
          DATABASE_URL: databaseUrl,
          AUTH_SECRET: TEST_AUTH_SECRET,
          PAYMENT_NETWORK: "eip155:84532",
          FACILITATOR_URL: "sandbox:scripted",
          REGISTRATION_POSTBACK_ENABLED: "true",
          REGISTRATION_POSTBACK_KEY: KEY,
          REGISTRATION_POSTBACK_URL: ENDPOINT,
          STORE_POSTBACK_ENABLED: "true",
        }),
        {
          pool,
          postman: async (message) => {
            messages.push(message);
            return "accepted";
          },
        },
      );
      await identity.requestLink("person@example.com", "default", CLICK);
      const link = messages[0]?.body.match(/https?:\/\/\S+/)?.[0];
      const token = link === undefined ? null : new URL(link).searchParams.get("token");
      if (token === null) throw new Error("the message has no link");
      const opened = await identity.openLink(token);
      if (opened.status !== "opened") throw new Error("the link did not open");
      // The sign-in is dated by the real clock; the rest follows it.
      clock = Date.now() + MINUTE;
      const merchant = await aMerchant();
      expect(await identity.attachMerchant(opened.person.id, async () => merchant)).toMatchObject({
        status: "attached",
      });
      clock += HOUR;
      const firstCardAt = clock;
      await publish(merchant, "room-1");
      await publish(merchant, "room-2");
      const { post, received } = tracker(200, 200);

      await report(post);
      await report(post);
      expect(await report(post)).toBe(false);

      expect(received.map((request) => request.body)).toStrictEqual([
        `{"clickid":"${CLICK}","event":"reg"}`,
        storeReport(CLICK, firstCardAt),
      ]);
      expect(
        (await pool.query("select click_id from dashboard_ad_reports where click_id is not null"))
          .rows,
      ).toStrictEqual([]);
    });
  });

  describe("a store report and its registration's report", () => {
    const eventsOf = (received: readonly Received[]): string[] =>
      received.map((request) => JSON.parse(String(request.body)).event);

    it("keeps a store report waiting, with its click, while its registration's report is still to be delivered, though the first card came, and posts it after", async () => {
      const merchant = await aMerchant();
      const account = await fromAnAd(CLICK, merchant, 0, "pending");
      const firstCardAt = clock;
      await publish(merchant, "room-1");
      const { post, received } = tracker(503, 200, 200);

      await report(post);
      expect(await report(post)).toBe(false);
      expect(await storeRowOf(account)).toMatchObject({
        click_id: CLICK,
        state: "waiting",
        event_at: null,
      });

      clock = START.getTime() + MINUTE;
      await report(post);
      expect(eventsOf(received)).toStrictEqual(["reg", "reg"]);
      await report(post);

      expect(eventsOf(received)).toStrictEqual(["reg", "reg", "store_connected"]);
      expect(received[2]?.body).toBe(storeReport(CLICK, firstCardAt));
      expect(await storeRowOf(account)).toMatchObject({
        click_id: null,
        state: "delivered",
        event_at: new Date(firstCardAt),
      });
    });

    it("lapses a store report and erases its click once its registration's report is refused, though its first card came", async () => {
      const merchant = await aMerchant();
      const account = await fromAnAd(CLICK, merchant, 0, "pending");
      await publish(merchant, "room-1");
      const { post, received } = tracker(400, 200);

      await report(post);
      clock += MINUTE;
      expect(await report(post)).toBe(false);

      expect(eventsOf(received)).toStrictEqual(["reg"]);
      expect(await storeRowOf(account)).toMatchObject({
        click_id: null,
        state: "lapsed",
        last_outcome: "registration_not_delivered",
        event_at: null,
        settled_at: new Date(clock),
      });
    });

    it("lapses a store report and erases its click once its registration's report is given up, whether or not a first card came", async () => {
      const merchant = await aMerchant();
      const withCard = await fromAnAd(CLICKS[0], merchant, DAY, "pending");
      const withoutMerchant = await fromAnAd(CLICKS[1], null, DAY, "pending");
      await publish(merchant, "room-1");
      const { post, received } = tracker(200, 200);

      await report(post);
      await report(post);
      expect(await report(post)).toBe(false);

      expect(received).toStrictEqual([]);
      for (const account of [withCard, withoutMerchant]) {
        expect(await storeRowOf(account)).toMatchObject({
          click_id: null,
          state: "lapsed",
          last_outcome: "registration_not_delivered",
          event_at: null,
        });
      }
    });

    it("reports the store for the merchant's next registration from an ad when the earliest one's registration report was refused", async () => {
      const merchant = await aMerchant();
      const refused = await fromAnAd(CLICKS[0], merchant, 2 * HOUR, "pending");
      const next = await fromAnAd(CLICKS[1], merchant, HOUR);
      const { post, received } = tracker(400, 200);
      await report(post);
      const firstCardAt = clock;
      await publish(merchant, "room-1");

      await report(post);

      expect(received.map((request) => request.body)).toStrictEqual([
        `{"clickid":"${CLICKS[0]}","event":"reg"}`,
        storeReport(CLICKS[1], firstCardAt),
      ]);
      expect(await storeRowOf(refused)).toMatchObject({
        click_id: null,
        state: "lapsed",
        last_outcome: "registration_not_delivered",
      });
      expect(await storeRowOf(next)).toMatchObject({ click_id: null, state: "delivered" });
    });

    it("with every report switched off, lapses a store report and erases its click once its registration's report is given up at the end of its day", async () => {
      const merchant = await aMerchant();
      const account = await fromAnAd(CLICK, merchant, DAY, "pending");
      await publish(merchant, "room-1");

      const running = startAdReports({
        pool,
        target: null,
        storeConnected: false,
        fetch: tracker().post,
        now,
        wait,
        idleMs: 20,
      });
      try {
        await eventually(async () => (await storeRowOf(account)).state !== "waiting", 5_000);
      } finally {
        await running.stop();
      }

      expect(await storeRowOf(account)).toMatchObject({
        click_id: null,
        state: "lapsed",
        last_outcome: "registration_not_delivered",
        event_at: null,
      });
    });
  });

  describe("a store report while that report is switched off", () => {
    it("posts registrations only, and keeps a store report waiting until its 30 days end, then erases its click", async () => {
      const merchant = await aMerchant();
      const account = await fromAnAd(CLICK, merchant, 0, "pending");
      const registeredAt = clock;
      clock += HOUR;
      await publish(merchant, "room-1");
      const { post, received } = tracker(200, 200);

      await report(post, false);
      expect(await report(post, false)).toBe(false);
      expect(await storeRowOf(account)).toMatchObject({ click_id: CLICK, state: "waiting" });

      clock = registeredAt + 30 * DAY;
      expect(await report(post, false)).toBe(false);

      expect(received.map((request) => request.body)).toStrictEqual([
        `{"clickid":"${CLICK}","event":"reg"}`,
      ]);
      expect(await storeRowOf(account)).toMatchObject({
        click_id: null,
        state: "lapsed",
        last_outcome: "switched_off_past_30_days",
      });
    });

    it("says in the log why waiting store reports lapsed, in one line for each reason", async () => {
      const merchant = await aMerchant();
      const registeredAt = clock;
      await fromAnAd(CLICKS[0], merchant);
      await fromAnAd(CLICKS[1], null);
      await fromAnAd(CLICKS[2], null);
      clock = registeredAt + HOUR;
      await publish(merchant, "room-1");
      clock = registeredAt + 30 * DAY;

      expect(await report(tracker().post, false)).toBe(false);

      expect(told.filter((line) => line.includes("lapsed"))).toHaveLength(2);
      expect(told.filter((line) => line.includes("switched_off_past_30_days"))).toHaveLength(1);
      expect(told.filter((line) => line.includes("no_first_card_in_30_days"))).toHaveLength(1);
    });

    it("gives up a store report already pending once a day has passed since the first card, without posting it", async () => {
      const merchant = await aMerchant();
      const account = await fromAnAd(CLICK, merchant);
      const firstCardAt = clock;
      await publish(merchant, "room-1");
      const { post, received } = tracker(503);
      await report(post);
      expect(await storeRowOf(account)).toMatchObject({ state: "pending", click_id: CLICK });

      clock = firstCardAt + DAY - 1;
      expect(await report(post, false)).toBe(false);
      expect(await storeRowOf(account)).toMatchObject({ state: "pending", click_id: CLICK });
      clock = firstCardAt + DAY;
      expect(await report(post, false)).toBe(false);

      expect(received).toHaveLength(1);
      expect(await storeRowOf(account)).toMatchObject({
        click_id: null,
        state: "given_up",
        attempts: 1,
        last_outcome: "http_503",
        settled_at: new Date(clock),
      });
    });

    it("gives up a store report already pending the moment 30 days from the registration end, though its first card is not a day old, without posting it", async () => {
      const merchant = await aMerchant();
      const account = await fromAnAd(CLICK, merchant);
      const registeredAt = clock;
      clock = registeredAt + 30 * DAY - HOUR;
      await publish(merchant, "room-1");
      const { post, received } = tracker(503);
      await report(post);
      expect(await storeRowOf(account)).toMatchObject({ state: "pending", click_id: CLICK });

      clock = registeredAt + 30 * DAY - 1;
      expect(await report(post, false)).toBe(false);
      expect(await storeRowOf(account)).toMatchObject({ state: "pending", click_id: CLICK });
      clock = registeredAt + 30 * DAY;
      expect(await report(post, false)).toBe(false);

      expect(received).toHaveLength(1);
      expect(await storeRowOf(account)).toMatchObject({
        click_id: null,
        state: "given_up",
        attempts: 1,
        last_outcome: "http_503",
        settled_at: new Date(clock),
      });
    });

    it("with every report switched off, posts nothing, gives up a pending store report after its day and lapses a waiting one at 30 days", async () => {
      const merchant = await aMerchant();
      const pending = await fromAnAd(CLICKS[0], merchant);
      const firstCardAt = clock;
      await publish(merchant, "room-1");
      const { post, received } = tracker(503);
      await report(post);
      const aged = await fromAnAd(CLICKS[1], null, 29 * DAY);
      const young = await fromAnAd(CLICKS[2], null, 28 * DAY);
      clock = firstCardAt + DAY;

      const running = startAdReports({
        pool,
        target: null,
        storeConnected: false,
        fetch: post,
        now,
        wait,
        idleMs: 20,
      });
      try {
        await eventually(async () => (await storeRowOf(aged)).state === "lapsed");
        await eventually(async () => (await storeRowOf(pending)).state === "given_up");
        await sleep(100);
      } finally {
        await running.stop();
      }

      expect(received).toHaveLength(1);
      expect(await storeRowOf(pending)).toMatchObject({ click_id: null, state: "given_up" });
      expect(await storeRowOf(aged)).toMatchObject({
        click_id: null,
        state: "lapsed",
        last_outcome: "no_first_card_in_30_days",
      });
      expect(await storeRowOf(young)).toMatchObject({ click_id: CLICKS[2], state: "waiting" });
    });
  });
}

/**
 * Reporting registrations to the ad tracker, against PostgreSQL, because what
 * holds the reports together is the database's: a row taken by one turn only,
 * and one lock across every process, which spaces the posts out. The tracker
 * is a function standing in for `fetch`, the clock and the pauses are the
 * test's, and nothing leaves this machine.
 */

import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateAccounts } from "./database.js";
import { reportOnce, startRegistrationReports } from "./registration-postbacks.js";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_dashboard_postbacks";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);
const here = dirname(fileURLToPath(import.meta.url));
const migrationsIn = join(here, "..", "drizzle");

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

  await pool.query(`
    do $$
    declare
      present text;
    begin
      select string_agg(format('%I.%I', schemaname, tablename), ', ')
        into present
        from pg_tables
       where schemaname = 'public';
      if present is not null then
        execute 'drop table ' || present || ' cascade';
      end if;
    end $$;
  `);
  await pool.query("drop schema if exists drizzle cascade");
  await migrateAccounts(pool, migrationsIn);

  afterAll(async () => {
    await Promise.all([pool.end(), otherPool.end()]);
  });

  /** The test's clock, moved by the pauses the code asks for and by the tests. */
  let clock = START.getTime();
  const now = (): Date => new Date(clock);
  /**
   * A pause moves the clock only once a little real time has passed, so a
   * second loop that is not held back by the lock gets to post inside it.
   */
  const wait = async (ms: number): Promise<void> => {
    await sleep(5);
    clock += ms;
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
  });

  afterEach(() => {
    // Nothing about whose registration it was, and never the key, in any line
    // any of these tests made the code write.
    for (const line of told) {
      for (const click of CLICKS) expect(line).not.toContain(click);
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
   * An account and its pending registration, as opening a consented link
   * leaves them, made `createdAgoMs` before the test clock.
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
      `insert into dashboard_registration_postbacks
         (account_id, click_id, consented_at, consent_wording, state, attempts, next_attempt_at, created_at)
       values ($1, $2, $3, '2026-10-15', 'pending', 0, $3, $3)`,
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
           from dashboard_registration_postbacks order by account_id`,
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

      expect(await reportOnce({ pool, target: TARGET, fetch: post, now, wait })).toBe(true);

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

      await reportOnce({ pool, target: TARGET, fetch: post, now, wait });

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

      expect(await reportOnce({ pool, target: TARGET, fetch: post, now, wait })).toBe(false);

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

        await reportOnce({ pool, target: TARGET, fetch: post, now, wait });
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
        expect(await reportOnce({ pool, target: TARGET, fetch: post, now, wait })).toBe(false);
        expect(received).toHaveLength(1);

        await untilDue();
        const recovered = clock;
        await reportOnce({ pool, target: TARGET, fetch: post, now, wait });

        expect(received).toHaveLength(2);
        expect(received[1]?.body).toBe(received[0]?.body);
        expect(await onlyRow()).toMatchObject({
          click_id: null,
          state: "delivered",
          attempts: 2,
          last_outcome: "http_200",
          settled_at: new Date(recovered),
        });
        expect(await reportOnce({ pool, target: TARGET, fetch: post, now, wait })).toBe(false);
        expect(received).toHaveLength(2);
      });
    }

    it("cuts off a tracker that never answers at five seconds, and tries again later", async () => {
      await registered(CLICK);
      const { post } = tracker("silence");
      const began = performance.now();

      await reportOnce({ pool, target: TARGET, fetch: post, now, wait });

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
        await reportOnce({ pool, target: TARGET, fetch: post, now, wait });
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
        await reportOnce({ pool, target: TARGET, fetch: post, now, wait });
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
      await pool.query(
        "update dashboard_registration_postbacks set attempts = 4 where account_id = $1",
        [account],
      );
      const { post } = tracker(503);

      await reportOnce({ pool, target: TARGET, fetch: post, now, wait });

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

      expect(await reportOnce({ pool, target: TARGET, fetch: post, now, wait })).toBe(true);

      expect(received).toStrictEqual([]);
      expect(await onlyRow()).toMatchObject({
        click_id: null,
        state: "given_up",
        attempts: 0,
        last_outcome: "retry_window_exhausted",
        settled_at: START,
      });
    });

    it("still posts a report found just under a day after the registration", async () => {
      await registered(CLICK, 24 * HOUR - 1);
      const { post, received } = tracker(200);

      await reportOnce({ pool, target: TARGET, fetch: post, now, wait });

      expect(received).toHaveLength(1);
      expect((await onlyRow()).state).toBe("delivered");
    });

    for (const status of [302, 400, 401, 403, 404, 422, 204]) {
      it(`marks a report the tracker answered ${status} as refused, erases the click and never posts it again`, async () => {
        await registered(CLICK);
        const { post, received } = tracker(status);

        await reportOnce({ pool, target: TARGET, fetch: post, now, wait });
        clock += 48 * HOUR;
        expect(await reportOnce({ pool, target: TARGET, fetch: post, now, wait })).toBe(false);

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

      await reportOnce({ pool, target: TARGET, fetch: post, now, wait });
      await reportOnce({ pool, target: TARGET, fetch: post, now, wait });

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
        create trigger fail_registration_update before update on dashboard_registration_postbacks
        for each row execute function fail_registration_update()
      `);
      const { post, received } = tracker(200, 200);
      try {
        await expect(
          reportOnce({ pool, target: TARGET, fetch: post, now, wait }),
        ).rejects.toThrow();
      } finally {
        await pool.query(
          "drop trigger fail_registration_update on dashboard_registration_postbacks",
        );
        await pool.query("drop function fail_registration_update()");
      }

      await reportOnce({ pool, target: TARGET, fetch: post, now, wait });

      expect(received).toHaveLength(2);
      expect((received[1]?.at ?? 0) - (received[0]?.at ?? 0)).toBeGreaterThanOrEqual(1_100);
      expect((await onlyRow()).state).toBe("delivered");
    });

    it("posts the report that has waited longest first", async () => {
      const later = await registered(CLICKS[0]);
      const sooner = await registered(CLICKS[1]);
      await pool.query(
        "update dashboard_registration_postbacks set next_attempt_at = $2 where account_id = $1",
        [later, new Date(clock - MINUTE)],
      );
      await pool.query(
        "update dashboard_registration_postbacks set next_attempt_at = $2 where account_id = $1",
        [sooner, new Date(clock - 10 * MINUTE)],
      );
      const { post, received } = tracker(200, 200);

      await reportOnce({ pool, target: TARGET, fetch: post, now, wait });

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
          reportOnce({ pool, target: TARGET, fetch: post, now, wait }),
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
      const parts = { target: TARGET, fetch: post, now, wait, idleMs: 50 };

      const one = startRegistrationReports({ ...parts, pool });
      const other = startRegistrationReports({ ...parts, pool: otherPool });
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
      await pool.query(
        "alter table dashboard_registration_postbacks rename to registration_postbacks_away",
      );
      const { post, received } = tracker();
      const running = startRegistrationReports({
        pool,
        target: TARGET,
        fetch: post,
        now,
        wait,
        idleMs: 20,
      });
      try {
        await until(() => told.length >= 2);
        await pool.query(
          "alter table registration_postbacks_away rename to dashboard_registration_postbacks",
        );
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

      await reportOnce({ pool, target: TARGET, fetch: post, now, wait });
      await reportOnce({ pool, target: TARGET, fetch: post, now, wait });
      clock += 2 * MINUTE;
      await reportOnce({ pool, target: TARGET, fetch: post, now, wait });

      expect(told).toHaveLength(3);
      expect(told.filter((line) => line.includes("retry_window_exhausted"))).toHaveLength(1);
      expect(told.filter((line) => line.includes("http_503"))).toHaveLength(1);
      expect(told.filter((line) => line.includes("http_403"))).toHaveLength(1);
    });

    it("stops between turns without waiting out the pause", async () => {
      const running = startRegistrationReports({
        pool,
        target: TARGET,
        fetch: tracker().post,
        idleMs: 60_000,
      });
      await sleep(100);
      const began = performance.now();

      await running.stop();

      expect(performance.now() - began).toBeLessThan(2_000);
    });
  });
}

/**
 * PostgreSQL as the authority for dashboard identity transactions and
 * migrations.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import {
  identityFor,
  LINK_CHANNEL_LIMIT,
  LINK_CLIENT_LIMIT,
  LINK_MIN_INTERVAL_MS,
  LINK_RATE_WINDOW_MS,
} from "./identity.js";
import type { Message } from "./mail.js";
import { type GoogleProfile, googleExchange } from "./testing/google.js";
import { ONE_CLIENT } from "./testing/link-sends.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_dashboard_identity";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);
const here = dirname(fileURLToPath(import.meta.url));
const migrationsIn = join(here, "..", "drizzle");

const MERCHANT = "mer_the_merchant";
/**
 * A key as an account row held it before the migration that drops the column.
 */
const A_KEY_ON_THE_ROW = "the-merchants-own-key-long-enough";
const NOW = new Date("2026-09-17T12:00:00.000Z");

async function statementsOf(file: string): Promise<string[]> {
  const source = await readFile(join(migrationsIn, file), "utf8");
  return source
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.trim())
    .filter((statement) => statement !== "");
}

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));
  describe("the dashboard identity on PostgreSQL", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const identityDatabaseUrl = databaseUrl;
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const migrationFiles = [
    "0000_accounts.sql",
    "0001_merchant_on_account.sql",
    "0002_the_old_sign_in_goes.sql",
    "0003_identity_component.sql",
    "0004_woocommerce_connection.sql",
    "0005_one_way_in_identity.sql",
  ] as const;

  afterAll(async () => {
    await pool.end();
  });

  async function run(file: string): Promise<void> {
    for (const statement of await statementsOf(file)) await pool.query(statement);
  }

  /**
   * Some tests stop at a migration from before the tables were renamed, so the
   * schema is dropped whole rather than by a list of tables; this suite owns
   * its database.
   */
  async function emptyEverything(): Promise<void> {
    await pool.query("drop schema public cascade");
    await pool.query("create schema public");
  }

  /**
   * Every checked-in migration, in order: the schema a deployment runs today.
   * The cutover tests use `migrateThrough` instead, to stop at the migration
   * they are about.
   */
  async function migrateEverything(): Promise<void> {
    const files = (await readdir(migrationsIn)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) await run(file);
  }

  async function migrateThrough(file: (typeof migrationFiles)[number]): Promise<void> {
    for (const migration of migrationFiles) {
      await run(migration);
      if (migration === file) return;
    }
  }

  function config(settings: Record<string, string> = {}) {
    return loadConfig({
      DATABASE_URL: identityDatabaseUrl,
      AUTH_SECRET: TEST_AUTH_SECRET,
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "sandbox:scripted",
      ...settings,
    });
  }

  function identityOn(
    messages: Message[],
    handover: "accepted" | "refused" = "accepted",
    settings: Record<string, string> = {},
  ) {
    return identityFor(config(settings), {
      pool,
      postman: async (message) => {
        messages.push(message);
        return handover;
      },
    });
  }

  /** A laptop's dashboard with the report switched on, posting to a receiver of its own. */
  function reportingOn(messages: Message[]) {
    return identityOn(messages, "accepted", {
      REGISTRATION_POSTBACK_ENABLED: "true",
      REGISTRATION_POSTBACK_KEY: ["qa", "synthetic", "postback", "key"].join("-"),
      REGISTRATION_POSTBACK_URL: "http://127.0.0.1:4010/postback",
    });
  }

  /**
   * Every send on record is dated a minute back, so the next request is not
   * refused by the minute and the earlier ones stay inside the rolling hour.
   */
  async function rewindLinkSends(): Promise<void> {
    await pool.query("update dashboard_link_sends set sent_at = sent_at - $1::interval", [
      "1 minute",
    ]);
  }

  function tokenIn(message: Message): string {
    const raw = message.body.match(/https?:\/\/\S+/)?.[0];
    if (raw === undefined) throw new Error("the message has no dashboard link");
    const token = new URL(raw).searchParams.get("token");
    if (token === null) throw new Error("the dashboard link has no token");
    return token;
  }

  describe("the stopped passwordless cutover", () => {
    beforeEach(async () => {
      await emptyEverything();
      await migrateThrough("0004_woocommerce_connection.sql");
    });

    it("preserves account and Woo rows exactly while purging only old proofs and sessions", async () => {
      await pool.query(
        `insert into cabinet_accounts
           (id, email, email_verified, name, created_at, updated_at, merchant_id, merchant_key)
         values
           ('person_p2', 'owner@example.com', false, '', $1, $1, $2, $3),
           ('person_p1', 'reader@example.com', true, '', $1, $1, null, null)`,
        [NOW, MERCHANT, A_KEY_ON_THE_ROW],
      );
      await pool.query(
        `insert into cabinet_credentials
           (id, user_id, provider_id, account_id, issuer, password, created_at, updated_at)
         values ('credential_old', 'person_p2', 'credential', 'person_p2', 'local',
                 'derived-password', $1, $1)`,
        [NOW],
      );
      await pool.query(
        `insert into cabinet_sessions
           (id, token, user_id, expires_at, created_at, updated_at)
         values ('session_old', 'old-session-token', 'person_p2', $1, $2, $2)`,
        [new Date(NOW.getTime() + 60_000), NOW],
      );
      await pool.query(
        `insert into cabinet_verifications
           (id, identifier, value, expires_at, created_at, updated_at)
         values ('verification_old', 'old-password-proof', '{}', $1, $2, $2)`,
        [new Date(NOW.getTime() + 60_000), NOW],
      );
      await pool.query(
        `insert into cabinet_woo_shops
           (account_id, shop_url, consumer_key, consumer_secret, permissions, connected_at)
         values ('person_p2', 'https://shop.example', 'ck_preserved', 'cs_preserved',
                 'read_write', $1)`,
        [NOW],
      );
      await pool.query(
        `insert into cabinet_woo_grants
           (token, account_id, shop_url, expires_at, created_at)
         values ('grant_preserved', 'person_p2', 'https://shop.example', $1, $2)`,
        [new Date(NOW.getTime() + 60_000), NOW],
      );
      await pool.query(
        `insert into cabinet_woo_orders
           (order_id, account_id, woo_order_id, woo_order_number, attempted_at, placed_at)
         values ('order_preserved', 'person_p2', '42', '0042', $1, $1)`,
        [NOW],
      );
      const beforeAccounts = (
        await pool.query(
          `select to_jsonb(cabinet_accounts.*) as row from cabinet_accounts order by id`,
        )
      ).rows;
      const beforeWoo = await Promise.all(
        ["cabinet_woo_grants", "cabinet_woo_orders", "cabinet_woo_shops"].map(
          async (table) =>
            (await pool.query(`select to_jsonb(${table}.*) as row from ${table}`)).rows,
        ),
      );

      await run("0005_one_way_in_identity.sql");

      expect(
        (
          await pool.query(
            `select to_jsonb(cabinet_accounts.*) as row from cabinet_accounts order by id`,
          )
        ).rows,
      ).toStrictEqual(beforeAccounts);
      const afterWoo = await Promise.all(
        ["cabinet_woo_grants", "cabinet_woo_orders", "cabinet_woo_shops"].map(
          async (table) =>
            (await pool.query(`select to_jsonb(${table}.*) as row from ${table}`)).rows,
        ),
      );
      expect(afterWoo).toStrictEqual(beforeWoo);
      expect(
        (await pool.query("select count(*)::int as count from cabinet_credentials")).rows[0],
      ).toStrictEqual({ count: 0 });
      expect(
        (await pool.query("select count(*)::int as count from cabinet_sessions")).rows[0],
      ).toStrictEqual({ count: 0 });
      expect(
        (await pool.query("select count(*)::int as count from cabinet_verifications")).rows[0],
      ).toStrictEqual({ count: 0 });
      expect(
        (await pool.query("select email_verified from cabinet_accounts where id='person_p2'")).rows,
      ).toStrictEqual([{ email_verified: false }]);

      await expect(
        pool.query(`update cabinet_accounts set merchant_key = null where id = 'person_p2'`),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("keeps the merchant on every account when the key column goes", async () => {
      // An account names its merchant and nothing more; the key column goes.
      await emptyEverything();
      const files = (await readdir(migrationsIn)).filter((file) => file.endsWith(".sql")).sort();
      const dropped = files.findIndex((file) =>
        /^\d{4}_account_names_its_merchant\.sql$/.test(file),
      );
      expect(dropped, "the migration that drops the key column").toBeGreaterThan(0);
      for (const file of files.slice(0, dropped)) await run(file);
      await pool.query(
        `insert into dashboard_accounts
           (id, email, email_verified, name, created_at, updated_at, merchant_id, merchant_key)
         values ('person_owner', 'owner@example.com', true, '', now(), now(), $1, $2),
                ('person_reader', 'reader@example.com', true, '', now(), now(), null, null)`,
        [MERCHANT, A_KEY_ON_THE_ROW],
      );

      await run(files[dropped] ?? "");

      expect(
        (await pool.query(`select email, merchant_id from dashboard_accounts order by email`)).rows,
      ).toStrictEqual([
        { email: "owner@example.com", merchant_id: MERCHANT },
        { email: "reader@example.com", merchant_id: null },
      ]);
      const columns = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'dashboard_accounts'`,
      );
      expect(columns.rows.map((column) => column.column_name)).not.toContain("merchant_key");
      // An empty identifier is neither a merchant nor none, and stays refused.
      await expect(
        pool.query(`update dashboard_accounts set merchant_id = '' where id = 'person_reader'`),
      ).rejects.toMatchObject({ code: "23514", constraint: "dashboard_accounts_merchant_named" });
    });

    it("makes nobody an operator when the flag arrives on accounts already there", async () => {
      await emptyEverything();
      const files = (await readdir(migrationsIn)).filter((file) => file.endsWith(".sql")).sort();
      const flag = files.findIndex((file) => /^\d{4}_the_operator_flag\.sql$/.test(file));
      expect(flag, "the migration that adds the operator flag").toBeGreaterThan(0);
      for (const file of files.slice(0, flag)) await run(file);
      await pool.query(
        `insert into cabinet_accounts
           (id, email, email_verified, name, created_at, updated_at, merchant_id, merchant_key)
         values ('person_before', 'before@example.com', true, '', now(), now(), null, null)`,
      );

      // The flag's own migration and nothing after it: the tables still carry
      // their names from then.
      await run(files[flag] ?? "");

      expect(
        (await pool.query(`select email, "operator" from cabinet_accounts`)).rows,
      ).toStrictEqual([{ email: "before@example.com", operator: false }]);
    });

    it("refuses a partial merchant pair before deleting any legacy row", async () => {
      await pool.query(
        `insert into cabinet_accounts
           (id, email, email_verified, name, created_at, updated_at, merchant_id, merchant_key)
         values ('person_corrupt', 'corrupt@example.com', false, '', $1, $1,
                 'mer_only_half', null)`,
        [NOW],
      );
      await pool.query(
        `insert into cabinet_credentials
           (id, user_id, provider_id, account_id, issuer, password, created_at, updated_at)
         values ('credential_must_survive', 'person_corrupt', 'credential', 'person_corrupt',
                 'local', 'derived-password', $1, $1)`,
        [NOW],
      );

      await expect(run("0005_one_way_in_identity.sql")).rejects.toThrow(
        /partial merchant binding/i,
      );

      expect((await pool.query("select id from cabinet_credentials")).rows).toStrictEqual([
        { id: "credential_must_survive" },
      ]);
      expect(
        (await pool.query(`select to_regclass('public.cabinet_link_sends') is not null as made`))
          .rows[0],
      ).toStrictEqual({ made: false });
    });
  });

  describe("the passwordless identity on PostgreSQL", () => {
    beforeEach(async () => {
      await emptyEverything();
      await migrateEverything();
    });

    describe("Google sign-in transactions", () => {
      afterEach(() => {
        vi.unstubAllGlobals();
      });

      function setupGoogle() {
        const google = googleExchange();
        vi.stubGlobal("fetch", google.fetch);
        const identity = identityFor(
          { ...config(), google: { clientId: "offline-client", clientSecret: "offline-secret" } },
          { pool },
        );
        const start = async (profile: Partial<GoogleProfile> = {}) => {
          const began = await identity.startGoogle("settings");
          if (began.status !== "redirect") throw new Error("Google must start");
          return {
            query: google.authorize(began.location, profile),
            cookie: cookieHeader(began.setCookies),
          };
        };
        return { identity, start, google };
      }

      it("serializes independent first Google callbacks for the same person", async () => {
        const { identity, start, google } = setupGoogle();
        const first = await start();
        const second = await start();
        const opened = await Promise.all([
          identity.finishGoogle(first.query, first.cookie),
          identity.finishGoogle(second.query, second.cookie),
        ]);
        expect(opened[0]).toMatchObject({ status: "opened" });
        expect(opened[1]).toMatchObject({ status: "opened" });
        if (opened[0]?.status !== "opened" || opened[1]?.status !== "opened")
          throw new Error("both callbacks should open");
        expect(opened[0].person.id).toBe(opened[1].person.id);
        expect(
          (await pool.query("select count(*)::int as n from dashboard_accounts")).rows[0],
        ).toEqual({ n: 1 });
        expect(
          (await pool.query("select count(*)::int as n from dashboard_sessions")).rows[0],
        ).toEqual({ n: 2 });
        const stored = (await pool.query("select * from dashboard_credentials")).rows;
        expect(stored).toHaveLength(1);
        for (const token of google.issuedTokens)
          expect(JSON.stringify(stored)).not.toContain(token);
      });

      it("holds the scanner's email lock before creating a Google person or session", async () => {
        const { identity, start } = setupGoogle();
        const flow = await start();
        const blocker = await pool.connect();
        await blocker.query("begin");
        await blocker.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          "dashboard-email:person@gmail.com",
        ]);
        const pid = (await blocker.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        const pending = identity.finishGoogle(flow.query, flow.cookie);
        try {
          await expect
            .poll(
              async () =>
                (
                  await pool.query(
                    "select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
                    [pid],
                  )
                ).rows[0].n,
              { timeout: 3000 },
            )
            .toBe(1);
          expect(
            (await pool.query("select count(*)::int as n from dashboard_accounts")).rows[0],
          ).toEqual({ n: 0 });
          expect(
            (await pool.query("select count(*)::int as n from dashboard_sessions")).rows[0],
          ).toEqual({ n: 0 });
        } finally {
          await blocker.query("rollback");
          blocker.release();
        }
        expect(await pending).toMatchObject({ status: "opened" });
      });

      it("rolls person and Google binding back if the session cannot commit", async () => {
        const { identity, start } = setupGoogle();
        const flow = await start();
        await pool.query(
          `create function fail_google_session() returns trigger language plpgsql as $$ begin raise exception 'injected session failure'; end $$`,
        );
        await pool.query(
          "create trigger fail_google_session before insert on dashboard_sessions for each row execute function fail_google_session()",
        );
        const refused = await identity.finishGoogle(flow.query, flow.cookie);
        expect(refused).toMatchObject({ status: "refused", reason: "unavailable", setCookies: [] });
        for (const table of ["dashboard_accounts", "dashboard_credentials", "dashboard_sessions"]) {
          expect((await pool.query(`select count(*)::int as n from ${table}`)).rows[0]).toEqual({
            n: 0,
          });
        }
        await pool.query("drop trigger fail_google_session on dashboard_sessions");
        await pool.query("drop function fail_google_session()");
        const retry = await start();
        expect(await identity.finishGoogle(retry.query, retry.cookie)).toMatchObject({
          status: "opened",
        });
      });
    });

    it("commits token, new person and session together, then consumes only once", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);

      await expect(
        identity.requestLink(" Person@Example.com ", "settings", ONE_CLIENT),
      ).resolves.toStrictEqual({
        status: "accepted",
        retryAt: expect.any(Date),
      });
      expect(
        (await pool.query("select count(*)::int as count from dashboard_accounts")).rows[0],
      ).toStrictEqual({ count: 0 });

      const token = tokenIn(messages[0] as Message);
      const opened = await identity.openLink(token);
      expect(opened).toMatchObject({
        status: "opened",
        destination: "settings",
        person: { email: "person@example.com", confirmed: true, merchant: null },
      });
      expect(
        (await pool.query("select count(*)::int as count from dashboard_sessions")).rows[0],
      ).toStrictEqual({ count: 1 });
      await expect(identity.openLink(token)).resolves.toStrictEqual({ status: "refused" });
    });

    it("serializes two independent first links for one new person", async () => {
      const messages: Message[] = [];
      const one = identityOn(messages);
      const two = identityOn(messages);
      await one.requestLink("person@example.com", "default", ONE_CLIENT);
      await rewindLinkSends();
      await two.requestLink("person@example.com", "settings", ONE_CLIENT);
      await pool.query(`
        create function slow_dashboard_person() returns trigger language plpgsql as $$
        begin perform pg_sleep(0.05); return new; end $$
      `);
      await pool.query(`
        create trigger slow_dashboard_person before insert on dashboard_accounts
        for each row execute function slow_dashboard_person()
      `);

      const [first, second] = await Promise.all([
        one.openLink(tokenIn(messages[0] as Message)),
        two.openLink(tokenIn(messages[1] as Message)),
      ]);

      expect(first).toMatchObject({ status: "opened", destination: "default" });
      expect(second).toMatchObject({ status: "opened", destination: "settings" });
      if (first.status !== "opened" || second.status !== "opened") {
        throw new Error("both independent dashboard links should open");
      }
      expect(second.person.id).toBe(first.person.id);
      expect(
        (await pool.query("select count(*)::int as count from dashboard_accounts")).rows[0],
      ).toStrictEqual({ count: 1 });
      expect(
        (await pool.query("select count(*)::int as count from dashboard_sessions")).rows[0],
      ).toStrictEqual({ count: 2 });
    });

    it("refuses the second of two presses of one link at once, rather than failing it", async () => {
      // The second press finds the link before the first spends it, then waits
      // on the address's lock; by the time the component looks again the link is
      // spent, and that is a refusal like any other.
      const messages: Message[] = [];
      const one = identityOn(messages);
      const two = identityOn(messages);
      await one.requestLink("person@example.com", "default", ONE_CLIENT);
      const token = tokenIn(messages[0] as Message);
      await pool.query(`
        create function slow_dashboard_person() returns trigger language plpgsql as $$
        begin perform pg_sleep(0.05); return new; end $$
      `);
      await pool.query(`
        create trigger slow_dashboard_person before insert on dashboard_accounts
        for each row execute function slow_dashboard_person()
      `);

      const [first, second] = await Promise.all([one.openLink(token), two.openLink(token)]);

      expect([first.status, second.status].sort()).toStrictEqual(["opened", "refused"]);
      expect(
        (await pool.query("select count(*)::int as count from dashboard_accounts")).rows[0],
      ).toStrictEqual({ count: 1 });
      expect(
        (await pool.query("select count(*)::int as count from dashboard_sessions")).rows[0],
      ).toStrictEqual({ count: 1 });
    });

    it("rolls token consumption and person creation back when session creation fails", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      await identity.requestLink("person@example.com", "default", ONE_CLIENT);
      const token = tokenIn(messages[0] as Message);
      await pool.query(`
        create function fail_dashboard_session() returns trigger language plpgsql as $$
        begin raise exception 'injected session failure'; end $$
      `);
      await pool.query(`
        create trigger fail_dashboard_session before insert on dashboard_sessions
        for each row execute function fail_dashboard_session()
      `);

      await expect(identity.openLink(token)).rejects.toThrow(/insert into "dashboard_sessions"/i);

      expect(
        (await pool.query("select count(*)::int as count from dashboard_accounts")).rows[0],
      ).toStrictEqual({ count: 0 });
      expect(
        (await pool.query("select count(*)::int as count from dashboard_sessions")).rows[0],
      ).toStrictEqual({ count: 0 });
      expect(
        (await pool.query("select count(*)::int as count from dashboard_verifications")).rows[0],
      ).toStrictEqual({ count: 1 });
      await pool.query("drop trigger fail_dashboard_session on dashboard_sessions");
      await pool.query("drop function fail_dashboard_session()");
      await expect(identity.openLink(token)).resolves.toMatchObject({ status: "opened" });
    });

    it("rolls the hashed token and rate event back when delivery is refused", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages, "refused");

      await expect(
        identity.requestLink("person@example.com", "default", ONE_CLIENT),
      ).resolves.toStrictEqual({
        status: "unavailable",
      });

      expect(
        (await pool.query("select count(*)::int as count from dashboard_verifications")).rows[0],
      ).toStrictEqual({ count: 0 });
      expect(
        (await pool.query("select count(*)::int as count from dashboard_link_sends")).rows[0],
      ).toStrictEqual({ count: 0 });
      expect(
        (await pool.query("select count(*)::int as count from dashboard_accounts")).rows[0],
      ).toStrictEqual({ count: 0 });
    });

    it("removes another address's unpressed link a week past its end when a link is asked for, and keeps a younger one", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const aWeek = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      await pool.query(
        `insert into dashboard_verifications
           (id, identifier, value, expires_at, created_at, updated_at)
         values
           ('younger', 'younger', $1, $2, $4, $4),
           ('older', 'older', $1, $3, $4, $4)`,
        [
          JSON.stringify({ email: "other@example.com", destination: "default", request: null }),
          new Date(now - aWeek + 60_000),
          new Date(now - aWeek - 1),
          new Date(now - aWeek - 60 * 60 * 1000),
        ],
      );

      await identity.requestLink("person@example.com", "default", ONE_CLIENT);

      const kept = (
        await pool.query<{ id: string }>("select id from dashboard_verifications")
      ).rows.map((row) => row.id);
      expect(kept).toContain("younger");
      expect(kept).not.toContain("older");
      expect(kept).toHaveLength(2);
    });

    it("still removes week-old unpressed links when the mail provider refuses the link asked for", async () => {
      const identity = identityOn([], "refused");
      const aWeek = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      await pool.query(
        `insert into dashboard_verifications
           (id, identifier, value, expires_at, created_at, updated_at)
         values
           ('younger', 'younger', $1, $2, $4, $4),
           ('older', 'older', $1, $3, $4, $4)`,
        [
          JSON.stringify({ email: "other@example.com", destination: "default", request: null }),
          new Date(now - aWeek + 60_000),
          new Date(now - aWeek - 1),
          new Date(now - aWeek - 60 * 60 * 1000),
        ],
      );

      await expect(
        identity.requestLink("person@example.com", "default", ONE_CLIENT),
      ).resolves.toStrictEqual({
        status: "unavailable",
      });

      expect(
        (await pool.query<{ id: string }>("select id from dashboard_verifications")).rows,
      ).toStrictEqual([{ id: "younger" }]);
    });

    it("keeps a seeded merchant unconfirmed until that mailbox consumes a link", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const seeded = await identity.make("person@example.com", MERCHANT);

      expect(seeded).toMatchObject({ confirmed: false, merchant: { id: MERCHANT } });
      expect(
        (await pool.query("select count(*)::int as count from dashboard_credentials")).rows[0],
      ).toStrictEqual({ count: 0 });
      expect(
        (await pool.query("select count(*)::int as count from dashboard_sessions")).rows[0],
      ).toStrictEqual({ count: 0 });

      await identity.requestLink("person@example.com", "default", ONE_CLIENT);
      const opened = await identity.openLink(tokenIn(messages[0] as Message));
      expect(opened).toMatchObject({
        status: "opened",
        person: { id: seeded?.id, confirmed: true, merchant: { id: MERCHANT } },
      });
    });

    it("serializes competing attachment retries and sees the committed session first", async () => {
      const messages: Message[] = [];
      const one = identityOn(messages);
      const two = identityOn(messages);
      await one.requestLink("person@example.com", "default", ONE_CLIENT);
      const opened = await one.openLink(tokenIn(messages[0] as Message));
      if (opened.status !== "opened") throw new Error("the P1 link did not open");
      let registrations = 0;
      const register = async () => {
        registrations += 1;
        expect(
          (
            await pool.query(
              "select count(*)::int as count from dashboard_sessions where user_id = $1",
              [opened.person.id],
            )
          ).rows[0],
        ).toStrictEqual({ count: 1 });
        await new Promise((resolve) => setTimeout(resolve, 30));
        return MERCHANT;
      };

      const [first, second] = await Promise.all([
        one.attachMerchant(opened.person.id, register),
        two.attachMerchant(opened.person.id, register),
      ]);

      expect(registrations).toBe(1);
      expect([first.status, second.status].sort()).toStrictEqual(["already-attached", "attached"]);
      expect(
        (
          await pool.query("select merchant_id from dashboard_accounts where id = $1", [
            opened.person.id,
          ])
        ).rows,
      ).toStrictEqual([{ merchant_id: MERCHANT }]);
    });

    it("keeps P1 and its session when gateway registration is unavailable", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      await identity.requestLink("person@example.com", "default", ONE_CLIENT);
      const opened = await identity.openLink(tokenIn(messages[0] as Message));
      if (opened.status !== "opened") throw new Error("the P1 link did not open");

      await expect(
        identity.attachMerchant(opened.person.id, async () => null),
      ).resolves.toMatchObject({
        status: "unavailable",
        person: { merchant: null },
      });
      expect(await identity.whoIs(cookieHeader(opened.setCookies))).toMatchObject({
        person: { id: opened.person.id, merchant: null },
      });
    });

    it("names a merchant's accounts, ends every session of them, the pressing one included, and gives the pressing browser a new one", async () => {
      // On PostgreSQL the account's merchant is a column the component maps, so
      // the lookup is checked here and not only on the memory store.
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const signedIn = async (email: string, merchant: string): Promise<string> => {
        await identity.make(email, merchant);
        await identity.requestLink(email, "default", ONE_CLIENT);
        const opened = await identity.openLink(tokenIn(messages.at(-1) as Message));
        if (opened.status !== "opened") throw new Error(`${email} could not sign in`);
        return opened.setCookies.map((line) => line.split(";")[0]).join("; ");
      };
      const pressed = await signedIn("owner@example.com", MERCHANT);
      const partner = await signedIn("partner@example.com", MERCHANT);
      const elsewhere = await signedIn("stranger@example.com", "mer_another");

      expect([...(await identity.emailsNaming(MERCHANT))].sort()).toStrictEqual([
        "owner@example.com",
        "partner@example.com",
      ]);
      const signedInAt = (await identity.whoIs(pressed))?.signedInAt;
      const renewed = await identity.endMerchantSessionsAndRenew(MERCHANT, pressed);
      const fresh = renewed.setCookies.map((line) => line.split(";")[0]).join("; ");

      expect(renewed.ended).toBe(2);
      expect(fresh).not.toBe(pressed);
      expect(await identity.whoIs(pressed)).toBeNull();
      expect(await identity.whoIs(partner)).toBeNull();
      const now = await identity.whoIs(fresh);
      expect(now?.person.email).toBe("owner@example.com");
      // Renewed, not signed in again: the moment a rate notice names stays the
      // sign-in the owner made.
      expect(now?.signedInAt).toStrictEqual(signedInAt);
      expect((await identity.whoIs(elsewhere))?.person.email).toBe("stranger@example.com");
    });

    it.each([
      ["this account's", "person"],
      ["the merchant's", "merchant"],
    ] as const)(
      "ends %s live sessions behind more than a hundred expired rows, and counts only the live ones",
      async (_whose, reach) => {
        // Expired session rows are never deleted and the store reads at most a
        // hundred rows at a time; a sign-out that read only the first hundred
        // would find them all expired and leave a live one signed in.
        const messages: Message[] = [];
        const identity = identityOn(messages);
        const signedIn = async (email: string): Promise<string> => {
          await rewindLinkSends();
          await identity.requestLink(email, "default", ONE_CLIENT);
          const opened = await identity.openLink(tokenIn(messages.at(-1) as Message));
          if (opened.status !== "opened") throw new Error(`${email} could not sign in`);
          return opened.setCookies.map((line) => line.split(";")[0]).join("; ");
        };
        const owner = await identity.make("owner@example.com", MERCHANT);
        if (owner === null) throw new Error("the owner's account was not made");
        const laptop = await signedIn("owner@example.com");
        await pool.query(
          `insert into dashboard_sessions (id, token, user_id, expires_at, created_at, updated_at)
             select 'expired_' || n, 'expired-token-' || n, $1,
                    now() - interval '60 days', now() - interval '90 days', now() - interval '90 days'
               from generate_series(1, 120) as n`,
          [owner.id],
        );
        // Rewriting the live row moves it behind the expired ones, where a read
        // that stops at a hundred never reaches it.
        await pool.query(
          "update dashboard_sessions set updated_at = updated_at where user_id = $1 and expires_at > now()",
          [owner.id],
        );
        const pressed = await signedIn("owner@example.com");

        if (reach === "person") {
          expect(await identity.endSessionsOfPerson(owner.id)).toBe(2);
        } else {
          expect((await identity.endMerchantSessionsAndRenew(MERCHANT, pressed)).ended).toBe(2);
        }
        expect(await identity.whoIs(pressed)).toBeNull();
        expect(await identity.whoIs(laptop)).toBeNull();
      },
    );

    it("ends more than a hundred live sessions of one account, reading again until none is left", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const owner = await identity.make("owner@example.com", MERCHANT);
      if (owner === null) throw new Error("the owner's account was not made");
      await identity.requestLink("owner@example.com", "default", ONE_CLIENT);
      const opened = await identity.openLink(tokenIn(messages.at(-1) as Message));
      if (opened.status !== "opened") throw new Error("the owner could not sign in");
      const pressed = opened.setCookies.map((line) => line.split(";")[0]).join("; ");
      await pool.query(
        `insert into dashboard_sessions (id, token, user_id, expires_at, created_at, updated_at)
           select 'live_' || n, 'live-token-' || n, $1,
                  now() + interval '20 days', now(), now()
             from generate_series(1, 150) as n`,
        [owner.id],
      );

      expect(await identity.endSessionsOfPerson(owner.id)).toBe(151);
      expect(
        (
          await pool.query("select count(*)::int as n from dashboard_sessions where user_id = $1", [
            owner.id,
          ])
        ).rows[0],
      ).toStrictEqual({ n: 0 });
      expect(await identity.whoIs(pressed)).toBeNull();
    });

    it("ends every session of one account, the pressing one included, and leaves another account's alone", async () => {
      // On PostgreSQL the sessions are rows the component reads by account, so
      // the reach of the call is checked here and not only on the memory store.
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const signedIn = async (email: string): Promise<string> => {
        await rewindLinkSends();
        await identity.requestLink(email, "default", ONE_CLIENT);
        const opened = await identity.openLink(tokenIn(messages.at(-1) as Message));
        if (opened.status !== "opened") throw new Error(`${email} could not sign in`);
        return opened.setCookies.map((line) => line.split(";")[0]).join("; ");
      };
      const owner = await identity.make("owner@example.com", MERCHANT);
      if (owner === null) throw new Error("the owner's account was not made");
      await identity.make("partner@example.com", MERCHANT);
      const pressed = await signedIn("owner@example.com");
      const laptop = await signedIn("owner@example.com");
      const partner = await signedIn("partner@example.com");

      expect(await identity.endSessionsOfPerson(owner.id)).toBe(2);
      expect(await identity.whoIs(pressed)).toBeNull();
      expect(await identity.whoIs(laptop)).toBeNull();
      expect((await identity.whoIs(partner))?.person.email).toBe("partner@example.com");
    });

    it("keeps the operator flag off until the terminal sets it, and a session reads it afresh", async () => {
      // A sign-in writes the row without the flag; only the terminal's call
      // sets it, and an open session sees the change on its next read.
      const messages: Message[] = [];
      const identity = identityOn(messages);
      await identity.requestLink("operator@example.com", "default", ONE_CLIENT);
      const opened = await identity.openLink(tokenIn(messages[0] as Message));
      if (opened.status !== "opened") throw new Error("the link should have opened");
      const cookie = cookieHeader(opened.setCookies);

      expect((await pool.query(`select "operator" from dashboard_accounts`)).rows).toStrictEqual([
        { operator: false },
      ]);
      expect((await identity.whoIs(cookie, { renew: false }))?.operator).toBe(false);

      await expect(identity.setOperator(" Operator@Example.com ", true)).resolves.toBe(true);
      expect((await identity.whoIs(cookie, { renew: false }))?.operator).toBe(true);
      expect(
        (await identity.list(new Date())).map(({ email, operator }) => ({ email, operator })),
      ).toStrictEqual([{ email: "operator@example.com", operator: true }]);

      await expect(identity.setOperator("operator@example.com", false)).resolves.toBe(true);
      expect((await identity.whoIs(cookie, { renew: false }))?.operator).toBe(false);

      await expect(identity.setOperator("nobody@example.com", true)).resolves.toBe(false);
      expect(
        (await pool.query("select count(*)::int as count from dashboard_sessions")).rows[0],
      ).toStrictEqual({ count: 1 });
      expect(
        (await pool.query("select count(*)::int as count from dashboard_accounts")).rows[0],
      ).toStrictEqual({ count: 1 });
    });

    it("enforces a minute between links and three sends per rolling hour without storing the raw address", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      await expect(
        identity.requestLink("person@example.com", "default", ONE_CLIENT),
      ).resolves.toStrictEqual({
        status: "accepted",
        retryAt: expect.any(Date),
      });
      await expect(
        identity.requestLink("person@example.com", "default", ONE_CLIENT),
      ).resolves.toMatchObject({
        status: "cooldown",
        wall: "interval",
        retryAt: expect.any(Date),
      });
      // The refused request sent nothing, so it does not count toward the
      // hourly limit.
      expect(
        (await pool.query("select count(*)::int as count from dashboard_link_sends")).rows[0],
      ).toStrictEqual({ count: 1 });
      expect(messages).toHaveLength(1);

      let latest: Awaited<ReturnType<typeof identity.requestLink>> | undefined;
      for (let count = 0; count < 2; count += 1) {
        await rewindLinkSends();
        latest = await identity.requestLink("person@example.com", "default", ONE_CLIENT);
        expect(latest).toStrictEqual({ status: "accepted", retryAt: expect.any(Date) });
      }
      // The third link of the hour spent the allowance, so the wait is the rest
      // of the hour, not the minute.
      const oldest = (await pool.query("select min(sent_at) as at from dashboard_link_sends"))
        .rows[0] as { at: Date };
      if (latest?.status !== "accepted") throw new Error("the third link should have gone out");
      expect(latest.retryAt).toStrictEqual(new Date(oldest.at.getTime() + LINK_RATE_WINDOW_MS));
      expect(latest.retryAt.getTime() - Date.now()).toBeGreaterThan(LINK_MIN_INTERVAL_MS);
      await rewindLinkSends();
      await expect(
        identity.requestLink("person@example.com", "default", ONE_CLIENT),
      ).resolves.toMatchObject({
        status: "cooldown",
        wall: "hourly",
        retryAt: expect.any(Date),
      });
      const evidence = await pool.query("select email_hash from dashboard_link_sends");
      expect(evidence.rows).toHaveLength(3);
      expect(JSON.stringify(evidence.rows)).not.toContain("person@example.com");
    });

    it("counts one client's links across two processes, at once as well as one after another, and still lets another client's out", async () => {
      const messages: Message[] = [];
      const one = identityOn(messages);
      const two = identityOn(messages);
      const crowded = { client: "198.51.100.7" };

      const answers = await Promise.all(
        Array.from({ length: LINK_CLIENT_LIMIT + 4 }, (_, sent) =>
          (sent % 2 === 0 ? one : two).requestLink(
            `person-${sent}@example.com`,
            "default",
            crowded,
          ),
        ),
      );

      expect(answers.filter((answer) => answer.status === "accepted")).toHaveLength(
        LINK_CLIENT_LIMIT,
      );
      expect(answers.filter((answer) => answer.status === "cooldown")).toStrictEqual(
        Array.from({ length: 4 }, () => ({
          status: "cooldown",
          wall: "client",
          retryAt: expect.any(Date),
        })),
      );
      expect(messages).toHaveLength(LINK_CLIENT_LIMIT);
      await expect(
        two.requestLink("one-more@example.com", "default", crowded),
      ).resolves.toMatchObject({ status: "cooldown", wall: "client" });
      await expect(
        one.requestLink("one-more@example.com", "default", { client: "198.51.100.8" }),
      ).resolves.toMatchObject({ status: "accepted" });
      const evidence = await pool.query("select * from dashboard_link_sends");
      expect(JSON.stringify(evidence.rows)).not.toContain("198.51.100");
    });

    it("refuses every client once the channel has sent its hour's links, and lets them out once the hour has passed", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      await pool.query(
        `insert into dashboard_link_sends (id, email_hash, purpose, sent_at, expires_at)
         select 'arranged-' || n, md5('arranged-' || n), 'dashboard', now(), now() + interval '7 days'
         from generate_series(1, $1::int) as n`,
        [LINK_CHANNEL_LIMIT],
      );

      for (const client of ["198.51.100.7", "198.51.100.8"]) {
        await expect(
          identity.requestLink(`${client}@example.com`, "default", { client }),
        ).resolves.toMatchObject({
          status: "cooldown",
          wall: "ceiling",
          retryAt: expect.any(Date),
        });
      }
      expect(messages).toHaveLength(0);

      await pool.query("update dashboard_link_sends set sent_at = sent_at - interval '1 hour'");

      await expect(
        identity.requestLink("person@example.com", "default", { client: "198.51.100.7" }),
      ).resolves.toMatchObject({ status: "accepted" });
      expect(messages).toHaveLength(1);
    });
  });
  /**
   * Synthetic: each passes the partner click identifier's pattern and was never
   * issued by any tracker.
   */
  const CLICK = "qa_click_0123456789abcdef";
  const ANOTHER_CLICK = "qa_click_fedcba9876543210";
  const SCAN = "019b41a0-7c51-7d63-84bd-a5a20faef497";
  const REQUEST = "019b41a0-7c51-7d63-84bd-a5a20faef498";
  const OPERATION = "019b41a0-7c51-7d63-84bd-a5a20faef497";

  async function registrations(): Promise<Record<string, unknown>[]> {
    return (
      await pool.query(
        `select account_id, click_id, state, attempts, next_attempt_at, last_outcome, created_at,
                event_at, settled_at
           from dashboard_ad_reports where event = 'reg' order by account_id`,
      )
    ).rows;
  }

  /**
   * Each new account waits a moment before it is written, so two transactions
   * that would both make one overlap.
   */
  async function slowAccountInserts(): Promise<void> {
    await pool.query(`
      create function slow_dashboard_person() returns trigger language plpgsql as $$
      begin perform pg_sleep(0.05); return new; end $$
    `);
    await pool.query(`
      create trigger slow_dashboard_person before insert on dashboard_accounts
      for each row execute function slow_dashboard_person()
    `);
  }

  async function countIn(table: string): Promise<number> {
    return (await pool.query<{ count: number }>(`select count(*)::int as count from ${table}`))
      .rows[0]?.count as number;
  }

  describe("the registration a link asked for with an ad's click leaves for the tracker, on PostgreSQL", () => {
    beforeEach(async () => {
      await emptyEverything();
      await migrateEverything();
    });

    it("leaves one pending registration holding the click, and nothing else of the sign-in, when the link makes a new address's account", async () => {
      const messages: Message[] = [];
      const identity = reportingOn(messages);
      await identity.requestLink("person@example.com", "default", {
        ...ONE_CLIENT,
        clickId: CLICK,
      });
      const pressedAt = Date.now();

      const opened = await identity.openLink(tokenIn(messages[0] as Message));

      if (opened.status !== "opened") throw new Error("the link did not open");
      expect(opened.person).toMatchObject({ email: "person@example.com", confirmed: true });
      const stored = await registrations();
      expect(stored).toStrictEqual([
        {
          account_id: opened.person.id,
          click_id: CLICK,
          state: "pending",
          attempts: 0,
          next_attempt_at: expect.any(Date),
          last_outcome: null,
          created_at: expect.any(Date),
          event_at: expect.any(Date),
          settled_at: null,
        },
      ]);
      // Due at once: nothing about a new registration is worth waiting for.
      const due = new Date(stored[0]?.next_attempt_at as Date).getTime();
      expect(due).toBeGreaterThanOrEqual(pressedAt);
      expect(due).toBeLessThanOrEqual(Date.now());
    });

    it("writes no registration when the link asked for while reporting was on is opened after it went off", async () => {
      const messages: Message[] = [];
      await reportingOn(messages).requestLink("person@example.com", "default", {
        ...ONE_CLIENT,
        clickId: CLICK,
      });

      const opened = await identityOn(messages).openLink(tokenIn(messages[0] as Message));

      expect(opened).toMatchObject({ status: "opened", person: { confirmed: true } });
      expect(await registrations()).toStrictEqual([]);
    });

    it("leaves no registration when the link was asked for without a click", async () => {
      const messages: Message[] = [];
      const identity = reportingOn(messages);
      await identity.requestLink("person@example.com", "default", ONE_CLIENT);

      await expect(identity.openLink(tokenIn(messages[0] as Message))).resolves.toMatchObject({
        status: "opened",
      });

      expect(await countIn("dashboard_accounts")).toBe(1);
      expect(await registrations()).toStrictEqual([]);
    });

    it("writes no registration for an address that already has a verified account, even with a fresh click", async () => {
      const messages: Message[] = [];
      const identity = reportingOn(messages);
      await identity.requestLink("person@example.com", "default", ONE_CLIENT);
      await identity.openLink(tokenIn(messages[0] as Message));
      await rewindLinkSends();
      await identity.requestLink("person@example.com", "default", {
        ...ONE_CLIENT,
        clickId: CLICK,
      });

      await expect(identity.openLink(tokenIn(messages[1] as Message))).resolves.toMatchObject({
        status: "opened",
      });

      expect(await countIn("dashboard_accounts")).toBe(1);
      expect(await registrations()).toStrictEqual([]);
    });

    it("writes one registration for an address whose only account the operator made unverified, at its first verification", async () => {
      const messages: Message[] = [];
      const identity = reportingOn(messages);
      const made = await identity.make("person@example.com", MERCHANT);
      if (made === null) throw new Error("the account was not made");
      await identity.requestLink("person@example.com", "default", {
        ...ONE_CLIENT,
        clickId: CLICK,
      });

      await expect(identity.openLink(tokenIn(messages[0] as Message))).resolves.toMatchObject({
        status: "opened",
        person: { id: made.id, confirmed: true, merchant: { id: MERCHANT } },
      });

      expect(await registrations()).toMatchObject([{ account_id: made.id, click_id: CLICK }]);
      expect(await countIn("dashboard_ad_reports")).toBe(2);
    });

    it("writes nothing for a token that opens nothing or for the landing page's read, and one registration for a link opened twice", async () => {
      const messages: Message[] = [];
      const identity = reportingOn(messages);
      await identity.requestLink("person@example.com", "default", {
        ...ONE_CLIENT,
        clickId: CLICK,
      });
      const token = tokenIn(messages[0] as Message);

      expect(await identity.landingOf(token)).toStrictEqual({ email: "person@example.com" });
      await expect(identity.openLink("short")).resolves.toStrictEqual({
        status: "refused",
      });
      await expect(identity.openLink("A".repeat(32))).resolves.toStrictEqual({
        status: "refused",
      });
      await pool.query(
        "update dashboard_verifications set expires_at = now() - interval '1 second'",
      );
      await expect(identity.openLink(token)).resolves.toStrictEqual({ status: "refused" });
      expect(await countIn("dashboard_accounts")).toBe(0);
      expect(await registrations()).toStrictEqual([]);

      await pool.query("update dashboard_verifications set expires_at = now() + interval '1 hour'");
      await expect(identity.openLink(token)).resolves.toMatchObject({ status: "opened" });
      await expect(identity.openLink(token)).resolves.toStrictEqual({ status: "refused" });
      expect(await registrations()).toHaveLength(1);
      expect(await countIn("dashboard_ad_reports")).toBe(2);
    });

    it("writes no registration for a report link opened by a new address", async () => {
      const messages: Message[] = [];
      const identity = reportingOn(messages);
      await identity.sendReportLink({
        operation: "send",
        email: "person@example.com",
        destination: { report: SCAN },
        request: REQUEST,
      });

      await expect(identity.openLink(tokenIn(messages[0] as Message))).resolves.toMatchObject({
        status: "opened",
      });

      expect(await countIn("dashboard_accounts")).toBe(1);
      expect(await registrations()).toStrictEqual([]);
    });

    it.each([
      ["its session", "dashboard_sessions"],
      ["its registration", "dashboard_ad_reports"],
    ])(
      "leaves neither the account, its session nor its registration when %s cannot be written, and the link still opens",
      async (_what, table) => {
        // One transaction: an account committed without its registration would
        // never be reported, and a registration without its account would
        // report somebody who never signed in.
        const messages: Message[] = [];
        const identity = reportingOn(messages);
        await identity.requestLink("person@example.com", "default", {
          ...ONE_CLIENT,
          clickId: CLICK,
        });
        const token = tokenIn(messages[0] as Message);
        await pool.query(`
          create function fail_dashboard_insert() returns trigger language plpgsql as $$
          begin raise exception 'injected insert failure'; end $$
        `);
        await pool.query(`
          create trigger fail_dashboard_insert before insert on ${table}
          for each row execute function fail_dashboard_insert()
        `);

        await expect(identity.openLink(token)).rejects.toThrow();

        expect(await countIn("dashboard_accounts")).toBe(0);
        expect(await countIn("dashboard_sessions")).toBe(0);
        expect(await countIn("dashboard_ad_reports")).toBe(0);
        expect(await countIn("dashboard_verifications")).toBe(1);
        await pool.query(`drop trigger fail_dashboard_insert on ${table}`);
        await pool.query("drop function fail_dashboard_insert()");
        await expect(identity.openLink(token)).resolves.toMatchObject({
          status: "opened",
        });
        expect(await registrations()).toMatchObject([{ click_id: CLICK }]);
      },
    );

    it("makes one account and one registration when the same link is pressed twice at once", async () => {
      const messages: Message[] = [];
      const one = reportingOn(messages);
      const two = reportingOn(messages);
      await one.requestLink("person@example.com", "default", { ...ONE_CLIENT, clickId: CLICK });
      const token = tokenIn(messages[0] as Message);
      await slowAccountInserts();

      const [first, second] = await Promise.all([one.openLink(token), two.openLink(token)]);

      expect([first.status, second.status].sort()).toStrictEqual(["opened", "refused"]);
      expect(await countIn("dashboard_accounts")).toBe(1);
      expect(await registrations()).toMatchObject([{ click_id: CLICK }]);
      expect(await countIn("dashboard_ad_reports")).toBe(2);
    });

    it("makes one account and one registration when two links with clicks for one new address are opened at once", async () => {
      const messages: Message[] = [];
      const one = reportingOn(messages);
      const two = reportingOn(messages);
      await one.requestLink("person@example.com", "default", { ...ONE_CLIENT, clickId: CLICK });
      await rewindLinkSends();
      await two.requestLink("person@example.com", "settings", {
        ...ONE_CLIENT,
        clickId: ANOTHER_CLICK,
      });
      await slowAccountInserts();

      const [first, second] = await Promise.all([
        one.openLink(tokenIn(messages[0] as Message)),
        two.openLink(tokenIn(messages[1] as Message)),
      ]);

      if (first.status !== "opened" || second.status !== "opened") {
        throw new Error("both links should open");
      }
      expect(second.person.id).toBe(first.person.id);
      expect(await countIn("dashboard_accounts")).toBe(1);
      const stored = await registrations();
      expect(stored).toHaveLength(1);
      expect([CLICK, ANOTHER_CLICK]).toContain(stored[0]?.click_id);
      expect(stored[0]?.account_id).toBe(first.person.id);
    });

    it("adds no registration and leaves the existing one as it was when a merchant is attached afterwards", async () => {
      const messages: Message[] = [];
      const identity = reportingOn(messages);
      await identity.requestLink("person@example.com", "default", {
        ...ONE_CLIENT,
        clickId: CLICK,
      });
      const opened = await identity.openLink(tokenIn(messages[0] as Message));
      if (opened.status !== "opened") throw new Error("the link did not open");
      const before = await registrations();

      await expect(
        identity.attachMerchant(opened.person.id, async () => MERCHANT),
      ).resolves.toMatchObject({ status: "attached" });

      expect(before).toHaveLength(1);
      expect(await registrations()).toStrictEqual(before);
    });

    it("removes the registration with an account deleted for privacy, and keeps another account's", async () => {
      const messages: Message[] = [];
      const identity = reportingOn(messages);
      await identity.requestLink("person@example.com", "default", {
        ...ONE_CLIENT,
        clickId: CLICK,
      });
      await identity.openLink(tokenIn(messages[0] as Message));
      await identity.requestLink("bystander@example.com", "default", {
        ...ONE_CLIENT,
        clickId: ANOTHER_CLICK,
      });
      const bystander = await identity.openLink(tokenIn(messages[1] as Message));
      if (bystander.status !== "opened") throw new Error("the bystander's link did not open");
      expect(await countIn("dashboard_ad_reports")).toBe(4);

      await expect(
        identity.deleteUnattachedPerson({
          operation: "delete",
          operation_id: OPERATION,
          email: "person@example.com",
        }),
      ).resolves.toStrictEqual({ status: "deleted" });

      expect(await registrations()).toMatchObject([
        { account_id: bystander.person.id, click_id: ANOTHER_CLICK },
      ]);
      expect(await countIn("dashboard_ad_reports")).toBe(2);
    });

    it("still opens a link stored in the shape without a click, and writes no registration", async () => {
      const messages: Message[] = [];
      const identity = reportingOn(messages);
      await identity.requestLink("person@example.com", "settings", {
        ...ONE_CLIENT,
        clickId: CLICK,
      });
      await pool.query("update dashboard_verifications set value = $1", [
        JSON.stringify({ email: "person@example.com", destination: "settings", request: null }),
      ]);

      await expect(identity.openLink(tokenIn(messages[0] as Message))).resolves.toMatchObject({
        status: "opened",
        destination: "settings",
      });

      expect(await countIn("dashboard_accounts")).toBe(1);
      expect(await registrations()).toStrictEqual([]);
    });

    it("opens nothing and writes nothing for a stored click outside the closed set", async () => {
      const messages: Message[] = [];
      const identity = reportingOn(messages);
      await identity.requestLink("person@example.com", "default", {
        ...ONE_CLIENT,
        clickId: CLICK,
      });
      const token = tokenIn(messages[0] as Message);
      const dashboard = { email: "person@example.com", destination: "default", request: null };

      for (const claim of [
        { ...dashboard, clickId: "too-short" },
        { ...dashboard, clickId: { id: CLICK } },
        { ...dashboard, clickId: null },
        {
          email: "person@example.com",
          destination: { report: SCAN },
          request: REQUEST,
          clickId: CLICK,
        },
      ]) {
        await pool.query("update dashboard_verifications set value = $1", [JSON.stringify(claim)]);

        await expect(identity.openLink(token), JSON.stringify(claim)).resolves.toStrictEqual({
          status: "refused",
        });
        expect(await countIn("dashboard_verifications")).toBe(1);
        expect(await countIn("dashboard_accounts")).toBe(0);
        expect(await countIn("dashboard_sessions")).toBe(0);
        expect(await registrations()).toStrictEqual([]);
      }
    });

    it("fails the press loudly and spends nothing when the account already holds a registration it could not have", async () => {
      // An unverified account has never been registered, so a row for it is a
      // broken invariant; writing over it or beside it would hide that.
      const messages: Message[] = [];
      const identity = reportingOn(messages);
      const made = await identity.make("person@example.com", MERCHANT);
      if (made === null) throw new Error("the account was not made");
      await pool.query(
        `insert into dashboard_ad_reports
           (account_id, event, click_id, state, attempts, next_attempt_at, created_at, event_at)
         values ($1, 'reg', $2, 'pending', 0, now(), now(), now())`,
        [made.id, ANOTHER_CLICK],
      );
      const planted = await registrations();
      await identity.requestLink("person@example.com", "default", {
        ...ONE_CLIENT,
        clickId: CLICK,
      });

      await expect(identity.openLink(tokenIn(messages[0] as Message))).rejects.toThrow();

      expect(await identity.byId(made.id)).toMatchObject({ confirmed: false });
      expect(await countIn("dashboard_sessions")).toBe(0);
      expect(await countIn("dashboard_verifications")).toBe(1);
      expect(await registrations()).toStrictEqual(planted);
    });

    it.each([
      {
        rule: "a pending row holds a click id",
        constraint: "dashboard_ad_reports_open_holds_click",
        values: "'reg', null, 'pending', now(), now(), null",
      },
      {
        rule: "a waiting row holds a click id",
        constraint: "dashboard_ad_reports_open_holds_click",
        values: "'store_connected', null, 'waiting', null, null, null",
      },
      {
        rule: "a settled row no longer holds the click id",
        constraint: "dashboard_ad_reports_open_holds_click",
        values: "'reg', 'qa_click_0123456789abcdef', 'delivered', null, now(), now()",
      },
      {
        rule: "a lapsed row no longer holds the click id",
        constraint: "dashboard_ad_reports_open_holds_click",
        values: "'store_connected', 'qa_click_0123456789abcdef', 'lapsed', null, null, now()",
      },
      {
        rule: "a pending row has its next attempt",
        constraint: "dashboard_ad_reports_pending_scheduled",
        values: "'reg', 'qa_click_0123456789abcdef', 'pending', null, now(), null",
      },
      {
        rule: "a settled row says when it settled",
        constraint: "dashboard_ad_reports_settled_dated",
        values: "'reg', null, 'given_up', null, now(), null",
      },
      {
        rule: "a row still open has not settled",
        constraint: "dashboard_ad_reports_settled_dated",
        values: "'store_connected', 'qa_click_0123456789abcdef', 'waiting', null, null, now()",
      },
      {
        rule: "a report that went or was due says when its fact happened",
        constraint: "dashboard_ad_reports_fact_dated",
        values: "'store_connected', 'qa_click_0123456789abcdef', 'pending', now(), null, null",
      },
      {
        rule: "a store report still waiting has no fact yet",
        constraint: "dashboard_ad_reports_fact_dated",
        values: "'store_connected', 'qa_click_0123456789abcdef', 'waiting', null, now(), null",
      },
      {
        rule: "only a store report waits or lapses",
        constraint: "dashboard_ad_reports_only_a_store_report_waits",
        values: "'reg', 'qa_click_0123456789abcdef', 'waiting', null, null, null",
      },
      {
        rule: "the event is a registration or a connected store",
        constraint: "dashboard_ad_reports_event",
        values: "'payment', null, 'delivered', null, now(), now()",
      },
      {
        rule: "the state is one of the six",
        constraint: "dashboard_ad_reports_state",
        values: "'reg', null, 'sent', null, now(), now()",
      },
    ])("refuses a report row that breaks the rule that $rule", async ({ constraint, values }) => {
      await pool.query(
        `insert into dashboard_accounts (id, email, email_verified, name, created_at, updated_at)
         values ('acc_checked', 'checked@example.com', true, '', now(), now())`,
      );
      const insert = (columns: string) =>
        pool.query(
          `insert into dashboard_ad_reports
             (account_id, attempts, created_at, event, click_id, state, next_attempt_at, event_at,
              settled_at)
           values ('acc_checked', 0, now(), ${columns})`,
        );

      await expect(insert(values)).rejects.toMatchObject({ code: "23514", constraint });

      await insert("'reg', null, 'delivered', null, now(), now()");
      await insert("'store_connected', 'qa_click_0123456789abcdef', 'waiting', null, null, null");
      expect(
        (await pool.query("select event, state from dashboard_ad_reports order by event")).rows,
      ).toStrictEqual([
        { event: "reg", state: "delivered" },
        { event: "store_connected", state: "waiting" },
      ]);
    });

    it("refuses a second report of one event for one account", async () => {
      await pool.query(
        `insert into dashboard_accounts (id, email, email_verified, name, created_at, updated_at)
         values ('acc_checked', 'checked@example.com', true, '', now(), now())`,
      );
      const insert = () =>
        pool.query(
          `insert into dashboard_ad_reports
             (account_id, event, click_id, state, created_at)
           values ('acc_checked', 'store_connected', 'qa_click_0123456789abcdef', 'waiting', now())`,
        );
      await insert();

      await expect(insert()).rejects.toMatchObject({ code: "23505" });
    });
  });

  describe("the store report a sign-in from an ad's click leaves waiting, on PostgreSQL", () => {
    beforeEach(async () => {
      await emptyEverything();
      await migrateEverything();
    });

    const storeReports = async (): Promise<Record<string, unknown>[]> =>
      (
        await pool.query(
          `select account_id, click_id, state, attempts, next_attempt_at, last_outcome, created_at,
                  event_at, settled_at
             from dashboard_ad_reports where event = 'store_connected' order by account_id`,
        )
      ).rows;

    it("leaves the store report waiting with its own copy of the click beside the registration, dated by the same sign-in, with only the registration report switched on", async () => {
      const messages: Message[] = [];
      const identity = reportingOn(messages);
      await identity.requestLink("person@example.com", "default", {
        ...ONE_CLIENT,
        clickId: CLICK,
      });

      const opened = await identity.openLink(tokenIn(messages[0] as Message));

      if (opened.status !== "opened") throw new Error("the link did not open");
      const [registration] = await registrations();
      expect(await storeReports()).toStrictEqual([
        {
          account_id: opened.person.id,
          click_id: CLICK,
          state: "waiting",
          attempts: 0,
          next_attempt_at: null,
          last_outcome: null,
          created_at: registration?.created_at,
          event_at: null,
          settled_at: null,
        },
      ]);
      expect(registration).toMatchObject({ click_id: CLICK, state: "pending" });
    });

    it("leaves a store report waiting for a Google sign-in from an ad that makes a new address's account", async () => {
      const google = googleExchange();
      vi.stubGlobal("fetch", google.fetch);
      try {
        const identity = identityFor(
          {
            ...config({
              REGISTRATION_POSTBACK_ENABLED: "true",
              REGISTRATION_POSTBACK_KEY: ["qa", "synthetic", "postback", "key"].join("-"),
              REGISTRATION_POSTBACK_URL: "http://127.0.0.1:4010/postback",
            }),
            google: { clientId: "offline-client", clientSecret: "offline-secret" },
          },
          { pool, postman: async () => "accepted" },
        );
        const began = await identity.startGoogle("settings", CLICK);
        if (began.status !== "redirect") throw new Error("Google must start");

        const opened = await identity.finishGoogle(
          google.authorize(began.location, {}),
          cookieHeader(began.setCookies),
        );

        if (opened.status !== "opened") throw new Error("the Google sign-in did not open");
        expect(await storeReports()).toMatchObject([
          { account_id: opened.person.id, click_id: CLICK, state: "waiting", event_at: null },
        ]);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("leaves neither report when the store report cannot be written, and the link still opens", async () => {
      const messages: Message[] = [];
      const identity = reportingOn(messages);
      await identity.requestLink("person@example.com", "default", {
        ...ONE_CLIENT,
        clickId: CLICK,
      });
      const token = tokenIn(messages[0] as Message);
      await pool.query(`
        create function fail_store_report() returns trigger language plpgsql as $$
        begin
          if new.event = 'store_connected' then raise exception 'injected insert failure'; end if;
          return new;
        end $$
      `);
      await pool.query(`
        create trigger fail_store_report before insert on dashboard_ad_reports
        for each row execute function fail_store_report()
      `);

      await expect(identity.openLink(token)).rejects.toThrow();

      expect(await countIn("dashboard_accounts")).toBe(0);
      expect(await countIn("dashboard_ad_reports")).toBe(0);
      await pool.query("drop trigger fail_store_report on dashboard_ad_reports");
      await pool.query("drop function fail_store_report()");
      await expect(identity.openLink(token)).resolves.toMatchObject({ status: "opened" });
      expect(await countIn("dashboard_ad_reports")).toBe(2);
    });

    it("removes both reports with an account deleted for privacy", async () => {
      const messages: Message[] = [];
      const identity = reportingOn(messages);
      await identity.requestLink("person@example.com", "default", {
        ...ONE_CLIENT,
        clickId: CLICK,
      });
      await identity.openLink(tokenIn(messages[0] as Message));
      expect(await countIn("dashboard_ad_reports")).toBe(2);

      await expect(
        identity.deleteUnattachedPerson({
          operation: "delete",
          operation_id: OPERATION,
          email: "person@example.com",
        }),
      ).resolves.toStrictEqual({ status: "deleted" });

      expect(await countIn("dashboard_ad_reports")).toBe(0);
    });
  });

  describe("the migration that gives every report to the ad tracker its event", () => {
    beforeEach(async () => {
      await emptyEverything();
    });

    it("moves every registration report across as it stood, dated by its sign-in, and drops the old table", async () => {
      const files = (await readdir(migrationsIn)).filter((file) => file.endsWith(".sql")).sort();
      const before = files.filter((file) => file < "0017");
      const after = files.filter((file) => file >= "0017");
      for (const file of before) await run(file);
      const signedIn = new Date("2026-10-15T09:00:00.000Z");
      const settled = new Date("2026-10-15T09:00:01.000Z");
      await pool.query(
        `insert into dashboard_accounts (id, email, email_verified, name, created_at, updated_at)
         values ('acc_pending', 'pending@example.com', true, '', $1, $1),
                ('acc_delivered', 'delivered@example.com', true, '', $1, $1)`,
        [signedIn],
      );
      await pool.query(
        `insert into dashboard_registration_postbacks
           (account_id, click_id, state, attempts, next_attempt_at, last_outcome, created_at,
            settled_at)
         values ('acc_pending', $1, 'pending', 2, $2, 'http_503', $2, null),
                ('acc_delivered', null, 'delivered', 1, null, 'http_200', $2, $3)`,
        [CLICK, signedIn, settled],
      );

      for (const file of after) await run(file);

      expect(
        (
          await pool.query(
            `select account_id, event, click_id, state, attempts, next_attempt_at, last_outcome,
                    created_at, event_at, settled_at
               from dashboard_ad_reports order by account_id`,
          )
        ).rows,
      ).toStrictEqual([
        {
          account_id: "acc_delivered",
          event: "reg",
          click_id: null,
          state: "delivered",
          attempts: 1,
          next_attempt_at: null,
          last_outcome: "http_200",
          created_at: signedIn,
          event_at: signedIn,
          settled_at: settled,
        },
        {
          account_id: "acc_pending",
          event: "reg",
          click_id: CLICK,
          state: "pending",
          attempts: 2,
          next_attempt_at: signedIn,
          last_outcome: "http_503",
          created_at: signedIn,
          event_at: signedIn,
          settled_at: null,
        },
      ]);
      expect(
        (await pool.query("select to_regclass('dashboard_registration_postbacks') as old")).rows,
      ).toStrictEqual([{ old: null }]);
    });
  });

  describe("the registration a Google sign-in started with an ad's click leaves for the tracker, on PostgreSQL", () => {
    beforeEach(async () => {
      await emptyEverything();
      await migrateEverything();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Google and the report both switched on, the report posting to a laptop's receiver. */
    function reportingGoogle(messages: Message[] = []) {
      const google = googleExchange();
      vi.stubGlobal("fetch", google.fetch);
      const identity = identityFor(
        {
          ...config({
            REGISTRATION_POSTBACK_ENABLED: "true",
            REGISTRATION_POSTBACK_KEY: ["qa", "synthetic", "postback", "key"].join("-"),
            REGISTRATION_POSTBACK_URL: "http://127.0.0.1:4010/postback",
          }),
          google: { clientId: "offline-client", clientSecret: "offline-secret" },
        },
        {
          pool,
          postman: async (message) => {
            messages.push(message);
            return "accepted";
          },
        },
      );
      const start = async (click?: string, profile: Partial<GoogleProfile> = {}) => {
        const began = await identity.startGoogle("settings", click);
        if (began.status !== "redirect") throw new Error("Google must start");
        return {
          query: google.authorize(began.location, profile),
          cookie: cookieHeader(began.setCookies),
        };
      };
      return { identity, start };
    }

    it("leaves one pending registration holding the click, and nothing else of the sign-in, when the Google sign-in makes a new address's account", async () => {
      const { identity, start } = reportingGoogle();
      const flow = await start(CLICK);
      const before = Date.now();

      const opened = await identity.finishGoogle(flow.query, flow.cookie);

      if (opened.status !== "opened") throw new Error("the Google sign-in did not open");
      const stored = await registrations();
      expect(stored).toStrictEqual([
        {
          account_id: opened.person.id,
          click_id: CLICK,
          state: "pending",
          attempts: 0,
          next_attempt_at: expect.any(Date),
          last_outcome: null,
          created_at: expect.any(Date),
          event_at: expect.any(Date),
          settled_at: null,
        },
      ]);
      const due = new Date(stored[0]?.next_attempt_at as Date).getTime();
      expect(due).toBeGreaterThanOrEqual(before);
      expect(due).toBeLessThanOrEqual(Date.now());
    });

    it("writes no registration when Google links an address a mailed link already verified", async () => {
      const messages: Message[] = [];
      const { identity, start } = reportingGoogle(messages);
      await identity.requestLink("person@gmail.com", "default", ONE_CLIENT);
      expect(await identity.openLink(tokenIn(messages[0] as Message))).toMatchObject({
        status: "opened",
      });
      const flow = await start(CLICK);

      expect(await identity.finishGoogle(flow.query, flow.cookie)).toMatchObject({
        status: "opened",
      });

      expect(await countIn("dashboard_credentials")).toBe(1);
      expect(await registrations()).toStrictEqual([]);
    });

    it("makes one account and one registration when two Google callbacks with clicks for one new person race", async () => {
      const { identity, start } = reportingGoogle();
      const first = await start(CLICK);
      const second = await start(ANOTHER_CLICK);
      await slowAccountInserts();

      const opened = await Promise.all([
        identity.finishGoogle(first.query, first.cookie),
        identity.finishGoogle(second.query, second.cookie),
      ]);

      expect(opened.map((one) => one.status)).toStrictEqual(["opened", "opened"]);
      expect(await countIn("dashboard_accounts")).toBe(1);
      const stored = await registrations();
      expect(stored).toHaveLength(1);
      expect([CLICK, ANOTHER_CLICK]).toContain(stored[0]?.click_id);
    });

    it("rolls the Google person, binding and session back when the registration cannot be written", async () => {
      const { identity, start } = reportingGoogle();
      const flow = await start(CLICK);
      await pool.query(
        `create function fail_registration() returns trigger language plpgsql as $$ begin raise exception 'injected registration failure'; end $$`,
      );
      await pool.query(
        "create trigger fail_registration before insert on dashboard_ad_reports for each row execute function fail_registration()",
      );

      expect(await identity.finishGoogle(flow.query, flow.cookie)).toMatchObject({
        status: "refused",
        reason: "unavailable",
        setCookies: [],
      });

      for (const table of [
        "dashboard_accounts",
        "dashboard_credentials",
        "dashboard_sessions",
        "dashboard_ad_reports",
      ]) {
        expect(await countIn(table), table).toBe(0);
      }
    });
  });
}

function cookieHeader(setCookies: readonly string[]): string {
  return setCookies.map((value) => value.split(";", 1)[0]).join("; ");
}

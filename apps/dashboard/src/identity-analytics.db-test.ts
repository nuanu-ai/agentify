/**
 * What the identity records for product analytics, against PostgreSQL,
 * because what it promises is the database's: a confirmed sign-in and a new
 * merchant are recorded in the transaction that writes them, so one undone
 * leaves no event, and an analytics table that cannot be written costs the
 * event and never the sign-in.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { migrateAccounts } from "./database.js";
import { identityFor } from "./identity.js";
import type { Message } from "./mail.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_dashboard_identity_analytics";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);
const here = dirname(fileURLToPath(import.meta.url));
const migrationsIn = join(here, "..", "drizzle");
const gatewayMigrationsIn = join(here, "..", "..", "gateway", "drizzle");

const EMAIL = "person@example.com";
/** Synthetic: it passes the click identifier's pattern and no tracker issued it. */
const CLICK = "qa_click_0123456789abcdef";

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));
  describe("what the identity records for product analytics on PostgreSQL", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const messages: Message[] = [];
  const identity = identityFor(
    loadConfig({
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: TEST_AUTH_SECRET,
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "sandbox:scripted",
      // Switched on, so a sign-in from an ad writes a registration after the
      // session, which a test can make fail.
      REGISTRATION_POSTBACK_ENABLED: "true",
      REGISTRATION_POSTBACK_KEY: ["qa", "synthetic", "postback", "key"].join("-"),
      REGISTRATION_POSTBACK_URL: "http://127.0.0.1:4010/postback",
    }),
    {
      pool,
      postman: async (message) => {
        messages.push(message);
        return "accepted";
      },
    },
  );

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    messages.length = 0;
    await pool.query("drop schema public cascade");
    await pool.query("drop schema if exists drizzle cascade");
    await pool.query("create schema public");
    await migrate(drizzle(pool), { migrationsFolder: gatewayMigrationsIn });
    await migrateAccounts(pool, migrationsIn);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const tokenOf = (message: Message | undefined): string => {
    const raw = message?.body.match(/https?:\/\/\S+/)?.[0];
    const token = raw === undefined ? null : new URL(raw).searchParams.get("token");
    if (token === null || token === undefined) throw new Error("the message has no link");
    return token;
  };

  /** Every send dated a minute back, so the next link is not refused by the minute. */
  const rewind = async () => {
    await pool.query("update dashboard_link_sends set sent_at = sent_at - interval '1 minute'");
  };

  const linkFor = async (email = EMAIL, click?: string): Promise<string> => {
    await rewind();
    const asked = await identity.requestLink(email, "default", click);
    if (asked.status !== "accepted") throw new Error(`the link was ${asked.status}`);
    return tokenOf(messages.at(-1));
  };

  const signIn = async (email = EMAIL) => {
    const opened = await identity.openLink(await linkFor(email));
    if (opened.status !== "opened") throw new Error("the link did not open");
    return opened.person;
  };

  const recorded = async () =>
    (
      await pool.query<{
        name: string;
        actor_type: string;
        source: string;
        refs: unknown;
        properties: unknown;
      }>(
        "select name, actor_type, source, refs, properties from commerce_analytics_events order by sequence",
      )
    ).rows;

  describe("what the identity records for product analytics on PostgreSQL", () => {
    it("records a first verification as one confirmed sign-in committed with it, and a returning one as not the first", async () => {
      const first = await signIn();
      const again = await signIn();

      expect(again.id).toBe(first.id);
      expect(await recorded()).toStrictEqual(
        [true, false].map((firstVerification) => ({
          name: "agc_auth_result",
          actor_type: "human",
          source: "dashboard",
          refs: { person: first.id },
          properties: {
            method: "email_link",
            stage: "verify",
            outcome: "confirmed",
            first_verification: firstVerification,
          },
        })),
      );
    });

    it("records no confirmation of a sign-in whose transaction rolled back after its session was written", async () => {
      // The registration's report is written after the session; refusing it
      // undoes the whole press.
      await pool.query(`
        create function refuse_the_report() returns trigger language plpgsql as
          $$ begin raise exception 'the report could not be written'; end $$`);
      await pool.query(`
        create trigger refuse_the_report before insert on dashboard_ad_reports
          for each row execute function refuse_the_report()`);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(identity.openLink(await linkFor(EMAIL, CLICK))).rejects.toThrow();

      expect(await recorded()).toStrictEqual([]);
      expect((await pool.query("select 1 from dashboard_sessions")).rowCount).toBe(0);
    });

    it("records a merchant made for a person once, in the transaction that names it on the account", async () => {
      const person = await signIn();
      await pool.query("delete from commerce_analytics_events");

      const attached = await identity.attachMerchant(person.id, async () => "mer_new");
      const repeated = await identity.attachMerchant(person.id, async () => "mer_second");

      expect([attached.status, repeated.status]).toStrictEqual(["attached", "already-attached"]);
      expect(await recorded()).toStrictEqual([
        {
          name: "agc_merchant_created",
          actor_type: "human",
          source: "dashboard",
          refs: { merchant: "mer_new", person: person.id },
          properties: {},
        },
      ]);
    });

    it("records a refused link press outside the press, once", async () => {
      await identity.openLink("A".repeat(32));

      await vi.waitFor(async () => expect(await recorded()).toHaveLength(1));
      expect(await recorded()).toStrictEqual([
        {
          name: "agc_auth_result",
          actor_type: "human",
          source: "dashboard",
          refs: {},
          properties: {
            method: "email_link",
            stage: "verify",
            outcome: "blocked",
            reason_code: "invalid_link",
          },
        },
      ]);
    });

    it("signs a person in, makes their merchant and takes an observation while the analytics table cannot be written", async () => {
      await pool.query("drop table commerce_analytics_events");
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const person = await signIn();
      const attached = await identity.attachMerchant(person.id, async () => "mer_new");
      const observed = identity.observe({
        name: "agc_dashboard_viewed",
        actor: "human",
        source: "dashboard",
        refs: { person: person.id },
        fields: { screen: "cards" },
      });

      await expect(observed).resolves.toBeUndefined();
      expect(attached.status).toBe("attached");
      expect(await identity.byId(person.id)).toMatchObject({
        confirmed: true,
        merchant: { id: "mer_new" },
      });
      expect((await identity.requestLink("someone@example.com", "default")).status).toBe(
        "accepted",
      );
    });

    it("sets the choice about product analytics on the one account it is asked for", async () => {
      const person = await signIn();
      const other = await signIn("other@example.com");
      await identity.attachMerchant(person.id, async () => "mer_shared");
      await pool.query("update dashboard_accounts set merchant_id = 'mer_shared' where id = $1", [
        other.id,
      ]);

      await identity.setAnalyticsOptOut(person.id, true);

      expect(await identity.analyticsOptedOut(person.id)).toBe(true);
      expect(await identity.analyticsOptedOut(other.id)).toBe(false);
      expect(
        (
          await pool.query<{ id: string; analytics_opt_out: boolean }>(
            "select id, analytics_opt_out from dashboard_accounts order by email",
          )
        ).rows,
      ).toStrictEqual([
        { id: other.id, analytics_opt_out: false },
        { id: person.id, analytics_opt_out: true },
      ]);

      await identity.setAnalyticsOptOut(person.id, false);
      expect(await identity.analyticsOptedOut(person.id)).toBe(false);
    });
  });
}

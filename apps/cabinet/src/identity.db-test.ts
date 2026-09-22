/** PostgreSQL authority for cabinet identity transactions and cutover. */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { identityFor } from "./identity.js";
import type { Message } from "./mail.js";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_commerce_test_cabinet_identity";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);
const here = dirname(fileURLToPath(import.meta.url));
const migrationsIn = join(here, "..", "drizzle");

const MERCHANT = { id: "mer_the_merchant", key: "the-merchants-own-key-long-enough" };
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
  describe("the cabinet identity on PostgreSQL", () => {
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

  async function emptyEverything(): Promise<void> {
    await pool.query("drop function if exists fail_cabinet_session() cascade");
    await pool.query("drop function if exists slow_cabinet_person() cascade");
    await pool.query("drop function if exists fail_cabinet_key_update() cascade");
    await pool.query(`
      drop table if exists
        cabinet_link_sends, cabinet_woo_orders, cabinet_woo_shops, cabinet_woo_grants,
        cabinet_verifications, cabinet_credentials, cabinet_sessions, cabinet_accounts
      cascade
    `);
  }

  async function migrateThrough(file: (typeof migrationFiles)[number]): Promise<void> {
    for (const migration of migrationFiles) {
      await run(migration);
      if (migration === file) return;
    }
  }

  function config() {
    return loadConfig({
      DATABASE_URL: identityDatabaseUrl,
      AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "sandbox:scripted",
      REGISTRATION_INVITATION: "the-existing-gateway-invitation",
    });
  }

  function identityOn(messages: Message[], handover: "accepted" | "refused" = "accepted") {
    return identityFor(config(), {
      pool,
      postman: async (message) => {
        messages.push(message);
        return handover;
      },
    });
  }

  function tokenIn(message: Message): string {
    const raw = message.body.match(/https?:\/\/\S+/)?.[0];
    if (raw === undefined) throw new Error("the message has no cabinet link");
    const token = new URL(raw).searchParams.get("token");
    if (token === null) throw new Error("the cabinet link has no token");
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
        [NOW, MERCHANT.id, MERCHANT.key],
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
      await migrateThrough("0005_one_way_in_identity.sql");
    });

    it("commits token, new person and session together, then consumes only once", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);

      await expect(identity.requestLink(" Person@Example.com ", "settings")).resolves.toStrictEqual(
        {
          status: "accepted",
        },
      );
      expect(
        (await pool.query("select count(*)::int as count from cabinet_accounts")).rows[0],
      ).toStrictEqual({ count: 0 });

      const token = tokenIn(messages[0] as Message);
      const opened = await identity.openLink(token);
      expect(opened).toMatchObject({
        status: "opened",
        destination: "settings",
        person: { email: "person@example.com", confirmed: true, merchant: null },
      });
      expect(
        (await pool.query("select count(*)::int as count from cabinet_sessions")).rows[0],
      ).toStrictEqual({ count: 1 });
      await expect(identity.openLink(token)).resolves.toStrictEqual({ status: "refused" });
    });

    it("serializes two independent first links for one new person", async () => {
      const messages: Message[] = [];
      const one = identityOn(messages);
      const two = identityOn(messages);
      await one.requestLink("person@example.com", "default");
      await two.requestLink("person@example.com", "settings");
      await pool.query(`
        create function slow_cabinet_person() returns trigger language plpgsql as $$
        begin perform pg_sleep(0.05); return new; end $$
      `);
      await pool.query(`
        create trigger slow_cabinet_person before insert on cabinet_accounts
        for each row execute function slow_cabinet_person()
      `);

      const [first, second] = await Promise.all([
        one.openLink(tokenIn(messages[0] as Message)),
        two.openLink(tokenIn(messages[1] as Message)),
      ]);

      expect(first).toMatchObject({ status: "opened", destination: "default" });
      expect(second).toMatchObject({ status: "opened", destination: "settings" });
      if (first.status !== "opened" || second.status !== "opened") {
        throw new Error("both independent cabinet links should open");
      }
      expect(second.person.id).toBe(first.person.id);
      expect(
        (await pool.query("select count(*)::int as count from cabinet_accounts")).rows[0],
      ).toStrictEqual({ count: 1 });
      expect(
        (await pool.query("select count(*)::int as count from cabinet_sessions")).rows[0],
      ).toStrictEqual({ count: 2 });
    });

    it("rolls token consumption and person creation back when session creation fails", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      await identity.requestLink("person@example.com", "default");
      const token = tokenIn(messages[0] as Message);
      await pool.query(`
        create function fail_cabinet_session() returns trigger language plpgsql as $$
        begin raise exception 'injected session failure'; end $$
      `);
      await pool.query(`
        create trigger fail_cabinet_session before insert on cabinet_sessions
        for each row execute function fail_cabinet_session()
      `);

      await expect(identity.openLink(token)).rejects.toThrow(/insert into "cabinet_sessions"/i);

      expect(
        (await pool.query("select count(*)::int as count from cabinet_accounts")).rows[0],
      ).toStrictEqual({ count: 0 });
      expect(
        (await pool.query("select count(*)::int as count from cabinet_sessions")).rows[0],
      ).toStrictEqual({ count: 0 });
      expect(
        (await pool.query("select count(*)::int as count from cabinet_verifications")).rows[0],
      ).toStrictEqual({ count: 1 });
      await pool.query("drop trigger fail_cabinet_session on cabinet_sessions");
      await pool.query("drop function fail_cabinet_session()");
      await expect(identity.openLink(token)).resolves.toMatchObject({ status: "opened" });
    });

    it("rolls the hashed token and rate event back when delivery is refused", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages, "refused");

      await expect(identity.requestLink("person@example.com", "default")).resolves.toStrictEqual({
        status: "unavailable",
      });

      expect(
        (await pool.query("select count(*)::int as count from cabinet_verifications")).rows[0],
      ).toStrictEqual({ count: 0 });
      expect(
        (await pool.query("select count(*)::int as count from cabinet_link_sends")).rows[0],
      ).toStrictEqual({ count: 0 });
      expect(
        (await pool.query("select count(*)::int as count from cabinet_accounts")).rows[0],
      ).toStrictEqual({ count: 0 });
    });

    it("keeps a seeded merchant unconfirmed until that mailbox consumes a link", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const seeded = await identity.make("person@example.com", MERCHANT);

      expect(seeded).toMatchObject({ confirmed: false, merchant: MERCHANT });
      expect(
        (await pool.query("select count(*)::int as count from cabinet_credentials")).rows[0],
      ).toStrictEqual({ count: 0 });
      expect(
        (await pool.query("select count(*)::int as count from cabinet_sessions")).rows[0],
      ).toStrictEqual({ count: 0 });

      await identity.requestLink("person@example.com", "default");
      const opened = await identity.openLink(tokenIn(messages[0] as Message));
      expect(opened).toMatchObject({
        status: "opened",
        person: { id: seeded?.id, confirmed: true, merchant: MERCHANT },
      });
    });

    it("serializes competing attachment retries and sees the committed session first", async () => {
      const messages: Message[] = [];
      const one = identityOn(messages);
      const two = identityOn(messages);
      await one.requestLink("person@example.com", "default");
      const opened = await one.openLink(tokenIn(messages[0] as Message));
      if (opened.status !== "opened") throw new Error("the P1 link did not open");
      let registrations = 0;
      const register = async () => {
        registrations += 1;
        expect(
          (
            await pool.query(
              "select count(*)::int as count from cabinet_sessions where user_id = $1",
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
          await pool.query("select merchant_id, merchant_key from cabinet_accounts where id = $1", [
            opened.person.id,
          ])
        ).rows,
      ).toStrictEqual([{ merchant_id: MERCHANT.id, merchant_key: MERCHANT.key }]);
    });

    it("keeps P1 and its session when gateway registration is unavailable", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      await identity.requestLink("person@example.com", "default");
      const opened = await identity.openLink(tokenIn(messages[0] as Message));
      if (opened.status !== "opened") throw new Error("the P1 link did not open");

      await expect(
        identity.attachMerchant(opened.person.id, async () => null),
      ).resolves.toMatchObject({
        status: "unavailable",
        person: { merchant: null },
      });
      expect(await identity.whoIs(cookieHeader(opened.setCookies))).toMatchObject({
        id: opened.person.id,
        merchant: null,
      });
    });

    it("retains compare-and-swap key rotation", async () => {
      const identity = identityOn([]);
      const person = await identity.make("person@example.com", MERCHANT);
      if (person === null) throw new Error("the seed account was not made");

      const [first, second] = await Promise.all([
        identity.replaceMerchantKey(person.id, MERCHANT.key, "the-first-fresh-key"),
        identity.replaceMerchantKey(person.id, MERCHANT.key, "the-second-fresh-key"),
      ]);

      expect([first, second].filter((result) => result === "replaced")).toHaveLength(1);
      expect([first, second].filter((result) => result === "not-matched")).toHaveLength(1);
      expect((await identity.byId(person.id))?.merchant?.key).toMatch(
        /the-(first|second)-fresh-key/,
      );
    });

    it("reports an uncertain key write without logging its query or keys", async () => {
      const identity = identityOn([]);
      const person = await identity.make("person@example.com", MERCHANT);
      if (person === null) throw new Error("the seed account was not made");
      const fresh = "the-sensitive-fresh-key";
      await pool.query(`
        create function fail_cabinet_key_update() returns trigger language plpgsql as $$
        begin raise exception 'injected failure carrying %', new.merchant_key; end $$
      `);
      await pool.query(`
        create trigger fail_cabinet_key_update before update on cabinet_accounts
        for each row execute function fail_cabinet_key_update()
      `);
      const lines: string[] = [];
      const error = vi.spyOn(console, "error").mockImplementation((...parts) => {
        lines.push(parts.map(String).join(" "));
      });
      try {
        await expect(identity.replaceMerchantKey(person.id, MERCHANT.key, fresh)).resolves.toBe(
          "unknown",
        );
      } finally {
        error.mockRestore();
      }

      expect((await identity.byId(person.id))?.merchant?.key).toBe(MERCHANT.key);
      const written = lines.join("\n");
      expect(written).toMatch(/could not establish whether/i);
      expect(written).not.toContain(MERCHANT.key);
      expect(written).not.toContain(fresh);
      expect(written).not.toContain('update "cabinet_accounts"');
    });

    it("enforces three sends per rolling hour without storing the raw address", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      for (let count = 0; count < 3; count += 1) {
        await expect(identity.requestLink("person@example.com", "default")).resolves.toStrictEqual({
          status: "accepted",
        });
      }
      await expect(identity.requestLink("person@example.com", "default")).resolves.toMatchObject({
        status: "cooldown",
        retryAt: expect.any(Date),
      });
      const evidence = await pool.query("select email_hash from cabinet_link_sends");
      expect(evidence.rows).toHaveLength(3);
      expect(JSON.stringify(evidence.rows)).not.toContain("person@example.com");
    });
  });
}

function cookieHeader(setCookies: readonly string[]): string {
  return setCookies.map((value) => value.split(";", 1)[0]).join("; ");
}

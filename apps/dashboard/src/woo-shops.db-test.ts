/**
 * The shared contract run against Postgres, because its two properties are ones
 * a memory store can have by accident and a database has to be written for: a
 * token spent by one caller only (a delete that returns a row) and a sale
 * claimed once however many attempts arrive together (an insert that does
 * nothing on conflict). Beside it, the one rule only the schema keeps: a
 * connection written without its revision is refused rather than given one.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { migrateAccounts } from "./database.js";
import { wooShopsContract } from "./testing/woo-shops-contract.js";
import { postgresWooShops } from "./woo-shops.js";

/**
 * These tables hang off the accounts table by foreign key, so the suite makes
 * its own accounts, which must not happen in tables another suite empties.
 */
const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_dashboard_woo";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);

const here = dirname(fileURLToPath(import.meta.url));
const migrationsIn = join(here, "..", "drizzle");
const gatewayMigrationsIn = join(here, "..", "..", "gateway", "drizzle");

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));

  describe("the WooCommerce connection store on a real database", () => {
    it.skip("is skipped: there is no Postgres to run it against", () => {
      // Intentionally empty: the message above is the whole point.
    });
  });
} else {
  const pool = new Pool({ connectionString: databaseUrl });

  // Drops whatever exists rather than a list of names, since a list falls
  // behind the next migration; the gateway's functions and triggers go with
  // its tables. The migrator's journal schema goes too: it is not in `public`,
  // and left behind it would say everything is applied while the tables are
  // gone.
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query("drop schema if exists drizzle cascade");
  // The gateway's tables too: a connection's analytics event is written to the
  // gateway's outbox, in the transaction that writes the connection.
  await migrate(drizzle(pool), { migrationsFolder: gatewayMigrationsIn });
  await migrateAccounts(pool, migrationsIn);

  afterAll(async () => {
    await pool.end();
  });

  /**
   * The contract's concurrent cases only measure a race if the ten calls really
   * overlap; on a cold pool the first call finishes while the second waits for
   * a socket, so a read-then-write would pass the case it exists to fail.
   */
  await Promise.all(Array.from({ length: 10 }, () => pool.query("select 1")));

  let issued = 0;
  const anAccount = async (): Promise<string> => {
    issued += 1;
    const id = `acc_woo_${issued}`;
    await pool.query(
      "insert into dashboard_accounts (id, email, email_verified, name, created_at, updated_at)" +
        " values ($1, $2, false, '', now(), now())",
      [id, `${id}@example.com`],
    );
    return id;
  };

  describe("a shop connection on postgres", () => {
    it("does not let an old owner with an old encryption key retire or rewrite the current owner's cart", async () => {
      const origin = "https://stale-cart-owner.example.com";
      const at = new Date("2026-10-28T10:00:00Z");
      const expiresAt = new Date("2026-10-30T10:00:00Z");
      const old = postgresWooShops(pool, "old-auth-secret-with-thirty-two-bytes");
      const current = postgresWooShops(pool, "new-auth-secret-with-thirty-two-bytes");
      await old.startCartRuntime(origin, "old-owner");
      await old.claimCart(origin, "old-owner", "paid", 0, "old-claim", at);
      await current.startCartRuntime(origin, "current-owner");
      await current.claimCart(origin, "current-owner", "paid", 0, "current-empty", at);
      await current.finishCart(origin, "current-owner", "paid", 0, "current-empty", {
        token: "current-private-token",
        expiresAt,
      });
      expect(
        await current.claimCart(origin, "current-owner", "paid", 0, "current-active", at),
      ).toEqual({ kind: "reuse", token: "current-private-token", expiresAt });
      const before = await pool.query(
        "select owner, next_creation_at, slots from dashboard_woo_cart_resources where shop_origin = $1",
        [origin],
      );

      expect(await old.finishCart(origin, "old-owner", "paid", 0, "old-claim", null)).toBe(false);
      expect(
        await current.finishCart(origin, "current-owner", "paid", 0, "superseded-claim", null),
      ).toBe(false);
      expect(await old.claimCart(origin, "old-owner", "quote", 0, "stale-new-claim", at)).toEqual({
        kind: "stale",
      });
      const after = await pool.query(
        "select owner, next_creation_at, slots from dashboard_woo_cart_resources where shop_origin = $1",
        [origin],
      );
      expect(after.rows).toEqual(before.rows);

      expect(
        await current.finishCart(origin, "current-owner", "paid", 0, "current-active", {
          token: "current-private-token",
          expiresAt,
        }),
      ).toBe(true);
      expect(await current.claimCart(origin, "current-owner", "paid", 0, "next-use", at)).toEqual({
        kind: "reuse",
        token: "current-private-token",
        expiresAt,
      });
    });

    it("keeps an idle cart token encrypted while a reconstructed store can reuse it", async () => {
      const origin = "https://encrypted-carts.example.com";
      const secret = "cart-test-auth-secret-with-thirty-two-bytes";
      const first = postgresWooShops(pool, secret);
      const at = new Date("2026-10-28T10:00:00Z");
      const expiresAt = new Date("2026-10-30T10:00:00Z");
      await first.startCartRuntime(origin, "before-restart");
      await first.claimCart(origin, "before-restart", "paid", 0, "clean", at);
      await first.finishCart(origin, "before-restart", "paid", 0, "clean", {
        token: "private-shop-cart-token",
        expiresAt,
      });
      const stored = await pool.query(
        "select slots from dashboard_woo_cart_resources where shop_origin = $1",
        [origin],
      );
      expect(JSON.stringify(stored.rows)).not.toContain("private-shop-cart-token");
      const restored = postgresWooShops(pool, secret);
      await restored.startCartRuntime(origin, "after-restart");
      expect(await restored.claimCart(origin, "after-restart", "paid", 0, "again", at)).toEqual({
        kind: "reuse",
        token: "private-shop-cart-token",
        expiresAt,
      });
    });

    it("rewrites nothing a registry call left unchanged, and seals again only the tokens it changed", async () => {
      const origin = "https://idle-carts.example.com";
      const shops = postgresWooShops(pool, "cart-test-auth-secret-with-thirty-two-bytes");
      const at = new Date("2026-10-28T10:00:00Z");
      const expiresAt = new Date("2026-10-30T10:00:00Z");
      const stored = async () =>
        (
          await pool.query(
            // A new row version is what a rewrite costs, whatever it writes.
            "select xmin::text as version, owner, next_creation_at, slots from dashboard_woo_cart_resources where shop_origin = $1",
            [origin],
          )
        ).rows[0] as { slots: { token: string | null }[] };
      await shops.startCartRuntime(origin, "worker");
      for (const slot of [0, 1]) {
        await shops.claimCart(origin, "worker", "paid", slot, `open-${slot}`, at);
        await shops.finishCart(origin, "worker", "paid", slot, `open-${slot}`, {
          token: `session-${slot}`,
          expiresAt,
        });
      }
      const idle = await stored();
      await shops.claimCart(origin, "worker", "paid", 0, "in-use", at);
      const claimed = await stored();
      expect(claimed.slots[1]?.token).toBe(idle.slots[1]?.token);
      expect(claimed.slots[0]?.token).toBe(idle.slots[0]?.token);

      expect(
        await shops.registerCartIdentity(origin, "worker", "paid", 0, "in-use", "session-0"),
      ).toBe(true);
      await shops.startCartRuntime(origin, "worker");
      expect(await stored()).toEqual(claimed);
    });

    it("opens every cart whose token a rotated key cannot read as one never opened", async () => {
      const origin = "https://rotated-key.example.com";
      const before = postgresWooShops(pool, "auth-secret-before-the-rotation-32b");
      const after = postgresWooShops(pool, "auth-secret-after-the-rotation-3-2b");
      const at = new Date("2026-10-28T10:00:00Z");
      await before.startCartRuntime(origin, "before-rotation");
      for (const lane of ["paid", "quote"] as const)
        for (let slot = 0; slot < 8; slot += 1) {
          await before.claimCart(origin, "before-rotation", lane, slot, `${lane}-${slot}`, at);
          await before.finishCart(origin, "before-rotation", lane, slot, `${lane}-${slot}`, {
            token: `${lane}-session-${slot}`,
            expiresAt: new Date("2026-10-30T10:00:00Z"),
          });
        }

      await after.startCartRuntime(origin, "after-rotation");
      for (const lane of ["paid", "quote"] as const)
        for (let slot = 0; slot < 8; slot += 1)
          expect(
            await after.claimCart(
              origin,
              "after-rotation",
              lane,
              slot,
              `again-${lane}-${slot}`,
              at,
            ),
          ).toEqual({ kind: "new" });
    });

    it("is refused when it is written without its revision", async () => {
      await pool.query("delete from dashboard_woo_shops");
      const account = await anAccount();
      await expect(
        pool.query(
          `insert into dashboard_woo_shops
             (account_id, shop_url, consumer_key, consumer_secret, permissions, connected_at)
           values ($1, 'https://shop.example', 'ck_test', 'cs_test', 'read_write', now())`,
          [account],
        ),
      ).rejects.toMatchObject({ code: "23502", column: "revision" });
    });
  });

  wooShopsContract("on postgres", async () => {
    // Every row gone, so one case cannot read another's; the accounts too,
    // since they are made per case.
    await pool.query("delete from dashboard_woo_cart_resources");
    await pool.query("delete from dashboard_woo_orders");
    await pool.query("delete from dashboard_woo_shops");
    await pool.query("delete from dashboard_woo_grants");
    await pool.query("delete from dashboard_accounts");
    return {
      shops: postgresWooShops(pool, "woo-shops-contract-auth-secret"),
      accounts: { one: await anAccount(), other: await anAccount() },
      close: async () => {},
    };
  });

  describe("the analytics of a shop's connection, on postgres", () => {
    const keys = { consumerKey: "ck_abc", consumerSecret: "cs_def", permissions: "read_write" };
    const START = new Date("2026-10-21T12:00:00.000Z");
    const LATER = new Date("2026-10-21T12:30:00.000Z");

    const accountOf = async (merchantId: string): Promise<string> => {
      const id = await anAccount();
      await pool.query("update dashboard_accounts set merchant_id = $1 where id = $2", [
        merchantId,
        id,
      ]);
      return id;
    };
    const recorded = async () =>
      (
        await pool.query<{ actor_type: string; source: string; refs: object; properties: object }>(
          "select actor_type, source, refs, properties from commerce_analytics_events order by sequence",
        )
      ).rows;

    it("records a Connect only with its saved grant and leaves grant creation usable without the outbox", async () => {
      await pool.query("delete from commerce_analytics_events");
      const shops = postgresWooShops(pool, "woo-shops-contract-auth-secret");
      const accountId = await accountOf("mch_start");
      const event = {
        name: "agc_setup_result" as const,
        actor: "human" as const,
        source: "dashboard" as const,
        refs: { merchant: "mch_start", person: accountId },
        fields: {
          step: "woo_connect" as const,
          integration: "woocommerce" as const,
          outcome: "completed" as const,
        },
      };
      const grant = {
        token: "start-token",
        accountId,
        shopUrl: "https://shop.example.com",
        currency: null,
        startedAt: START,
        expiresAt: LATER,
      };
      await pool.query(`create function refuse_grant_commit() returns trigger language plpgsql as
        $$ begin raise exception 'grant commit refused'; end $$`);
      await pool.query(`create constraint trigger refuse_grant_commit after insert on dashboard_woo_grants
        deferrable initially deferred for each row execute function refuse_grant_commit()`);
      try {
        await expect(shops.beginGrant(grant, event)).rejects.toThrow();
        expect(await shops.grantFor(accountId)).toBeNull();
        expect(await recorded()).toEqual([]);
      } finally {
        await pool.query("drop trigger refuse_grant_commit on dashboard_woo_grants");
        await pool.query("drop function refuse_grant_commit()");
      }
      await shops.beginGrant(grant, event);
      expect(await shops.grantFor(accountId)).not.toBeNull();
      expect(await recorded()).toHaveLength(1);
      await pool.query(`create function refuse_grant_analytics() returns trigger language plpgsql as
        $$ begin raise exception 'outbox refused'; end $$`);
      await pool.query(`create trigger refuse_grant_analytics before insert on commerce_analytics_events
        for each row execute function refuse_grant_analytics()`);
      try {
        await shops.beginGrant({ ...grant, token: "replacement-token" }, event);
        expect((await shops.grantFor(accountId))?.token).toBe("replacement-token");
        expect(await recorded()).toHaveLength(1);
      } finally {
        await pool.query("drop trigger refuse_grant_analytics on commerce_analytics_events");
        await pool.query("drop function refuse_grant_analytics()");
      }
    });

    it("records the connection with the merchant the account names, and a late callback as blocked", async () => {
      await pool.query("delete from commerce_analytics_events");
      const shops = postgresWooShops(pool, "woo-shops-contract-auth-secret");
      const prompt = await accountOf("mch_woo_prompt");
      const late = await accountOf("mch_woo_late");
      for (const [token, accountId] of [
        ["prompt-token", prompt],
        ["late-token", late],
      ] as const) {
        await shops.beginGrant({
          token,
          accountId,
          shopUrl: "https://shop.example.com",
          currency: null,
          startedAt: START,
          expiresAt: new Date(START.getTime() + 15 * 60_000),
        });
      }

      expect(await shops.connectFromGrant("prompt-token", keys, START)).not.toBeNull();
      expect(await shops.connectFromGrant("late-token", keys, LATER)).toBeNull();
      expect(await shops.connectFromGrant("nobody's-token", keys, START)).toBeNull();

      expect(await recorded()).toStrictEqual([
        {
          actor_type: "human",
          source: "woocommerce",
          refs: { merchant: "mch_woo_prompt", person: prompt },
          properties: { step: "woo_connection", integration: "woocommerce", outcome: "completed" },
        },
        {
          actor_type: "human",
          source: "woocommerce",
          refs: { merchant: "mch_woo_late", person: late },
          properties: {
            step: "woo_connection",
            integration: "woocommerce",
            outcome: "blocked",
            reason_code: "session_expired",
          },
        },
      ]);
    });
  });
}

/**
 * Everything an address owns is made through the code that makes it in a
 * deployment, so the test proves the command removes what the product writes
 * rather than what a fixture guessed it writes.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connect,
  issueKey,
  PAYOUT_SPLIT_NETWORKS,
  PostgresStore,
  payoutSplitFor,
  payoutSplitNetworkOf,
  randomIds,
} from "@agentify/gateway";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import type { Card } from "@nuanu-ai/agentify-contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import type { Person } from "./dashboard-entry.js";
import { migrateAccounts } from "./database.js";
import { runForget } from "./forget-account.js";
import { identityFor } from "./identity.js";
import type { Message } from "./mail.js";
import { postgresWooShops } from "./woo-shops.js";

const WANTED = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_dashboard_forget";
  return url.toString();
})();
const databaseUrl = await readyDatabase(WANTED);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const tsx = join(root, "apps", "dashboard", "node_modules", "tsx", "dist", "loader.mjs");
const gatewayMigrations = join(here, "..", "..", "gateway", "drizzle");
const dashboardMigrations = join(here, "..", "drizzle");

const EMAIL = "merchant@example.com";
const BYSTANDER = "bystander@example.com";
const AUTH_SECRET = "x".repeat(40);
const SHOP = "https://shop.example.com";
const TEST_NETWORK = "eip155:84532";
const LIVE_NETWORK = "eip155:8453";
/** Synthetic: it passes the click identifier's pattern and no tracker issued it. */
const CLICK = "qa_click_0123456789abcdef";

const card = (merchantItemId: string): Card => ({
  merchant_item_id: merchantItemId,
  title: "A room for the night",
  description: "One night in a room",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
});

if (databaseUrl === null) {
  console.log(noDatabaseHere(WANTED));
  describe("forgetting a test account on its real database", () => {
    it.skip("is skipped: its dedicated PostgreSQL server is unavailable", () => undefined);
  });
} else {
  const connected = connect(databaseUrl);
  const pool = connected.pool;
  const store = PostgresStore.over(connected.db, TEST_NETWORK, randomIds);
  const messages: Message[] = [];
  const identity = identityFor(
    loadConfig({
      DATABASE_URL: databaseUrl,
      AUTH_SECRET,
      PAYMENT_NETWORK: TEST_NETWORK,
      FACILITATOR_URL: "sandbox:scripted",
      // Switched on, so a sign-in from an ad leaves a registration to forget.
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
    await migrate(drizzle(pool), { migrationsFolder: gatewayMigrations });
    await migrateAccounts(pool, dashboardMigrations);
  });

  const tokenIn = (message: Message | undefined): string => {
    const raw = message?.body.match(/https?:\/\/\S+/)?.[0];
    const token = raw === undefined ? null : new URL(raw).searchParams.get("token");
    if (token === null || token === undefined) throw new Error("the message has no link");
    return token;
  };

  const signIn = async (email: string, click?: string): Promise<Person> => {
    const asked = await identity.requestLink(email, "default", click);
    if (asked.status !== "accepted") throw new Error(`the link was ${asked.status}`);
    const opened = await identity.openLink(tokenIn(messages.at(-1)));
    if (opened.status !== "opened") throw new Error("the link did not open");
    return opened.person;
  };

  const merchantAccount = async (
    email: string,
    cards: readonly string[],
    click?: string,
  ): Promise<{ readonly person: Person; readonly merchantId: string }> => {
    const person = await signIn(email, click);
    const merchant = await store.addMerchant(
      { id: randomIds("mch"), name: "A merchant" },
      Date.now(),
    );
    if (merchant === null) throw new Error("the merchant was not made");
    await issueKey(store, randomIds, merchant.id, "worker", Date.now(), "test");
    const attached = await identity.attachMerchant(person.id, async () => merchant.id);
    if (attached.status !== "attached") throw new Error(`the merchant was ${attached.status}`);
    for (const item of cards) await store.publishCard(merchant.id, card(item), Date.now());
    return { person, merchantId: merchant.id };
  };

  const countOf = async (table: string, column: string, value: string): Promise<number> =>
    (
      await pool.query<{ count: number }>(
        `select count(*)::int as count from ${table} where ${column} = $1`,
        [value],
      )
    ).rows[0]?.count ?? -1;

  const forget = async (rawEmail: string): Promise<{ code: number; output: string }> => {
    const lines: string[] = [];
    const code = await runForget(pool, rawEmail, AUTH_SECRET, { say: (line) => lines.push(line) });
    return { code, output: lines.join("\n") };
  };

  const forgetProcess = (
    rawEmail: string,
    network: string,
  ): { readonly status: number | null; readonly output: string } => {
    const result = spawnSync(
      process.execPath,
      ["--import", tsx, join(root, "apps", "dashboard", "src", "forget.ts")],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: databaseUrl, AUTH_SECRET, PAYMENT_NETWORK: network },
        input: `${rawEmail}\n`,
        // A command that hangs fails here instead of holding the suite.
        timeout: 20_000,
      },
    );
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  };

  describe("forgetting a test account on its real database", () => {
    it("removes the account and its merchant so the address signs in again as a newcomer", async () => {
      const { person, merchantId } = await merchantAccount(EMAIL, ["room-101", "room-102"], CLICK);
      const report = {
        operation: "send" as const,
        email: EMAIL,
        destination: { report: randomUUID() },
        request: randomUUID(),
      };
      expect((await identity.sendReportLink(report)).status).toBe("accepted");
      await identity.setOperator(EMAIL, true);
      const woo = postgresWooShops(pool);
      const now = new Date();
      await woo.connect({
        accountId: person.id,
        shopUrl: SHOP,
        consumerKey: "k".repeat(43),
        consumerSecret: "s".repeat(43),
        permissions: "read_write",
        revision: "first",
        connectedAt: now,
      });
      await woo.beginGrant({
        token: "t".repeat(43),
        accountId: person.id,
        shopUrl: SHOP,
        startedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      });
      await woo.recordQuote(person.id, "prc_one", "room-101", "fingerprint", now, now);
      const bystander = await merchantAccount(BYSTANDER, ["their-room"]);
      expect(await countOf("dashboard_ad_reports", "account_id", person.id)).toBe(1);

      const forgotten = forgetProcess("  Merchant@Example.COM", TEST_NETWORK);

      expect(forgotten.status, forgotten.output).toBe(0);
      expect(forgotten.output).toContain(EMAIL);
      expect(forgotten.output).toContain(merchantId);
      expect(forgotten.output).toMatch(/cards?[^\n]*\b2\b|\b2\b[^\n]*cards?/i);
      expect(forgotten.output).toContain(SHOP);
      expect(forgotten.output).toMatch(/operator/i);
      expect(forgotten.output).not.toContain(AUTH_SECRET);
      expect(forgotten.output).not.toContain(databaseUrl);

      expect(await countOf("dashboard_accounts", "email", EMAIL)).toBe(0);
      expect(await countOf("merchants", "id", merchantId)).toBe(0);
      expect(await countOf("merchant_keys", "merchant_id", merchantId)).toBe(0);
      expect(await countOf("cards", "merchant_id", merchantId)).toBe(0);
      expect(await countOf("dashboard_sessions", "user_id", person.id)).toBe(0);
      expect(await countOf("dashboard_woo_shops", "account_id", person.id)).toBe(0);
      expect(await countOf("dashboard_woo_grants", "account_id", person.id)).toBe(0);
      expect(await countOf("dashboard_woo_quotes", "account_id", person.id)).toBe(0);
      expect(await countOf("dashboard_ad_reports", "account_id", person.id)).toBe(0);

      // The bystander keeps everything, including the wait before their next
      // link.
      expect(await countOf("dashboard_accounts", "email", BYSTANDER)).toBe(1);
      expect(await countOf("merchants", "id", bystander.merchantId)).toBe(1);
      expect(await countOf("cards", "merchant_id", bystander.merchantId)).toBe(1);
      expect((await identity.requestLink(BYSTANDER, "default")).status).toBe("cooldown");

      // Both senders let the address ask at once, and the link makes a
      // newcomer.
      expect((await identity.sendReportLink({ ...report, request: randomUUID() })).status).toBe(
        "accepted",
      );
      const again = await signIn(EMAIL);
      expect(again.id).not.toBe(person.id);
      expect(again.merchant).toBeNull();
      expect(await identity.byEmail(EMAIL)).toMatchObject({ id: again.id, merchant: null });
    });

    it.each([
      {
        history: "an order",
        seed: async (merchantId: string) =>
          await pool.query(
            `insert into orders
               (id, state, open, item_id, merchant_item_id, record, created_at, updated_at, merchant_id)
             values ('ord_one', 'settled', false, 'item_one', 'room-101', '{}', now(), now(), $1)`,
            [merchantId],
          ),
        words: /1 order/i,
      },
      {
        history: "a receipt",
        seed: async (merchantId: string) =>
          await pool.query(
            `insert into receipts (order_id, receipt, updated_at, merchant_id)
             values ('ord_one', '{}', now(), $1)`,
            [merchantId],
          ),
        words: /1 receipt/i,
      },
    ])("refuses a merchant with $history and removes nothing", async ({ seed, words }) => {
      const { person, merchantId } = await merchantAccount(EMAIL, ["room-101"]);
      await seed(merchantId);

      const refused = await forget(EMAIL);

      expect(refused.code).not.toBe(0);
      expect(refused.output).toMatch(words);
      expect(refused.output).toMatch(/money/i);
      expect(refused.output).toMatch(/nothing was removed/i);
      expect(await countOf("dashboard_accounts", "id", person.id)).toBe(1);
      expect(await countOf("merchants", "id", merchantId)).toBe(1);
      expect(await countOf("cards", "merchant_id", merchantId)).toBe(1);
      expect((await identity.requestLink(EMAIL, "default")).status).toBe("cooldown");
    });

    it("refuses a merchant another account also names and removes nothing", async () => {
      const { person, merchantId } = await merchantAccount(EMAIL, ["room-101"]);
      const colleague = await signIn(BYSTANDER);
      await identity.attachMerchant(colleague.id, async () => merchantId);

      const refused = await forget(EMAIL);

      expect(refused.code).not.toBe(0);
      expect(refused.output).toContain(merchantId);
      expect(refused.output).toMatch(/other account/i);
      expect(refused.output).toMatch(/nothing was removed/i);
      expect(await countOf("dashboard_accounts", "id", person.id)).toBe(1);
      expect(await countOf("dashboard_accounts", "id", colleague.id)).toBe(1);
      expect(await countOf("merchants", "id", merchantId)).toBe(1);
    });

    it("refuses an address with no account in words, and removes nothing", async () => {
      const bystander = await merchantAccount(BYSTANDER, ["their-room"]);

      // The address is echoed back, so what a terminal would obey in it must be
      // shown instead.
      const refused = await forget("nobody@example.com\u001b[2J");

      expect(refused.code).not.toBe(0);
      expect(refused.output).toContain("nobody@example.com");
      expect(refused.output).toMatch(/no account/i);
      expect(refused.output).not.toContain("\u001b");
      expect(await countOf("dashboard_accounts", "id", bystander.person.id)).toBe(1);
      expect(await countOf("merchants", "id", bystander.merchantId)).toBe(1);
    });

    it("refuses on the live network and removes nothing", async () => {
      const { person, merchantId } = await merchantAccount(EMAIL, ["room-101"]);

      const refused = forgetProcess(EMAIL, LIVE_NETWORK);

      expect(refused.status).not.toBe(0);
      expect(refused.output).toMatch(/live network/i);
      expect(refused.output).not.toContain(databaseUrl);
      expect(await countOf("dashboard_accounts", "id", person.id)).toBe(1);
      expect(await countOf("merchants", "id", merchantId)).toBe(1);
      expect(await countOf("cards", "merchant_id", merchantId)).toBe(1);
    });

    it("keeps the recorded splits of the merchant it removes", async () => {
      // Money may still sit at a split after its merchant is gone, a stray
      // transfer or a late settlement, and its parameters are nowhere else
      // until its first payout.
      const { merchantId } = await merchantAccount(EMAIL, []);
      const network = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, TEST_NETWORK);
      const wallet = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
      const split = payoutSplitFor(network, merchantId, wallet);
      await store.setPayoutWallet(
        merchantId,
        { address: null, pending: null },
        { address: wallet, split, pending: null },
        Date.now(),
      );
      const before = (
        await pool.query("select * from payout_splits where merchant_id = $1", [merchantId])
      ).rows;
      expect(before).toHaveLength(1);

      const forgotten = await forget(EMAIL);

      expect(forgotten.code, forgotten.output).toBe(0);
      expect(forgotten.output).toContain(merchantId);
      expect(await countOf("merchants", "id", merchantId)).toBe(0);
      expect(
        (await pool.query("select * from payout_splits where merchant_id = $1", [merchantId])).rows,
      ).toStrictEqual(before);
    });

    it("forgets a person who never made a merchant, and says there was none", async () => {
      const person = await signIn(EMAIL);

      const forgotten = await forget(EMAIL);

      expect(forgotten.code, forgotten.output).toBe(0);
      expect(forgotten.output).toMatch(/merchant[^\n]*none/i);
      expect(forgotten.output).not.toMatch(/operator/i);
      expect(await countOf("dashboard_accounts", "id", person.id)).toBe(0);
      expect((await identity.requestLink(EMAIL, "default")).status).toBe("accepted");
    });

    it("says a merchant the gateway no longer holds was already absent, not removed", async () => {
      await pool.query(
        `insert into dashboard_accounts
           (id, email, email_verified, name, created_at, updated_at, merchant_id)
         values ('acc_orphan', $1, true, '', now(), now(), 'mch_gone')`,
        [EMAIL],
      );

      const forgotten = await forget(EMAIL);

      expect(forgotten.code, forgotten.output).toBe(0);
      expect(forgotten.output).toContain("mch_gone");
      expect(forgotten.output).toMatch(/already absent/i);
      expect(await countOf("dashboard_accounts", "id", "acc_orphan")).toBe(0);
    });

    it("says a database failure before the commit removed nothing, and prints no detail", async () => {
      const { person, merchantId } = await merchantAccount(EMAIL, ["room-101"]);
      await pool.query(`
        create function refuse_card_delete() returns trigger language plpgsql as $$
        begin raise exception 'a detail that must stay in the database'; end $$`);
      await pool.query(`
        create trigger refuse_card_delete before delete on cards
        for each row execute function refuse_card_delete()`);

      const failed = await forget(EMAIL);

      expect(failed.code).not.toBe(0);
      expect(failed.output).toMatch(/removed nothing/i);
      expect(failed.output).not.toMatch(/detail that must stay/i);
      expect(await countOf("dashboard_accounts", "id", person.id)).toBe(1);
      expect(await countOf("cards", "merchant_id", merchantId)).toBe(1);
    });

    it("says a failure at the commit leaves the outcome unknown and safe to run again", async () => {
      await signIn(EMAIL);
      await pool.query(`
        create function refuse_at_commit() returns trigger language plpgsql as $$
        begin raise exception 'the commit failed'; end $$`);
      await pool.query(`
        create constraint trigger refuse_at_commit after delete on dashboard_accounts
        deferrable initially deferred for each row execute function refuse_at_commit()`);

      const failed = await forget(EMAIL);

      expect(failed.code).not.toBe(0);
      expect(failed.output).toMatch(/unknown/i);
      expect(failed.output).toMatch(/again/i);
      expect(failed.output).not.toMatch(/removed nothing|account forgotten/i);
    });
  });
}

/**
 * The workspace's changes to accounts on the real database, beside the
 * gateway's tables as a deployment has them: each change and its journal row
 * commit together or neither does; the last operator's flag survives two
 * removals pressed at once; a flag changes only once its mail is handed over;
 * forgetting removes what the product wrote for an address and refuses money
 * history; and the configured first operator is given the flag once. If these
 * fail, an action could happen without its row, or a channel could lose every
 * operator.
 */

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
import type { JournalPress } from "@agentify/gateway/journal";
import { postgresOperatorReader } from "@agentify/gateway/operator";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type JournalTransaction, postgresJournal } from "./admin/journal.js";
import { loadConfig } from "./config.js";
import type { Person } from "./dashboard-entry.js";
import { migrateAccounts } from "./database.js";
import { type Identity, identityFor, OperatorMailRefused } from "./identity.js";
import type { Handover, Message } from "./mail.js";
import { ONE_CLIENT } from "./testing/link-sends.js";
import { postgresWooShops } from "./woo-shops.js";

const WANTED = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = `${url.pathname}_identity`;
  return url.toString();
})();
const databaseUrl = await readyDatabase(WANTED);
const here = dirname(fileURLToPath(import.meta.url));
const gatewayMigrations = join(here, "..", "..", "gateway", "drizzle");
const dashboardMigrations = join(here, "..", "drizzle");

const OPERATOR = "operator@example.com";
const SECOND = "second@example.com";
const MERCHANT = "merchant@example.com";
const FIRST = "first@example.com";
const AUTH_SECRET = "x".repeat(40);
const NETWORK = "eip155:84532";

if (databaseUrl === null) {
  console.log(noDatabaseHere(WANTED));
  describe("the workspace's changes to accounts on a real database", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => undefined);
  });
} else {
  const connected = connect(databaseUrl);
  const pool = connected.pool;
  const store = PostgresStore.over(connected.db, NETWORK, randomIds);
  const journal = postgresJournal(pool);
  const messages: Message[] = [];
  let handing: Handover = "accepted";
  /** How long the provider takes over a mail about the flag. */
  let handingMs = 0;
  const identityWith = (environment: Record<string, string> = {}): Identity =>
    identityFor(
      loadConfig({
        DATABASE_URL: databaseUrl,
        AUTH_SECRET,
        PAYMENT_NETWORK: NETWORK,
        FACILITATOR_URL: "sandbox:scripted",
        ...environment,
      }),
      {
        pool,
        postman: async (message) => {
          messages.push(message);
          if (!message.subject.includes("operator")) return "accepted";
          await new Promise((resolve) => setTimeout(resolve, handingMs));
          return handing;
        },
      },
    );
  const identity = identityWith();

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    messages.length = 0;
    handing = "accepted";
    handingMs = 0;
    await pool.query("drop schema public cascade");
    await pool.query("drop schema if exists drizzle cascade");
    await pool.query("create schema public");
    await migrate(drizzle(pool), { migrationsFolder: gatewayMigrations });
    await migrateAccounts(pool, dashboardMigrations);
  });

  const signIn = async (email: string, through: Identity = identity): Promise<Person> => {
    const asked = await through.requestLink(email, "default", ONE_CLIENT);
    if (asked.status !== "accepted") throw new Error(`the link was ${asked.status}`);
    const raw = messages.at(-1)?.body.match(/https?:\/\/\S+/)?.[0] ?? "";
    const opened = await through.openLink(new URL(raw).searchParams.get("token") ?? "");
    if (opened.status !== "opened") throw new Error("the link did not open");
    return opened.person;
  };

  const operator = async (email: string): Promise<Person> => {
    const person = await signIn(email);
    await pool.query("update dashboard_accounts set operator = true where email = $1", [email]);
    return person;
  };

  const withMerchant = async (email: string): Promise<{ person: Person; merchantId: string }> => {
    const person = await signIn(email);
    const merchant = await store.addMerchant({ id: randomIds("mch"), name: "A merchant" }, 1);
    if (merchant === null) throw new Error("the merchant was not made");
    const attached = await identity.attachMerchant(person.id, async () => merchant.id);
    if (attached.status !== "attached") throw new Error(`the merchant was ${attached.status}`);
    return { person, merchantId: merchant.id };
  };

  const press = (
    action: JournalPress["action"],
    subject: string,
    by = "acc_operator",
  ): JournalPress => ({
    at: Date.parse("2026-10-24T09:00:00Z"),
    actor: { kind: "account", id: by },
    action,
    subject: { kind: "account", id: subject },
    reason: "Asked by the owner",
  });

  /** Runs a change through the journal, its row settled by what `changedOf` reads in its result. */
  const along = <R>(
    pressed: JournalPress,
    work: (tx: JournalTransaction) => Promise<R>,
    changedOf: (result: R) => boolean | null,
  ): Promise<R> =>
    journal.along(pressed, async (tx) => {
      if (tx === null)
        throw new Error("the journal on Postgres hands every change its transaction");
      const result = await work(tx);
      return { result, changed: changedOf(result) };
    });

  /** From here on the database refuses to write a journal row, after the change it records ran. */
  const rowsFail = async () => {
    await pool.query(`create function no_rows() returns trigger language plpgsql as
      $$ begin raise exception 'the journal refuses this row'; end $$`);
    await pool.query(
      "create trigger no_rows before insert on operator_journal for each row execute function no_rows()",
    );
  };
  const rowsWork = async () => {
    await pool.query("drop trigger no_rows on operator_journal");
  };

  const rows = async () =>
    (
      await pool.query<{ action: string; subject_id: string; actor_kind: string }>(
        "select action, subject_id, actor_kind from operator_journal order by sequence",
      )
    ).rows;

  const flagOf = async (id: string): Promise<boolean | undefined> =>
    (await pool.query("select operator from dashboard_accounts where id = $1", [id])).rows[0]
      ?.operator;

  const asked = { at: new Date("2026-10-24T09:00:00Z"), by: OPERATOR };

  describe("the workspace's changes to accounts on a real database", () => {
    it("lists the accounts with a merchant or the flag, and counts the ones that only signed in", async () => {
      const boss = await operator(OPERATOR);
      const seller = await withMerchant(MERCHANT);
      await signIn("reader@example.com");
      await signIn("another-reader@example.com");

      const listing = await identity.operatorAccounts(new Date());

      expect(listing.unlisted).toBe(2);
      expect(listing.listed.map((one) => [one.email, one.operator, one.merchantId])).toEqual(
        expect.arrayContaining([
          [OPERATOR, true, null],
          [MERCHANT, false, seller.merchantId],
        ]),
      );
      expect(listing.listed).toHaveLength(2);
      const mine = listing.listed.find((one) => one.id === boss.id);
      expect(mine?.openSessions).toBe(1);
      expect(mine?.newestSession).toBeInstanceOf(Date);
    });

    it("ends every session of an account with its row, and keeps them where the row fails", async () => {
      const seller = await withMerchant(MERCHANT);
      const ending = press("end_sessions", seller.person.id);

      await rowsFail();
      await expect(
        along(
          ending,
          async (tx) => await identity.endSessionsIn(tx, seller.person.id, new Date()),
          () => true,
        ),
      ).rejects.toThrow();
      await rowsWork();
      expect((await identity.operatorAccount(seller.person.id, new Date()))?.openSessions).toBe(1);
      expect(await rows()).toStrictEqual([]);

      const ended = await along(
        ending,
        async (tx) => await identity.endSessionsIn(tx, seller.person.id, new Date()),
        (result) => result === "ended",
      );

      expect(ended).toBe("ended");
      expect((await identity.operatorAccount(seller.person.id, new Date()))?.openSessions).toBe(0);
      expect(await rows()).toMatchObject([
        { action: "end_sessions", subject_id: seller.person.id },
      ]);
      expect(
        await along(
          press("end_sessions", "acc_nobody"),
          async (tx) => await identity.endSessionsIn(tx, "acc_nobody", new Date()),
          () => null,
        ),
      ).toBe("no-account");
    });

    it("grants the flag once every operator and the account were mailed, and not where the row fails", async () => {
      await operator(OPERATOR);
      await operator(SECOND);
      const seller = await withMerchant(MERCHANT);
      const granting = press("grant_operator", seller.person.id);
      messages.length = 0;

      await rowsFail();
      await expect(
        along(
          granting,
          async (tx) => await identity.setOperatorIn(tx, seller.person.id, true, asked),
          () => true,
        ),
      ).rejects.toThrow();
      await rowsWork();
      expect(await flagOf(seller.person.id)).toBe(false);
      // The mails went out before the row failed, and say the change holds
      // only where Accounts shows it, which it does not.
      expect(messages).toHaveLength(3);
      expect(messages[0]?.body).toContain("applies only if Accounts in the workspace shows it");

      messages.length = 0;
      const granted = await along(
        granting,
        async (tx) => await identity.setOperatorIn(tx, seller.person.id, true, asked),
        (result) => result === "changed",
      );

      expect(granted).toBe("changed");
      expect(await flagOf(seller.person.id)).toBe(true);
      expect(messages.map((one) => one.to).sort()).toStrictEqual([MERCHANT, OPERATOR, SECOND]);
      expect(messages[0]?.body).toContain(MERCHANT);
      expect(messages[0]?.body).toContain("sandbox");
      expect(await rows()).toMatchObject([{ action: "grant_operator" }]);
      expect(
        await along(
          granting,
          async (tx) => await identity.setOperatorIn(tx, seller.person.id, true, asked),
          () => null,
        ),
      ).toBe("unchanged");
    });

    it("leaves the flag as it was where a mail about it is not handed over", async () => {
      await operator(OPERATOR);
      const seller = await withMerchant(MERCHANT);
      handing = "refused";

      await expect(
        along(
          press("grant_operator", seller.person.id),
          async (tx) => await identity.setOperatorIn(tx, seller.person.id, true, asked),
          (result) => result === "changed",
        ),
      ).rejects.toBeInstanceOf(OperatorMailRefused);

      expect(await flagOf(seller.person.id)).toBe(false);
      expect(await rows()).toStrictEqual([]);
    });

    it("never removes the last operator's flag, even when two removals are pressed at once", async () => {
      const one = await operator(OPERATOR);
      const other = await operator(SECOND);
      const removing = (id: string) =>
        along(
          press("remove_operator", id),
          async (tx) => await identity.setOperatorIn(tx, id, false, asked),
          (result) => (result === "changed" ? true : null),
        );

      // A slow provider holds the first removal open while the second is
      // pressed, so both would see two operators without the one lock.
      handingMs = 300;
      const answers = await Promise.all([removing(one.id), removing(other.id)]);

      expect([...answers].sort()).toStrictEqual(["changed", "last-operator"]);
      expect(
        (await pool.query("select count(*)::int as n from dashboard_accounts where operator"))
          .rows[0]?.n,
      ).toBe(1);
      expect(await rows()).toHaveLength(1);
    });

    it("forgets what the product wrote for an address, and nothing of anybody else's", async () => {
      // Everything is made through the code that makes it in a deployment, so
      // the test proves the forgetting removes what the product writes rather
      // than what a fixture guessed it writes.
      await operator(OPERATOR);
      const seller = await withMerchant(MERCHANT);
      const bystander = await withMerchant(SECOND);
      for (const [merchantId, item] of [
        [seller.merchantId, "room-101"],
        [bystander.merchantId, "their-room"],
      ] as const) {
        await store.publishCard(
          merchantId,
          {
            merchant_item_id: item,
            title: "A room for the night",
            description: "One night in a room",
            price: { amount: "80.00", currency: "USD" },
            result: { access_code: { type: "string" } },
            fulfillment: "sync",
          },
          Date.now(),
        );
      }
      await issueKey(store, randomIds, seller.merchantId, "worker", Date.now(), "test");
      const report = {
        operation: "send" as const,
        email: MERCHANT,
        destination: { report: randomUUID() },
        request: randomUUID(),
      };
      expect((await identity.sendReportLink(report)).status).toBe("accepted");
      const now = new Date();
      await postgresWooShops(pool).connect({
        accountId: seller.person.id,
        shopUrl: "https://shop.example.com",
        consumerKey: "k".repeat(43),
        consumerSecret: "s".repeat(43),
        permissions: "read_write",
        revision: "first",
        connectedAt: now,
        currency: null,
      });
      const wallet = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
      const network = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, NETWORK);
      await store.setPayoutWallet(
        seller.merchantId,
        { address: null, pending: null },
        {
          address: wallet,
          split: payoutSplitFor(network, seller.merchantId, wallet),
          pending: null,
        },
        Date.now(),
      );
      const countOf = async (table: string, column: string, value: string): Promise<number> =>
        (
          await pool.query<{ n: number }>(
            `select count(*)::int as n from ${table} where ${column} = $1`,
            [value],
          )
        ).rows[0]?.n ?? -1;
      expect(
        await countOf("commerce_analytics_events", "refs ->> 'merchant'", seller.merchantId),
      ).toBeGreaterThan(0);

      const forgotten = await along(
        press("forget_account", seller.person.id),
        async (tx) => await identity.forgetIn(tx, seller.person.id),
        (result) => (result.kind === "forgotten" ? true : null),
      );

      expect(forgotten).toMatchObject({ kind: "forgotten", merchant: { cards: 1 } });
      for (const [table, column, value] of [
        ["dashboard_accounts", "id", seller.person.id],
        ["dashboard_sessions", "user_id", seller.person.id],
        ["dashboard_woo_shops", "account_id", seller.person.id],
        ["merchants", "id", seller.merchantId],
        ["merchant_keys", "merchant_id", seller.merchantId],
        ["cards", "merchant_id", seller.merchantId],
        ["commerce_analytics_events", "refs ->> 'merchant'", seller.merchantId],
      ] as const) {
        expect(await countOf(table, column, value), table).toBe(0);
      }
      // Money may still sit at a split after its merchant is gone.
      expect(await countOf("payout_splits", "merchant_id", seller.merchantId)).toBe(1);
      expect(await countOf("merchants", "id", bystander.merchantId)).toBe(1);
      expect(await countOf("cards", "merchant_id", bystander.merchantId)).toBe(1);
      expect((await identity.requestLink(SECOND, "default", ONE_CLIENT)).status).toBe("cooldown");
      // Both senders let the address ask again at once.
      expect((await identity.sendReportLink({ ...report, request: randomUUID() })).status).toBe(
        "accepted",
      );
      expect((await identity.requestLink(MERCHANT, "default", ONE_CLIENT)).status).toBe("accepted");
    });

    it("forgets an account with its merchant and cards, and nothing where the row fails", async () => {
      await operator(OPERATOR);
      const seller = await withMerchant(MERCHANT);
      const forgetting = press("forget_account", seller.person.id);

      await rowsFail();
      await expect(
        along(
          forgetting,
          async (tx) => await identity.forgetIn(tx, seller.person.id),
          () => true,
        ),
      ).rejects.toThrow();
      await rowsWork();
      expect(await identity.byEmail(MERCHANT)).not.toBeNull();
      expect(await store.merchantById(seller.merchantId)).not.toBeNull();

      const forgotten = await along(
        forgetting,
        async (tx) => await identity.forgetIn(tx, seller.person.id),
        (result) => (result.kind === "forgotten" ? true : null),
      );

      expect(forgotten).toMatchObject({
        kind: "forgotten",
        email: MERCHANT,
        merchant: { id: seller.merchantId, present: true },
      });
      expect(await identity.byEmail(MERCHANT)).toBeNull();
      expect(await store.merchantById(seller.merchantId)).toBeNull();
      expect(await rows()).toMatchObject([{ action: "forget_account" }]);
      const again = await signIn(MERCHANT);
      expect(again.id).not.toBe(seller.person.id);
      expect(again.merchant).toBeNull();
    });

    it.each([
      [
        "an order",
        "insert into orders (id, state, open, item_id, merchant_item_id, record, created_at, updated_at, merchant_id) values ('ord_one', 'settled', false, 'item_one', 'room-101', '{}', now(), now(), $1)",
      ],
      [
        "a receipt",
        "insert into receipts (order_id, receipt, updated_at, merchant_id) values ('ord_one', '{}', now(), $1)",
      ],
    ])("refuses to forget a merchant with %s, removing nothing", async (_history, seed) => {
      const seller = await withMerchant(MERCHANT);
      await pool.query(seed, [seller.merchantId]);

      const refused = await along(
        press("forget_account", seller.person.id),
        async (tx) => await identity.forgetIn(tx, seller.person.id),
        () => null,
      );

      expect(refused).toMatchObject({ kind: "money-history", merchantId: seller.merchantId });
      expect(await identity.byEmail(MERCHANT)).not.toBeNull();
      expect(await store.merchantById(seller.merchantId)).not.toBeNull();
    });

    it("refuses to forget any account holding the operator flag, and a merchant another account names", async () => {
      const boss = await operator(OPERATOR);
      const deputy = await operator("deputy@example.com");
      const seller = await withMerchant(MERCHANT);
      const colleague = await signIn(SECOND);
      await identity.attachMerchant(colleague.id, async () => seller.merchantId);

      const forget = (id: string) =>
        along(
          press("forget_account", id),
          async (tx) => await identity.forgetIn(tx, id),
          () => null,
        );

      expect(await forget(deputy.id)).toStrictEqual({ kind: "operator" });
      expect(await forget(boss.id)).toStrictEqual({ kind: "operator" });
      expect(await forget(seller.person.id)).toMatchObject({ kind: "shared-merchant", others: 1 });
      expect(await forget("acc_nobody")).toStrictEqual({ kind: "no-account" });
      expect(await identity.byEmail(OPERATOR)).not.toBeNull();
      expect(await identity.byEmail("deputy@example.com")).not.toBeNull();
      expect(await identity.byEmail(MERCHANT)).not.toBeNull();
    });

    it("gives the configured first operator the flag at their sign-in, journaled as the configuration's, once", async () => {
      const configured = identityWith({ FIRST_OPERATOR_EMAIL: FIRST });
      await signIn("somebody@example.com", configured);
      expect((await configured.operatorAccounts(new Date())).listed).toStrictEqual([]);

      const first = await signIn(FIRST, configured);

      expect(await flagOf(first.id)).toBe(true);
      expect(await rows()).toStrictEqual([
        { action: "first_operator", subject_id: first.id, actor_kind: "configuration" },
      ]);

      // A channel that lost every operator does not take the configured one again.
      await pool.query("update dashboard_accounts set operator = false");
      await pool.query("delete from dashboard_link_sends");
      await signIn(FIRST, configured);
      expect(await flagOf(first.id)).toBe(false);
      expect(await rows()).toHaveLength(1);
    });

    it("keeps an operator's account from the scanner's deletion until its flag is removed", async () => {
      const boss = await operator(OPERATOR);
      const deleting = async () =>
        await identity.deleteUnattachedPerson({
          operation: "delete",
          operation_id: randomUUID(),
          email: OPERATOR,
        });

      expect(await deleting()).toStrictEqual({ status: "retained" });
      expect(await flagOf(boss.id)).toBe(true);

      await pool.query("update dashboard_accounts set operator = false where id = $1", [boss.id]);
      expect(await deleting()).toStrictEqual({ status: "deleted" });
      expect(await identity.byEmail(OPERATOR)).toBeNull();
    });

    it("reads the seller names and money history of the merchants accounts name, across merchants", async () => {
      const reader = postgresOperatorReader(connected.db, NETWORK);
      const one = await withMerchant(MERCHANT);
      const other = await withMerchant(SECOND);
      await pool.query("update merchants set service_name = 'Example Rooms' where id = $1", [
        one.merchantId,
      ]);
      await pool.query(
        "insert into receipts (order_id, receipt, updated_at, merchant_id) values ('ord_one', '{}', now(), $1)",
        [other.merchantId],
      );

      const named = await reader.accounts.merchantsNamed([
        one.merchantId,
        other.merchantId,
        "mch_gone",
      ]);

      expect([...named].sort((a, b) => a.id.localeCompare(b.id))).toStrictEqual(
        [
          { id: one.merchantId, serviceName: "Example Rooms" },
          { id: other.merchantId, serviceName: null },
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
      expect(await reader.accounts.historyOf(other.merchantId)).toStrictEqual({
        orders: 0,
        receipts: 1,
      });
      expect(await reader.accounts.historyOf("mch_gone")).toStrictEqual({ orders: 0, receipts: 0 });
    });

    it("gives the configured address nothing on a channel whose flag was ever granted", async () => {
      const configured = identityWith({ FIRST_OPERATOR_EMAIL: FIRST });
      await pool.query(
        "insert into operator_journal (at, actor_kind, action, subject_kind, subject_id, outcome) values (now(), 'terminal', 'grant_operator', 'account', 'acc_gone', 'done')",
      );

      const first = await signIn(FIRST, configured);

      expect(await flagOf(first.id)).toBe(false);
    });
  });
}

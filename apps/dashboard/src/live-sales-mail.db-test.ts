/** Durable handover against the real shared database; no external mail is sent. */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PostgresStore, randomIds } from "@agentify/gateway";
import type { JournalPress } from "@agentify/gateway/journal";
import type { LiveSalesAsk, LiveSalesRequest } from "@agentify/gateway/live-sales";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { copierFor, postgresPersonRecords } from "./data-copy.js";
import { migrateAccounts } from "./database.js";
import { deliverLiveSalesMail, postgresLiveSalesNotices } from "./live-sales-mail.js";
import type { Handover, Message } from "./mail.js";
import { forgetIn } from "./operator-accounts.js";
import { postgresWooShops } from "./woo-shops.js";

const wanted = new URL(testDatabaseUrl());
wanted.pathname = "/agentify_test_live_sales_mail";
const databaseUrl = await readyDatabase(wanted.toString());
const at = Date.parse("2026-10-30T14:00:00Z");
const config = {
  surfaceMode: "live" as const,
  publicBaseUrl: "https://agentify.example",
  basePath: "/dashboard",
  mailFrom: "Agentify <noreply@example.com>",
  mailUrl: "https://api.resend.com",
};
const secret = "live-sales-mail-test-secret-at-least-thirty-two-characters";

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted.toString()));
  it.skip("needs its disposable PostgreSQL server", () => undefined);
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query("drop schema if exists drizzle cascade");
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../../gateway/drizzle", import.meta.url)),
  });
  await migrateAccounts(pool, fileURLToPath(new URL("../drizzle", import.meta.url)));
  afterAll(() => pool.end());

  const store = PostgresStore.over(
    drizzle(pool),
    "eip155:8453",
    randomIds,
    undefined,
    postgresLiveSalesNotices(config),
  );
  let clock = at;
  let handover: Handover = "accepted";
  let messages: Message[] = [];
  beforeEach(async () => {
    await pool.query("truncate dashboard_accounts, merchants, operator_journal cascade");
    clock = at;
    handover = "accepted";
    messages = [];
  });
  const person = async (operator = false, merchantId: string | null = null) => {
    const id = `acc_${randomUUID()}`;
    const email = `${id}@example.com`;
    await pool.query(
      "insert into dashboard_accounts(id,email,email_verified,operator,merchant_id,created_at,updated_at) values($1,$2,true,$3,$4,now(),now())",
      [id, email, operator, merchantId],
    );
    return { id, email };
  };
  const merchant = async () => {
    const merchantId = `mch_${randomUUID()}`;
    await store.addMerchant({ id: merchantId, name: "A merchant" }, at - 1000);
    const account = await person(false, merchantId);
    const ask: LiveSalesAsk = {
      merchantId,
      accountId: account.id,
      sellerName: "Nuanu shop",
      evidence: { integration: "api", connectedAt: at - 1000 },
    };
    return { ...account, merchantId, ask };
  };
  const request = async (ask: LiveSalesAsk): Promise<LiveSalesRequest> => {
    const result = await store.requestLiveSales(ask, at);
    if (result.kind !== "requested") throw new Error(`request was ${result.kind}`);
    return result.request;
  };
  const press = (merchantId: string): JournalPress => ({
    at: at + 1000,
    actor: { kind: "account", id: "acc_operator" },
    action: "decline",
    subject: { kind: "merchant", id: merchantId },
    reason: "Use the trading name.\nThen ask again.",
  });
  const rows = async () =>
    (await pool.query("select * from dashboard_live_sales_mail order by kind,recipient_account_id"))
      .rows;
  const turn = (overrides: Partial<typeof config> = {}) =>
    deliverLiveSalesMail({
      pool,
      config: { ...config, ...overrides },
      now: () => new Date(clock),
      postman: async (message) => {
        messages.push(structuredClone(message));
        return handover;
      },
    });

  const setupEvents = async (merchantId: string) =>
    (
      await pool.query(
        "select actor_type,source,properties,refs from commerce_analytics_events where name='agc_setup_result' and refs->>'merchant'=$1 order by sequence",
        [merchantId],
      )
    ).rows;

  describe("live-sales notices on PostgreSQL", () => {
    it("keeps one request notice per operator and rolls the request and name back if mail cannot be recorded", async () => {
      await person(true);
      const seller = await merchant();
      await pool.query(`create function refuse_live_mail() returns trigger language plpgsql as
        $$ begin raise exception 'mail insertion refused'; end $$`);
      await pool.query(
        "create trigger refuse_live_mail before insert on dashboard_live_sales_mail for each row execute function refuse_live_mail()",
      );
      try {
        await expect(store.requestLiveSales(seller.ask, at)).rejects.toThrow();
        expect(await store.liveSalesRequest(seller.merchantId)).toBeNull();
        expect((await store.merchantById(seller.merchantId))?.serviceName).toBeNull();
        expect(await rows()).toHaveLength(0);
        expect(await setupEvents(seller.merchantId)).toEqual([]);
      } finally {
        await pool.query("drop trigger refuse_live_mail on dashboard_live_sales_mail");
        await pool.query("drop function refuse_live_mail()");
      }
      const concurrent = await Promise.all(
        Array.from({ length: 8 }, () => store.requestLiveSales(seller.ask, at)),
      );
      expect(concurrent.filter((result) => result.kind === "requested")).toHaveLength(1);
      expect(concurrent.filter((result) => result.kind === "pending")).toHaveLength(7);
      expect(await setupEvents(seller.merchantId)).toEqual([
        {
          actor_type: "human",
          source: "dashboard",
          refs: { merchant: seller.merchantId },
          properties: { step: "seller_name", integration: "none", outcome: "completed" },
        },
        {
          actor_type: "human",
          source: "dashboard",
          refs: { merchant: seller.merchantId, person: seller.ask.accountId },
          properties: { step: "live_request", integration: "api", outcome: "completed" },
        },
      ]);
      const asked = await store.liveSalesRequest(seller.merchantId);
      if (!asked) throw new Error("No persisted request");
      expect(await rows()).toMatchObject([
        { request_id: asked.id, kind: "requested", state: "pending" },
      ]);
      await turn();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.body).toContain(seller.email);
    });

    it("does not commit a decline or journal row without its merchant notice", async () => {
      await person(true);
      const seller = await merchant();
      const asked = await request(seller.ask);
      await pool.query(`create function refuse_decline_mail() returns trigger language plpgsql as
        $$ begin if NEW.kind = 'declined' then raise exception 'mail insertion refused'; end if; return NEW; end $$`);
      await pool.query(
        "create trigger refuse_decline_mail before insert on dashboard_live_sales_mail for each row execute function refuse_decline_mail()",
      );
      try {
        await expect(
          store.declineLiveSales(seller.merchantId, asked.id, press(seller.merchantId)),
        ).rejects.toThrow();
        expect(await store.liveSalesRequest(seller.merchantId)).toMatchObject({
          state: "pending",
          decline: null,
        });
        expect((await setupEvents(seller.merchantId)).map((row) => row.properties.step)).toEqual([
          "seller_name",
          "live_request",
        ]);
        expect(
          (await store.journal({ about: { merchant: seller.merchantId }, limit: 20 })).rows,
        ).toEqual([]);
      } finally {
        await pool.query("drop trigger refuse_decline_mail on dashboard_live_sales_mail");
        await pool.query("drop function refuse_decline_mail()");
      }
      await store.declineLiveSales(seller.merchantId, asked.id, press(seller.merchantId));
      await store.declineLiveSales(seller.merchantId, asked.id, press(seller.merchantId));
      expect(
        (await setupEvents(seller.merchantId)).filter(
          (row) => row.properties.step === "live_decline",
        ),
      ).toEqual([
        {
          actor_type: "operator",
          source: "dashboard",
          refs: { merchant: seller.merchantId },
          properties: { step: "live_decline", integration: "api", outcome: "completed" },
        },
      ]);
      clock += 1000;
      await turn();
      await turn();
      const declined = messages.find((message) => message.to === seller.email);
      expect(declined?.body).toContain("Use the trading name.\nThen ask again.");
      expect((await rows()).filter((row) => row.kind === "declined")).toMatchObject([
        { state: "accepted" },
      ]);
    });

    it("does not decline or mail a request admitted by the concurrent operator ahead of it", async () => {
      await person(true);
      const seller = await merchant();
      const asked = await request(seller.ask);
      const admittingPool = new Pool({
        connectionString: databaseUrl,
        application_name: "live-mail-admit",
        max: 1,
      });
      const decliningPool = new Pool({
        connectionString: databaseUrl,
        application_name: "live-mail-decline",
        max: 1,
      });
      const admitting = PostgresStore.over(
        drizzle(admittingPool),
        "eip155:8453",
        randomIds,
        undefined,
        postgresLiveSalesNotices(config),
      );
      const declining = PostgresStore.over(
        drizzle(decliningPool),
        "eip155:8453",
        randomIds,
        undefined,
        postgresLiveSalesNotices(config),
      );
      const blocker = await pool.connect();
      await blocker.query("begin");
      await blocker.query("select id from merchants where id=$1 for update", [seller.merchantId]);
      const granted = admitting.grantLiveApproval(seller.merchantId, at + 1);
      let declined: ReturnType<typeof declining.declineLiveSales> | undefined;
      const waiting = async (name: string) =>
        (
          await pool.query(
            "select count(*)::int as n from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
            [name],
          )
        ).rows[0]?.n === 1;
      try {
        await expect.poll(() => waiting("live-mail-admit")).toBe(true);
        declined = declining.declineLiveSales(
          seller.merchantId,
          asked.id,
          press(seller.merchantId),
        );
        await expect.poll(() => waiting("live-mail-decline")).toBe(true);
        await blocker.query("commit");
        expect(await granted).toMatchObject({ changed: true });
        expect(await declined).toMatchObject({ changed: false, request: { state: "admitted" } });
        expect(await store.liveSalesRequest(seller.merchantId)).toMatchObject({
          state: "admitted",
          decline: null,
        });
        expect((await rows()).filter((row) => row.kind === "declined")).toEqual([]);
        expect(
          (await store.journal({ about: { merchant: seller.merchantId }, limit: 20 })).rows,
        ).toMatchObject([{ action: "decline", outcome: { kind: "unchanged" } }]);
      } finally {
        await blocker.query("rollback");
        blocker.release();
        await Promise.allSettled([granted, declined]);
        await Promise.all([admittingPool.end(), decliningPool.end()]);
      }
    });

    it("retries an unknown handover after restart with the frozen message and separates refusal from acceptance", async () => {
      await person(true);
      const seller = await merchant();
      await request(seller.ask);
      handover = "unknown";
      await turn();
      expect(await rows()).toMatchObject([
        { state: "pending", last_outcome: "unknown", attempts: 1 },
      ]);
      const first = messages[0];
      await store.setServiceName(seller.merchantId, "Changed trading name", at + 2000);
      handover = "refused";
      clock += 60_000;
      await turn();
      expect(messages[1]).toEqual(first);
      expect(await rows()).toMatchObject([
        { state: "pending", last_outcome: "refused", attempts: 2 },
      ]);
      handover = "accepted";
      clock += 120_000;
      await turn();
      expect(messages[2]).toEqual(first);
      expect(await rows()).toMatchObject([
        { state: "accepted", last_outcome: "accepted", attempts: 3 },
      ]);
      expect(await turn()).toBe(false);
    });

    it("allows only one concurrent dispatcher to hand over a recipient's message", async () => {
      await person(true);
      const seller = await merchant();
      await request(seller.ask);
      let began!: () => void;
      const entered = new Promise<void>((resolve) => {
        began = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sending = deliverLiveSalesMail({
        pool,
        config,
        now: () => new Date(clock),
        postman: async (message) => {
          messages.push(message);
          began();
          await gate;
          return "accepted";
        },
      });
      await entered;
      try {
        expect(await turn()).toBe(false);
      } finally {
        release();
      }
      await sending;
      expect(messages).toHaveLength(1);
      expect(await rows()).toMatchObject([{ attempts: 1, state: "accepted" }]);
    });

    it.each(["role", "address", "sender", "provider"] as const)(
      "suppresses a retry after its %s changes",
      async (change) => {
        const operator = await person(true);
        const seller = await merchant();
        await request(seller.ask);
        handover = "unknown";
        await turn();
        clock += 60_000;
        if (change === "role")
          await pool.query("update dashboard_accounts set operator=false where id=$1", [
            operator.id,
          ]);
        if (change === "address")
          await pool.query("update dashboard_accounts set email=$1 where id=$2", [
            "changed@example.com",
            operator.id,
          ]);
        await turn(
          change === "sender"
            ? { mailFrom: "changed@example.com" }
            : change === "provider"
              ? { mailUrl: "https://other.example" }
              : {},
        );
        expect(messages).toHaveLength(1);
        expect(await rows()).toMatchObject([
          { state: "suppressed", last_outcome: "unknown", attempts: 1 },
        ]);
      },
    );

    it("does not deliver a decline after an account stops naming that merchant", async () => {
      const seller = await merchant();
      const asked = await request(seller.ask);
      await store.declineLiveSales(seller.merchantId, asked.id, press(seller.merchantId));
      await pool.query("update dashboard_accounts set merchant_id=null where id=$1", [seller.id]);
      clock += 1000;
      await turn();
      expect(messages).toEqual([]);
      expect(await rows()).toMatchObject([{ state: "suppressed", suppression: "role_changed" }]);
    });

    it("reminds current operators once and suppresses unanswered reminders after the request is decided", async () => {
      const oldOperator = await person(true);
      const seller = await merchant();
      const asked = await request(seller.ask);
      await turn();
      const currentOperator = await person(true);
      await pool.query("update dashboard_accounts set operator=false where id=$1", [
        oldOperator.id,
      ]);
      clock = asked.reminderDueAt - 1;
      expect(await turn()).toBe(false);
      clock += 1;
      handover = "unknown";
      await turn();
      expect(messages.at(-1)?.to).toBe(currentOperator.email);
      expect((await rows()).filter((row) => row.kind === "reminder")).toHaveLength(1);
      expect((await store.liveSalesRequest(seller.merchantId))?.reminderCreatedAt).toBe(clock);
      await store.grantLiveApproval(seller.merchantId, clock + 1);
      clock += 60_000;
      await turn();
      await turn();
      expect((await rows()).filter((row) => row.kind === "reminder")).toMatchObject([
        { state: "suppressed", suppression: "request_answered" },
      ]);
      const count = messages.filter((message) => message.to === currentOperator.email).length;
      clock += 86400_000;
      await turn();
      expect(messages.filter((message) => message.to === currentOperator.email)).toHaveLength(
        count,
      );
    });

    it("records that a reminder with no eligible operators was considered once", async () => {
      const seller = await merchant();
      const asked = await request(seller.ask);
      clock = asked.reminderDueAt;
      await turn();
      expect(await rows()).toEqual([]);
      expect((await store.liveSalesRequest(seller.merchantId))?.reminderCreatedAt).toBe(clock);
      await person(true);
      await turn();
      expect(messages).toEqual([]);
    });

    it("keeps private delivery payload out of a data copy and erases it with the account", async () => {
      const operator = await person(true);
      const seller = await merchant();
      await request(seller.ask);
      await turn();
      const frozen = (await rows())[0]?.message;
      expect(frozen?.to).toBe(operator.email);
      const copies: Message[] = [];
      const copy = copierFor(
        { people: postgresPersonRecords(pool), store, wooShops: postgresWooShops(pool, secret) },
        async (message) => {
          copies.push(message);
          return "accepted";
        },
        "https://agentify.example/privacy",
      );
      await copy({
        operation: "copy",
        request: randomUUID(),
        requested_at: new Date(at).toISOString(),
        email: seller.email,
        scanner: {},
      });
      const attachment = copies[0]?.attachments?.[0]?.content;
      expect(attachment).toBeDefined();
      expect(attachment).not.toContain(operator.email);
      expect(attachment).not.toContain(frozen.idempotencyKey);
      expect(attachment).not.toContain("<!doctype html>");
      const erased = await drizzle(pool).transaction((tx) => forgetIn(tx, seller.id, secret));
      expect(erased.kind).toBe("forgotten");
      expect(await rows()).toEqual([]);
    });

    it("keeps private notices pending while mail is configured to log instead of deliver", async () => {
      await person(true);
      const seller = await merchant();
      const asked = await request(seller.ask);
      clock = asked.reminderDueAt;
      expect(await turn({ mailUrl: "sandbox:log" })).toBe(false);
      expect(messages).toEqual([]);
      expect(await rows()).toMatchObject([{ state: "pending", message: null, attempts: 0 }]);
      expect((await store.liveSalesRequest(seller.merchantId))?.reminderCreatedAt).toBeNull();
      await turn();
      expect(messages).toHaveLength(1);
      expect((await rows()).some((row) => row.state === "accepted")).toBe(true);
    });

    it("never sends or schedules operator mail on the test channel", async () => {
      await person(true);
      const seller = await merchant();
      const asked = await request(seller.ask);
      clock = asked.reminderDueAt;
      expect(
        await deliverLiveSalesMail({
          pool,
          config: { ...config, surfaceMode: "test" },
          now: () => new Date(clock),
          postman: async (message) => {
            messages.push(message);
            return "accepted";
          },
        }),
      ).toBe(false);
      expect(messages).toEqual([]);
      expect((await store.liveSalesRequest(seller.merchantId))?.reminderCreatedAt).toBeNull();
    });
  });
}

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PostgresStore } from "@agentify/gateway";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { copierFor, postgresPersonRecords } from "./data-copy.js";
import { migrateAccounts } from "./database.js";
import type { Message } from "./mail.js";
import { shopJobView } from "./shop-job-view.js";
import { type JobRequest, postgresShopJobs } from "./shop-jobs.js";
import { postgresWooShops } from "./woo-shops.js";

const wanted = new URL(testDatabaseUrl());
wanted.pathname = "/agentify_test_dashboard_shop_jobs";
const databaseUrl = await readyDatabase(wanted.toString());
if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted.toString()));
  it.skip("needs its disposable PostgreSQL server", () => undefined);
} else {
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query("drop schema if exists drizzle cascade");
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../../gateway/drizzle", import.meta.url)),
  });
  await migrateAccounts(pool, fileURLToPath(new URL("../drizzle", import.meta.url)));
  afterAll(() => pool.end());
  const account = async () => {
    const id = randomUUID();
    const merchantId = "mch_" + id;
    await pool.query(
      "insert into merchants(id,name,integration,selling,created_at,updated_at) values ($1,'A shop','woocommerce','open',now(),now())",
      [merchantId],
    );
    await pool.query(
      "insert into dashboard_accounts(id,name,email,email_verified,created_at,updated_at,merchant_id) values ($1,'',$2,true,now(),now(),$3)",
      [id, id + "@example.com", merchantId],
    );
    return {
      merchantId,
      accountId: id,
      connectionRevision: "grant-1",
      shopUrl: "https://woo.nuanu.ai",
      kind: "check" as const,
    };
  };
  const eventsFor = async (merchantId: string) =>
    (
      await pool.query(
        "select actor_type,source,properties from commerce_analytics_events where name='agc_setup_result' and refs->>'merchant'=$1 order by sequence",
        [merchantId],
      )
    ).rows;
  describe("persisted shop work on PostgreSQL", () => {
    it.each(["completed", "unknown"] as const)(
      "records a check's %s terminal observations once, without treating a queued job as a result",
      async (outcome) => {
        const input = await account();
        const jobs = postgresShopJobs(pool);
        const { job } = await jobs.request(input);
        expect(await eventsFor(input.merchantId)).toEqual([]);
        expect((await jobs.claim())?.id).toBe(job.id);
        await jobs.record(
          job.id,
          {
            id: "27",
            title: "Guide",
            group: "ready",
            reason: "ready",
            why: "",
            published: false,
          },
          outcome === "completed" ? 1 : null,
        );
        expect(await eventsFor(input.merchantId)).toEqual([]);
        const result =
          outcome === "completed"
            ? { status: "completed" as const, why: null, stopCode: null }
            : {
                status: "stopped" as const,
                why: "We could not read the rest.",
                stopCode: "unknown" as const,
              };
        await Promise.all([
          jobs.finish(job.id, result),
          postgresShopJobs(pool).finish(job.id, result),
        ]);
        const recorded = await eventsFor(input.merchantId);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({
          actor_type: "system",
          source: "woocommerce",
          properties: {
            step: "woo_check",
            outcome,
            observed_ready_count: 1,
            observed_read_count: 1,
          },
        });
        if (outcome === "unknown") expect(recorded[0].properties.reason_code).toBe("unknown");
      },
    );

    it.each(["completed", "partial", "unknown"] as const)(
      "retains the manual import contract when publication finishes %s",
      async (outcome) => {
        const input = await account();
        const jobs = postgresShopJobs(pool);
        const { job } = await jobs.request({
          ...input,
          kind: "publish",
          currency: { code: "USD", decimals: 2 },
          rate: null,
        });
        expect(await eventsFor(input.merchantId)).toEqual([]);
        expect((await jobs.claim())?.id).toBe(job.id);
        for (const [id, group, reason, published] of [
          ["27", "ready", "ready", true],
          ["28", "fix", "product_content", false],
          ["29", "unanswered", "shop_check", false],
          ["30", "not_selling", "withdrawn", false],
          ["31", "unsupported", "product_type", false],
        ] as const) {
          await jobs.record(
            job.id,
            {
              id,
              title: "Guide",
              group,
              reason,
              why: "",
              published,
              ...(published ? { publication: "accepted" as const } : {}),
            },
            5,
          );
        }
        if (outcome !== "completed")
          await jobs.record(
            job.id,
            {
              id: "32",
              title: "Guide",
              group: outcome === "partial" ? "fix" : "ready",
              reason: outcome === "partial" ? "publication" : "publication_unknown",
              why: "",
              published: false,
              publication: outcome === "partial" ? "refused" : "unknown",
            },
            6,
          );
        expect(await eventsFor(input.merchantId)).toEqual([]);
        const result =
          outcome === "unknown"
            ? {
                status: "stopped" as const,
                stopCode: "unknown" as const,
                why: "Publication outcome unknown.",
              }
            : { status: "completed" as const, stopCode: null, why: null };
        await Promise.all([
          jobs.finish(job.id, result),
          postgresShopJobs(pool).finish(job.id, result),
        ]);
        expect(await eventsFor(input.merchantId)).toEqual([
          {
            actor_type: "human",
            source: "dashboard",
            properties: {
              step: "woo_import",
              integration: "woocommerce",
              outcome,
              ...(outcome === "unknown" ? { reason_code: "internal_error" } : {}),
              imported_count: 1,
              failed_count: outcome === "completed" ? 0 : 1,
              skipped_count: 4,
            },
          },
        ]);
      },
    );

    it("rolls a terminal event back with the job, while a broken outbox never prevents completion", async () => {
      const input = await account();
      const jobs = postgresShopJobs(pool);
      const { job } = await jobs.request(input);
      expect((await jobs.claim())?.id).toBe(job.id);
      await pool.query(
        "create function refuse_job_commit() returns trigger language plpgsql as $$ begin if new.status='completed' then raise exception 'job commit refused'; end if; return new; end $$",
      );
      await pool.query(
        "create constraint trigger refuse_job_commit after update on dashboard_shop_jobs deferrable initially deferred for each row execute function refuse_job_commit()",
      );
      try {
        await expect(
          jobs.finish(job.id, { status: "completed", why: null, stopCode: null }),
        ).rejects.toThrow();
        expect(await jobs.latest(input.merchantId)).toMatchObject([{ status: "running" }]);
        expect(await eventsFor(input.merchantId)).toEqual([]);
      } finally {
        await pool.query("drop trigger refuse_job_commit on dashboard_shop_jobs");
        await pool.query("drop function refuse_job_commit()");
      }
      await jobs.finish(job.id, { status: "completed", why: null, stopCode: null });
      expect(await eventsFor(input.merchantId)).toHaveLength(1);
      const next = await jobs.request(input);
      expect((await jobs.claim())?.id).toBe(next.job.id);
      await pool.query(
        "create function refuse_job_analytics() returns trigger language plpgsql as $$ begin raise exception 'outbox refused'; end $$",
      );
      await pool.query(
        "create trigger refuse_job_analytics before insert on commerce_analytics_events for each row execute function refuse_job_analytics()",
      );
      try {
        await jobs.finish(next.job.id, { status: "completed", why: null, stopCode: null });
        expect(await jobs.latest(input.merchantId)).toMatchObject([{ status: "completed" }]);
        expect(await eventsFor(input.merchantId)).toHaveLength(1);
      } finally {
        await pool.query("drop trigger refuse_job_analytics on commerce_analytics_events");
        await pool.query("drop function refuse_job_analytics()");
      }
      const unread = await jobs.request(input);
      expect((await jobs.claim())?.id).toBe(unread.job.id);
      await pool.query(
        "alter table dashboard_shop_job_products rename to shop_products_unavailable",
      );
      try {
        await jobs.finish(unread.job.id, { status: "completed", why: null, stopCode: null });
        expect(await jobs.latest(input.merchantId)).toMatchObject([{ status: "completed" }]);
        expect(await eventsFor(input.merchantId)).toHaveLength(1);
      } finally {
        await pool.query(
          "alter table shop_products_unavailable rename to dashboard_shop_job_products",
        );
      }
    });

    it("starts queued work in the order it was asked for", async () => {
      const jobs = postgresShopJobs(pool);
      const asked: string[] = [];
      for (let index = 0; index < 6; index++)
        asked.push((await jobs.request(await account())).job.id);
      const started: string[] = [];
      try {
        for (let job = await jobs.claim(); job !== null; job = await jobs.claim())
          if (asked.includes(job.id)) started.push(job.id);
      } finally {
        await jobs.close();
      }
      expect(started).toEqual(asked);
    });

    it("shows a running publication's counts on the screen, and its rows only once it ends", async () => {
      const input = await account();
      const shops = postgresWooShops(pool, "test-auth-secret-at-least-thirty-two-characters");
      const { job } = await shops.jobs.request({
        ...input,
        kind: "publish",
        currency: { code: "USD", decimals: 2 },
        rate: null,
      });
      await shops.jobs.claim();
      for (const [id, group, reason, published] of [
        ["27", "ready", "ready", true],
        ["28", "ready", "ready", false],
        ["29", "fix", "product_content", false],
        ["30", "ready", "publication_unknown", false],
      ] as const)
        await shops.jobs.record(
          job.id,
          { id, title: `Guide ${id}`, group, reason, why: "", published },
          4,
        );
      const counts = { ready: 3, published: 1, excluded: 1, publicationUnknown: "Guide 30" };
      try {
        expect(await shops.jobs.shown(input.merchantId)).toEqual({
          job: expect.objectContaining({ id: job.id, status: "running", read: 4 }),
          rows: [],
          counts,
        });
        expect(await shopJobView(shops, input.merchantId, new URLSearchParams())).toMatchObject({
          status: "running",
          ...counts,
          groups: [],
        });
        await shops.jobs.finish(job.id, { status: "completed", why: null, stopCode: null });
        const ended = await shops.jobs.shown(input.merchantId);
        expect(ended?.counts).toEqual(counts);
        expect(ended?.rows.map((row) => row.id)).toEqual(["27", "28", "29", "30"]);
      } finally {
        await shops.jobs.close();
      }
    });

    it("admits one active job across independent callers and database-enforces the same rule", async () => {
      const input = await account();
      await expect(
        postgresShopJobs(pool).request({ ...input, kind: "publish" } as JobRequest),
      ).rejects.toThrow("checked currency and exchange rate");
      expect(await postgresShopJobs(pool).latest(input.merchantId)).toEqual([]);
      await Promise.all(Array.from({ length: 10 }, () => pool.query("select 1")));
      const requests = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          postgresShopJobs(pool).request({
            ...input,
            ...(i % 2
              ? { kind: "publish" as const, currency: { code: "USD", decimals: 2 }, rate: null }
              : { kind: "check" as const }),
          }),
        ),
      );
      expect(new Set(requests.map((one) => one.job.id)).size).toBe(1);
      const first = requests[0];
      if (!first) throw new Error("No request result");
      const opposite = await postgresShopJobs(pool).request({
        ...input,
        ...(first.job.kind === "check"
          ? { kind: "publish" as const, currency: { code: "USD", decimals: 2 }, rate: null }
          : { kind: "check" as const }),
      });
      expect(opposite).toMatchObject({ accepted: false, job: { kind: first.job.kind } });
      await expect(
        pool.query(
          "insert into dashboard_shop_jobs(id,account_id,merchant_id,kind,status,data) values ($1,$2,$3,'check','queued',$4)",
          [randomUUID(), input.accountId, input.merchantId, first.job],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      const owner = postgresShopJobs(pool);
      await owner.claim();
      await owner.finish(first.job.id, {
        status: "completed",
        why: null,
        stopCode: null,
      });
    });
    it("a new process reads partial results as stopped, ignores late writes and isolates the tenant", async () => {
      const input = await account();
      const original = postgresShopJobs(pool);
      const { job } = await original.request(input);
      expect((await original.claim())?.id).toBe(job.id);
      await original.record(
        job.id,
        { id: "27", title: "Guide", group: "ready", reason: "ready", why: "", published: false },
        2,
      );
      await original.total(job.id, null);
      await original.close();
      const restarted = postgresShopJobs(pool);
      await restarted.interrupted();
      await original.finish(job.id, { status: "completed", why: null, stopCode: null });
      await original.record(
        job.id,
        { id: "28", title: "Late", group: "ready", reason: "ready", why: "", published: false },
        2,
      );
      expect(await restarted.latest(input.merchantId)).toMatchObject([
        { status: "stopped", stopCode: "interrupted", read: 1, total: null },
      ]);
      expect(await restarted.rows(input.merchantId, job.id)).toMatchObject([{ id: "27" }]);
      expect(await restarted.rows("other", job.id)).toEqual([]);
      await pool.query("delete from dashboard_accounts where id=$1", [input.accountId]);
      expect(await restarted.latest(input.merchantId)).toEqual([]);
      expect(
        (await pool.query("select * from dashboard_shop_job_products where job_id=$1", [job.id]))
          .rows,
      ).toEqual([]);
    });
    it.each(["screen", "data export"])(
      "keeps the result count and rows together in %s when another reader replaces the completed job",
      async (consumer) => {
        const input = await account();
        const jobs = postgresShopJobs(pool);
        const { job } = await jobs.request(input);
        await jobs.claim();
        await jobs.record(
          job.id,
          {
            id: "27",
            title: "Guide",
            group: "ready",
            reason: "ready",
            why: "",
            published: false,
          },
          1,
        );
        await jobs.finish(job.id, { status: "completed", why: null, stopCode: null });
        let held = false;
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        // Delay a real database answer, without changing its SQL or data. A second
        // connection replaces the result while the first reader is between awaits.
        const delayed = <T extends object>(target: T): T =>
          new Proxy(target, {
            get(target, key) {
              const value = Reflect.get(target, key);
              if (typeof value !== "function") return value;
              if (key === "connect")
                return async (...args: unknown[]) =>
                  delayed((await Reflect.apply(value, target, args)) as object);
              if (key === "query")
                return async (...args: unknown[]) => {
                  const result = await Reflect.apply(value, target, args);
                  if (!held && JSON.stringify(result).includes(job.id)) {
                    held = true;
                    await gate;
                  }
                  return result;
                };
              return value.bind(target);
            },
          });
        const shops = postgresWooShops(
          delayed(pool),
          "test-auth-secret-at-least-thirty-two-characters",
        );
        const mails: Message[] = [];
        const reading =
          consumer === "screen"
            ? shopJobView(shops, input.merchantId, new URLSearchParams())
            : copierFor(
                {
                  wooShops: shops,
                  people: postgresPersonRecords(pool),
                  store: PostgresStore.over(drizzle(pool), "eip155:84532", () => randomUUID()),
                },
                async (mail) => {
                  mails.push(mail);
                  return "accepted";
                },
                "https://agentify.ad/privacy",
              )({
                operation: "copy",
                request: randomUUID(),
                requested_at: new Date().toISOString(),
                email: input.accountId + "@example.com",
                scanner: {},
              });
        try {
          await expect.poll(() => held).toBe(true);
          const replacement = await jobs.request(input);
          await jobs.claim();
          await jobs.finish(replacement.job.id, { status: "completed", stopCode: null, why: null });
        } finally {
          release();
        }
        const answer = await reading;
        if (consumer === "screen") {
          expect(answer).toMatchObject({
            id: job.id,
            read: 1,
            ready: 1,
            groups: [{ count: 1, reasons: [{ rows: [{ id: "27", title: "Guide" }] }] }],
          });
        } else {
          const attachment = mails[0]?.attachments?.[0];
          if (!attachment) throw new Error("No data copy attachment");
          expect(JSON.parse(attachment.content).dashboard.merchant.shop_jobs).toMatchObject([
            { id: job.id, read: 1, products: [{ id: "27", title: "Guide" }] },
          ]);
        }
      },
    );
    it("callback connection and the first chosen rate durably enqueue checks in their own transaction", async () => {
      const input = await account();
      const shops = postgresWooShops(pool, "test-auth-secret-at-least-thirty-two-characters");
      const now = new Date();
      await shops.beginGrant({
        token: randomUUID(),
        ...input,
        currency: null,
        startedAt: now,
        expiresAt: new Date(now.getTime() + 900_000),
      });
      const grant = await shops.grantFor(input.accountId);
      if (!grant) throw new Error("No pending grant");
      expect(
        await shops.connectFromGrant(
          grant.token,
          { consumerKey: "ck_fixture", consumerSecret: "cs_fixture", permissions: "read_write" },
          now,
        ),
      ).not.toBeNull();
      const connected = (await shops.jobs.latest(input.merchantId))[0];
      if (!connected) throw new Error("No connection job");
      expect(connected).toMatchObject({ status: "queued", kind: "check" });
      await shops.jobs.claim();
      await shops.jobs.finish(connected.id, {
        status: "stopped",
        stopCode: "rate_required",
        why: "Choose a rate",
      });
      await shops.saveRate(input.accountId, input.shopUrl, {
        currency: "IDR",
        rate: "18000",
        setAt: now,
        sessionSignedInAt: null,
        reference: null,
        confirmed: false,
      });
      expect(await shops.jobs.latest(input.merchantId)).toMatchObject([
        { status: "queued", kind: "check" },
      ]);
      const queued = (await shops.jobs.latest(input.merchantId))[0];
      if (!queued) throw new Error("No rate job");
      await shops.jobs.claim();
      await shops.jobs.finish(queued.id, { status: "completed", stopCode: null, why: null });
      await shops.saveRate(input.accountId, input.shopUrl, {
        currency: "IDR",
        rate: "19000",
        setAt: now,
        sessionSignedInAt: null,
        reference: null,
        confirmed: false,
      });
      expect((await shops.jobs.latest(input.merchantId))[0]?.id).toBe(queued.id);
    });
  });
}

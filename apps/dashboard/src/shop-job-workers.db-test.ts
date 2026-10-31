import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { harness } from "@agentify/gateway/testing";
import { readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, expect, it } from "vitest";
import { migrateAccounts } from "./database.js";
import { gatewayFor } from "./gateway.js";
import { type ShopWorkParts, shopPublisherFor, startShopJobs } from "./shop-job-runner.js";
import { postgresShopJobs } from "./shop-jobs.js";
import { memoryWooShops, postgresWooShops } from "./woo-shops.js";

const wanted = new URL(testDatabaseUrl());
wanted.pathname = "/agentify_test_dashboard_shop_job_workers";
const databaseUrl = await readyDatabase(wanted.toString());
if (databaseUrl === null) throw new Error("The isolated shop worker database is required");
const pool = new Pool({ connectionString: databaseUrl });
const h = await harness();
afterAll(() => h.stop());
await pool.query("drop schema public cascade");
await pool.query("create schema public");
await pool.query("drop schema if exists drizzle cascade");
await migrate(drizzle(pool), {
  migrationsFolder: fileURLToPath(new URL("../../gateway/drizzle", import.meta.url)),
});
await migrateAccounts(pool, fileURLToPath(new URL("../drizzle", import.meta.url)));
afterAll(() => pool.end());
const account = async (merchant = "mch_" + randomUUID()) => {
  const id = randomUUID();
  const merchantId = merchant;
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
const completed = { status: "completed", why: null, stopCode: null } as const;

it("four held catalogue reads leave job status and enqueue available to pages", async () => {
  const inputs = await Promise.all([account(), account(), account(), account(), account()]);
  const pagePool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: 500,
  });
  const ownershipPool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: 500,
  });
  const pageShops = postgresWooShops(
    pagePool,
    "test-auth-secret-at-least-thirty-two-characters",
    ownershipPool,
  );
  const shops = memoryWooShops();
  for (const input of inputs.slice(0, 4)) {
    await shops.connect({
      accountId: input.accountId,
      shopUrl: input.shopUrl,
      revision: input.connectionRevision,
      consumerKey: input.accountId,
      consumerSecret: "cs_fixed",
      permissions: "read_write",
      connectedAt: new Date(),
      currency: null,
    });
    await pageShops.jobs.request(input);
  }
  const held = Promise.withResolvers<void>();
  const reading = new Set<string>();
  const worker = startShopJobs({
    shops: { ...shops, jobs: pageShops.jobs },
    identity: {
      byId: async (id) => {
        const input = inputs.find((one) => one.accountId === id);
        return input
          ? { id, email: `${id}@example.com`, confirmed: true, merchant: { id: input.merchantId } }
          : null;
      },
    },
    clientFor: (acting) => gatewayFor(h.gateway, acting),
    publisherFor: () => ({
      publish: async () => null,
      cards: async () => [],
      read: async () => null,
      pause: async () => {},
    }),
    surfaceMode: "sandbox",
    catalogue: async function* (keys) {
      yield { kind: "currency", currency: { code: "USD", decimals: 2 } };
      reading.add(keys.consumerKey);
      await held.promise;
      yield { kind: "complete", total: 0 };
    },
  });
  try {
    await worker.ready;
    await expect.poll(() => reading.size).toBe(4);
    const locks = await pool.query<{ count: number }>(
      "select count(*)::int as count from pg_locks where locktype='advisory' and database=(select oid from pg_database where datname=current_database()) and granted",
    );
    expect(locks.rows[0]?.count).toBe(4);
    for (const input of inputs.slice(0, 4))
      expect(await pageShops.jobs.latest(input.merchantId)).toMatchObject([{ status: "running" }]);
    await postgresWooShops(
      pagePool,
      "test-auth-secret-at-least-thirty-two-characters",
      ownershipPool,
    ).jobs.interrupted();
    expect(await pageShops.jobs.snapshots(inputs[0].merchantId)).toMatchObject([
      { job: { status: "running" }, rows: [] },
    ]);
    expect((await pageShops.jobs.request(inputs[4])).accepted).toBe(true);
    expect(await pageShops.jobs.latest(inputs[4].merchantId)).toMatchObject([{ status: "queued" }]);
    expect(reading.size).toBe(4);
  } finally {
    held.resolve();
    await worker.stop();
    await Promise.all([pagePool.end(), ownershipPool.end()]);
    await pool.query("delete from dashboard_shop_jobs where account_id = any($1::text[])", [
      inputs.map((input) => input.accountId),
    ]);
  }
});

it("a rolling replacement preserves live work, excludes a second seller job and lets the old owner finish", async () => {
  const input = await account();
  const old = postgresShopJobs(pool);
  const next = postgresShopJobs(pool);
  const { job } = await old.request(input);
  expect((await old.claim())?.id).toBe(job.id);
  try {
    await next.interrupted();
    expect(await next.latest(input.merchantId)).toMatchObject([{ status: "running" }]);
    expect((await next.request({ ...input, connectionRevision: "grant-2" })).accepted).toBe(false);
    expect(await next.claim()).toBeNull();
    await next.finish(job.id, completed);
    expect(await old.latest(input.merchantId)).toMatchObject([{ status: "running" }]);
    await old.finish(job.id, completed);
    expect(await next.latest(input.merchantId)).toMatchObject([{ status: "completed" }]);
  } finally {
    await old.finish(job.id, completed);
  }
});

it("a lost database owner leaves honest partial results and cannot write over recovery", async () => {
  const input = await account();
  const ownerName = "shop-owner-" + randomUUID();
  const ownerPool = new Pool({ connectionString: databaseUrl, application_name: ownerName });
  ownerPool.on("error", () => {});
  const old = postgresShopJobs(ownerPool);
  const next = postgresShopJobs(pool);
  const { job } = await old.request(input);
  await old.claim();
  await old.record(
    job.id,
    { id: "27", title: "Guide", group: "ready", reason: "ready", why: "", published: false },
    null,
  );
  try {
    await pool.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where application_name=$1",
      [ownerName],
    );
    await expect
      .poll(async () => {
        await next.interrupted();
        return (await next.latest(input.merchantId))[0]?.status;
      })
      .toBe("stopped");
    await old.finish(job.id, completed);
    await old.record(
      job.id,
      { id: "28", title: "Late", group: "ready", reason: "ready", why: "", published: false },
      2,
    );
    expect(await next.latest(input.merchantId)).toMatchObject([
      { status: "stopped", stopCode: "interrupted", read: 1, total: null },
    ]);
    expect(await next.rows(input.merchantId, job.id)).toMatchObject([{ id: "27" }]);
    const replacement = await next.request(input);
    expect(replacement.job.id).not.toBe(job.id);
    expect((await next.claim())?.id).toBe(replacement.job.id);
    await next.finish(replacement.job.id, completed);
    expect(await next.latest(input.merchantId)).toMatchObject([{ status: "completed" }]);
  } finally {
    await ownerPool.end();
  }
});

it("a held shop read does not delay another seller, including when a new process joins", async () => {
  const inputs = await Promise.all([account(), account()]);
  const shops = memoryWooShops();
  for (const input of inputs)
    await shops.connect({
      accountId: input.accountId,
      shopUrl: input.shopUrl,
      revision: input.connectionRevision,
      consumerKey: input.accountId,
      consumerSecret: "cs_fixed",
      permissions: "read_write",
      connectedAt: new Date(),
      currency: null,
    });
  const jobs = postgresShopJobs(pool);
  for (const input of inputs) await jobs.request(input);
  const held = Promise.withResolvers<void>();
  const seen = new Set<string>();
  const parts: ShopWorkParts = {
    shops: { ...shops, jobs },
    identity: {
      byId: async (id) => {
        const input = inputs.find((one) => one.accountId === id);
        return input
          ? { id, email: id + "@example.com", confirmed: true, merchant: { id: input.merchantId } }
          : null;
      },
    },
    clientFor: (acting) => gatewayFor(h.gateway, acting),
    publisherFor: () => ({
      publish: async () => null,
      cards: async () => [],
      read: async () => null,
      pause: async () => {},
    }),
    surfaceMode: "sandbox",
    catalogue: async function* (keys) {
      seen.add(keys.consumerKey);
      yield { kind: "currency", currency: { code: "USD", decimals: 2 } };
      await held.promise;
      yield { kind: "complete", total: 0 };
    },
  };
  const old = startShopJobs(parts);
  let next: ReturnType<typeof startShopJobs> | undefined;
  try {
    await old.ready;
    await expect.poll(() => seen.size).toBe(2);
    next = startShopJobs({ ...parts, shops: { ...shops, jobs: postgresShopJobs(pool) } });
    await next.ready;
    for (const input of inputs)
      expect(await jobs.latest(input.merchantId)).toMatchObject([{ status: "running" }]);
    held.resolve();
    await expect
      .poll(
        async () =>
          await Promise.all(
            inputs.map(async (input) => (await jobs.latest(input.merchantId))[0]?.status),
          ),
      )
      .toEqual(["completed", "completed"]);
  } finally {
    held.resolve();
    await Promise.all([old.stop(), next?.stop()]);
  }
});

it("a still-running process stops publishing when its ownership connection dies", async () => {
  const input = await account(h.merchant.id);
  await h.gateway.sellThrough(h.merchant.id, "woocommerce");
  const ownerName = `shop-publisher-${randomUUID()}`;
  const ownerPool = new Pool({ connectionString: databaseUrl, application_name: ownerName });
  ownerPool.on("error", () => {});
  const jobs = postgresShopJobs(ownerPool);
  const shops = memoryWooShops();
  await shops.connect({
    accountId: input.accountId,
    shopUrl: input.shopUrl,
    revision: input.connectionRevision,
    consumerKey: "ck_fixed",
    consumerSecret: "cs_fixed",
    permissions: "read_write",
    connectedAt: new Date(),
    currency: { code: "USD", decimals: 2 },
  });
  await jobs.request({
    ...input,
    kind: "publish",
    currency: { code: "USD", decimals: 2 },
    rate: null,
  });
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const readDone = Promise.withResolvers<void>();
  const worker = startShopJobs({
    shops: { ...shops, jobs },
    identity: {
      byId: async () => ({
        id: input.accountId,
        email: "owner@example.com",
        confirmed: true,
        merchant: { id: input.merchantId },
      }),
    },
    clientFor: (acting) => gatewayFor(h.gateway, acting),
    publisherFor: (acting) => shopPublisherFor(h.gateway, acting, shops),
    surfaceMode: "sandbox",
    catalogue: async function* () {
      try {
        yield { kind: "currency", currency: { code: "USD", decimals: 2 } };
        reached.resolve();
        await release.promise;
        yield {
          kind: "product",
          product: {
            id: 27,
            name: "Guide",
            sku: "guide",
            type: "simple",
            description: "A downloadable guide.",
            short_description: "",
            is_purchasable: true,
            is_in_stock: true,
            status: "publish",
            virtual: true,
            downloadable: true,
            manage_stock: false,
            download_limit: -1,
            download_expiry: -1,
            downloads: [{ id: "guide", name: "Guide", file: "https://woo.nuanu.ai/guide.pdf" }],
            qualification_problem: null,
            prices: { price: "2500", currency_code: "USD", currency_minor_unit: 2 },
          },
          inspected: {
            ok: true,
            product: {
              kind: "download",
              productId: "27",
              downloadId: "guide",
              fileName: "Guide",
              price: { amount: "25.00", currency: "USD" },
              fingerprint: "observed-guide",
              tax: { mode: "off" },
            },
          },
        };
        yield { kind: "complete", total: 1 };
      } finally {
        readDone.resolve();
      }
    },
  });
  try {
    await reached.promise;
    await pool.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where application_name=$1 and pid in (select pid from pg_locks where locktype='advisory')",
      [ownerName],
    );
    const next = postgresShopJobs(pool);
    await expect
      .poll(async () => {
        await next.interrupted();
        return (await next.latest(input.merchantId))[0]?.status;
      })
      .toBe("stopped");
    release.resolve();
    await readDone.promise;
    expect(await h.store.cards(input.merchantId)).toEqual([]);
    expect(await next.latest(input.merchantId)).toMatchObject([
      { status: "stopped", stopCode: "interrupted", read: 0 },
    ]);
  } finally {
    release.resolve();
    await worker.stop();
    await ownerPool.end();
  }
});

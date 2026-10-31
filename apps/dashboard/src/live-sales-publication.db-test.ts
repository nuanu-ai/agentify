/** Real shared transactions, with a disposable database and no provider or shop network. */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  Gateway,
  MemoryQueue,
  nobodyAnnounces,
  PAYOUT_SPLIT_NETWORKS,
  PostgresStore,
  payoutSplitFor,
  payoutSplitNetworkOf,
  randomIds,
  ScriptedFacilitator,
  widestChallengeOn,
} from "@agentify/gateway";
import { testConfig } from "@agentify/gateway/testing";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { migrateAccounts } from "./database.js";
import { gatewayFor } from "./gateway.js";
import { identityFor } from "./identity.js";
import { deliverLiveSalesMail, postgresLiveSalesNotices } from "./live-sales-mail.js";
import { advanceLivePublication } from "./live-sales-publication.js";
import type { Message } from "./mail.js";
import { shopPublisherFor, startShopJobs } from "./shop-job-runner.js";
import { postgresWooShops } from "./woo-shops.js";

const wanted = new URL(testDatabaseUrl());
wanted.pathname = "/agentify_test_live_sales_publication";
const databaseUrl = await readyDatabase(wanted.toString());
const at = Date.parse("2026-10-30T14:00:00Z");
const config = {
  surfaceMode: "live" as const,
  publicBaseUrl: "https://agentify.example",
  basePath: "/dashboard",
  mailFrom: "Agentify <noreply@example.com>",
  mailUrl: "https://api.resend.com",
};
const wallet = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const replacement = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
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
  const shops = postgresWooShops(pool, "admission-test-secret-at-least-thirty-two-characters");
  let sent: Message[] = [];
  beforeEach(async () => {
    await pool.query("truncate dashboard_accounts,merchants,operator_journal cascade");
    sent = [];
  });
  const rows = async (table: "dashboard_live_sales_mail" | "dashboard_live_publications") =>
    (await pool.query(`select * from ${table} order by id`)).rows;
  const saveWallet = async (merchantId: string, address = wallet) => {
    const before = await store.merchantById(merchantId);
    if (!before) throw new Error("merchant missing");
    return store.setPayoutWallet(
      merchantId,
      before.payoutWallet,
      {
        address,
        split: payoutSplitFor(
          payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:8453"),
          merchantId,
          address,
        ),
        pending: null,
      },
      at + 100,
    );
  };
  const seller = async ({
    accountId = `acc_${randomUUID()}`,
    withWallet = true,
    name = true,
    site = undefined as boolean | undefined,
    connected = true,
    integration = "woocommerce" as "woocommerce" | "api",
  } = {}) => {
    const merchantId = `mch_${randomUUID()}`;
    await store.addMerchant({ id: merchantId, name: "Merchant" }, at);
    await pool.query(
      "insert into dashboard_accounts(id,email,merchant_id,created_at,updated_at) values($1,$2,$3,now(),now())",
      [accountId, `${accountId}@example.com`, merchantId],
    );
    if (name) await store.setServiceName(merchantId, "Freeland", at);
    if (site ?? name) await store.setSellerSite(merchantId, "https://freeland.app", at);
    await store.switchIntegration(merchantId, integration);
    if (withWallet) await saveWallet(merchantId);
    const connection = {
      accountId,
      shopUrl: "https://woo.nuanu.ai",
      consumerKey: "ck_test",
      consumerSecret: "cs_test",
      permissions: "read_write",
      revision: randomUUID(),
      connectedAt: new Date(at),
      currency: { code: "USD", decimals: 2 as const },
    };
    if (connected) await shops.connect(connection);
    return { merchantId, accountId, connection };
  };
  const press = (merchantId: string, action: "admit" | "withdraw") => ({
    at: at + 500,
    actor: { kind: "account" as const, id: "acc_operator" },
    action,
    subject: { kind: "merchant" as const, id: merchantId },
    reason: action === "withdraw" ? "Correct the seller name.\nKeep the full explanation." : null,
  });
  const approve = (id: string) =>
    store.grantLiveApproval(id, at + 500, undefined, press(id, "admit"));
  const check = async (one: Awaited<ReturnType<typeof seller>>) => {
    const queued = await shops.jobs.request({
      merchantId: one.merchantId,
      accountId: one.accountId,
      connectionRevision: one.connection.revision,
      shopUrl: one.connection.shopUrl,
      kind: "check",
    });
    const job = await shops.jobs.claim();
    if (!job || job.id !== queued.job.id) throw new Error("check missing");
    return job;
  };
  const finishCheck = async (id: string) => {
    await shops.jobs.currency(id, { code: "USD", decimals: 2 });
    await shops.jobs.finish(id, { status: "completed", why: null, stopCode: null });
  };
  const firstAccount = async (merchantId: string) => {
    const accountId = "acc_a_first";
    await pool.query(
      "insert into dashboard_accounts(id,email,merchant_id,created_at,updated_at) values($1,$2,$3,now(),now())",
      [accountId, `${accountId}@example.com`, merchantId],
    );
    return accountId;
  };
  const request = async (one: Awaited<ReturnType<typeof seller>>) => {
    const checking = await check(one);
    await shops.jobs.record(
      checking.id,
      {
        id: "1",
        title: "Writing assistant",
        group: "ready",
        reason: "ready",
        why: "",
        published: false,
      },
      1,
    );
    await finishCheck(checking.id);
    const result = await store.requestLiveSales(
      {
        merchantId: one.merchantId,
        accountId: one.accountId,
        sellerName: "Freeland",
        evidence: {
          integration: "woocommerce",
          host: "woo.nuanu.ai",
          checkedAt: at,
          ready: 1,
          read: 1,
          total: 1,
          complete: true,
        },
      },
      at + 200,
    );
    if (result.kind !== "requested") throw new Error(`request was ${result.kind}`);
  };
  const dispatch = () =>
    deliverLiveSalesMail({
      pool,
      config,
      now: () => new Date("2099-01-01Z"),
      postman: async (message) => {
        sent.push(message);
        return "accepted";
      },
    });

  describe("admission publication and mail", () => {
    it.each(["admitted", "first_wallet"] as const)(
      "queues the admitted request owner's publication when an earlier account has no shop (%s)",
      async (trigger) => {
        const one = await seller({ accountId: "acc_z_owner", withWallet: trigger === "admitted" });
        await firstAccount(one.merchantId);
        await request(one);
        await approve(one.merchantId);
        if (trigger === "first_wallet") await saveWallet(one.merchantId);
        expect(await store.liveSalesRequest(one.merchantId)).toMatchObject({
          state: "admitted",
          accountId: one.accountId,
        });
        const intents = await rows("dashboard_live_publications");
        expect(intents).toHaveLength(1);
        expect(intents[0]).toMatchObject({
          account_id: one.accountId,
          event: { kind: trigger },
        });
        expect(
          (await rows("dashboard_live_sales_mail")).some((row) => row.event.next === "connect"),
        ).toBe(false);
        await advanceLivePublication(pool, shops);
        const publications = (await shops.jobs.latest(one.merchantId)).filter(
          (job) => job.kind === "publish",
        );
        expect(publications).toHaveLength(1);
        expect(publications[0]).toMatchObject({
          accountId: one.accountId,
          connectionRevision: one.connection.revision,
          publicationId: intents[0].id,
        });
      },
    );
    it("uses the sole connected account for manual admission without a request", async () => {
      const one = await seller({ accountId: "acc_z_owner" });
      await firstAccount(one.merchantId);
      await approve(one.merchantId);
      expect(await store.liveSalesRequest(one.merchantId)).toBeNull();
      const intents = await rows("dashboard_live_publications");
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ account_id: one.accountId });
      expect(await rows("dashboard_live_sales_mail")).toEqual([]);
    });
    it("leaves two connected accounts to the Products action when no admitted request chooses one", async () => {
      const one = await seller({ accountId: "acc_z_owner" });
      const first = await firstAccount(one.merchantId);
      await shops.connect({ ...one.connection, accountId: first, revision: "first-grant" });
      await approve(one.merchantId);
      expect(await rows("dashboard_live_publications")).toEqual([]);
      const notices = await rows("dashboard_live_sales_mail");
      expect(notices).toHaveLength(2);
      expect(notices.map((row) => row.recipient_account_id).sort()).toEqual([first, one.accountId]);
      for (const notice of notices)
        expect(notice.event).toMatchObject({
          kind: "admitted",
          next: "products",
          publication: null,
        });
      await advanceLivePublication(pool, shops);
      expect(await shops.jobs.latest(one.merchantId)).toEqual([]);
    });
    it("preserves the admitted owner's identity when another connection has write permission", async () => {
      const one = await seller({ accountId: "acc_z_owner" });
      const first = await firstAccount(one.merchantId);
      await request(one);
      await shops.connect({ ...one.connection, permissions: "read", revision: "read-only-grant" });
      await shops.connect({ ...one.connection, accountId: first, revision: "other-write-grant" });
      await approve(one.merchantId);
      const intents = await rows("dashboard_live_publications");
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ account_id: one.accountId });
      expect(await rows("dashboard_live_sales_mail")).toEqual([]);
    });
    it("does not borrow an admitted request owner's shop after the account moves to another merchant", async () => {
      const one = await seller({ accountId: "acc_z_owner", withWallet: false });
      const first = await firstAccount(one.merchantId);
      await request(one);
      await approve(one.merchantId);
      const other = await seller();
      await pool.query("update dashboard_accounts set merchant_id=$1 where id=$2", [
        other.merchantId,
        one.accountId,
      ]);
      await saveWallet(one.merchantId);
      expect(await rows("dashboard_live_publications")).toEqual([]);
      const notices = (await rows("dashboard_live_sales_mail")).filter(
        (row) => row.kind === "published",
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        recipient_account_id: first,
        event: { next: "connect", publication: null },
      });
      await advanceLivePublication(pool, shops);
      expect((await shops.jobs.latest(one.merchantId)).some((job) => job.kind === "publish")).toBe(
        false,
      );
    });
    it("finishes the admitted owner's automatic publication while another account has a current shop", async () => {
      const one = await seller({ accountId: "acc_z_owner" });
      const first = await firstAccount(one.merchantId);
      await shops.connect({ ...one.connection, accountId: first, revision: "other-write-grant" });
      await request(one);
      await approve(one.merchantId);
      await store.noteContact(one.merchantId, at + 1000, "woocommerce");
      const environment = {
        PAYMENT_NETWORK: "eip155:8453",
        FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
        CDP_API_KEY_ID: "key-id",
        CDP_API_KEY_SECRET: "key-secret",
      };
      const gatewayConfig = testConfig(environment);
      const application = new Gateway({
        config: gatewayConfig,
        store,
        queue: new MemoryQueue({
          attempts: gatewayConfig.reminderAttempts,
          retryDelayMs: gatewayConfig.reminderRetryDelayMs,
        }),
        facilitator: new ScriptedFacilitator(),
        clock: () => at + 1000,
        ids: randomIds,
        announcer: nobodyAnnounces,
        widestChallenge: widestChallengeOn(gatewayConfig),
      });
      const identity = identityFor(
        loadConfig({
          ...environment,
          DATABASE_URL: databaseUrl,
          AUTH_SECRET: "worker-publication-test-secret-at-least-thirty-two-characters",
        }),
        { pool },
      );
      let walks = 0;
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const worker = startShopJobs({
        shops,
        identity,
        clientFor: (acting) => gatewayFor(application, acting),
        publisherFor: (acting) => shopPublisherFor(application, acting, shops),
        surfaceMode: "live",
        advancePublications: () => advanceLivePublication(pool, shops),
        catalogue: async function* () {
          // Bound the broken loop after six actual jobs, without manufacturing its result.
          if (++walks >= 7) await held;
          yield { kind: "currency", currency: { code: "USD", decimals: 2 } };
          yield {
            kind: "product",
            // Owned lab product 22 (2026-10-30 capture): shortened descriptions, anonymized download ID/link.
            product: {
              id: 22,
              name: "Gift Wrapping Guide",
              sku: "DL-WRAPPING-GUIDE",
              type: "simple",
              description: "Wrap a box and tie a bow; one plain-text file.",
              short_description: "",
              is_purchasable: true,
              is_in_stock: true,
              status: "publish",
              virtual: true,
              downloadable: true,
              manage_stock: false,
              download_limit: -1,
              download_expiry: -1,
              downloads: [
                {
                  id: "guide",
                  name: "Gift Wrapping Guide",
                  file: "https://woo.nuanu.ai/download/guide.txt",
                },
              ],
              qualification_problem: null,
              prices: { price: "200", currency_code: "USD", currency_minor_unit: 2 },
            },
            inspected: {
              ok: true,
              product: {
                kind: "download",
                productId: "22",
                downloadId: "guide",
                fileName: "guide.txt",
                price: { amount: "2.00", currency: "USD" },
                fingerprint: "observed-guide",
                tax: { mode: "off" },
              },
            },
          };
          yield { kind: "complete", total: 1 };
        },
      });
      try {
        await vi.waitFor(
          async () => {
            const notices = await rows("dashboard_live_sales_mail");
            expect(walks >= 7 || notices.some((row) => row.event.publication != null)).toBe(true);
          },
          { timeout: 5000, interval: 10 },
        );
        const notices = await rows("dashboard_live_sales_mail");
        expect(notices).toHaveLength(2);
        for (const notice of notices)
          expect(notice.event).toMatchObject({
            kind: "admitted",
            publication: { status: "completed", published: 1, read: 1, total: 1 },
          });
        expect(await store.cards(one.merchantId)).toHaveLength(1);
        expect((await rows("dashboard_live_publications"))[0]).toMatchObject({
          account_id: one.accountId,
          state: "completed",
        });
        await dispatch();
        expect(sent).toHaveLength(1);
        expect(sent[0]?.body).toContain("1 product from woo.nuanu.ai");
      } finally {
        const stopped = worker.stop();
        release();
        await stopped;
      }
    });
    it("retains one trigger through an active check and freezes terminal counts before replacement", async () => {
      const one = await seller();
      const checking = await check(one);
      const grants = await Promise.all(Array.from({ length: 6 }, () => approve(one.merchantId)));
      expect(grants.filter((g) => g?.changed)).toHaveLength(1);
      await advanceLivePublication(pool, shops);
      expect(await rows("dashboard_live_publications")).toHaveLength(1);
      expect(await rows("dashboard_live_sales_mail")).toEqual([]);
      expect((await shops.jobs.latest(one.merchantId)).filter((j) => j.kind === "publish")).toEqual(
        [],
      );
      await finishCheck(checking.id);
      await Promise.all(Array.from({ length: 4 }, () => advanceLivePublication(pool, shops)));
      const publishing = await shops.jobs.claim();
      if (!publishing || publishing.kind !== "publish") throw new Error("publication missing");
      await shops.jobs.record(
        publishing.id,
        {
          id: "1",
          title: "Writing assistant",
          group: "ready",
          reason: "ready",
          why: "",
          published: true,
          publication: "accepted",
        },
        2,
      );
      await shops.jobs.record(
        publishing.id,
        {
          id: "2",
          title: "Writing assistant",
          group: "fix",
          reason: "price",
          why: "Set a price.",
          published: false,
        },
        2,
      );
      expect(await rows("dashboard_live_sales_mail")).toEqual([]);
      const importEvents = async () =>
        (
          await pool.query(
            "select actor_type,source,properties from commerce_analytics_events where refs->>'merchant'=$1 and properties->>'step'='woo_import' order by sequence",
            [one.merchantId],
          )
        ).rows;
      expect(await importEvents()).toEqual([]);
      await shops.jobs.finish(publishing.id, { status: "completed", why: null, stopCode: null });
      await shops.jobs.finish(publishing.id, { status: "completed", why: null, stopCode: null });
      expect(await importEvents()).toEqual([
        {
          actor_type: "system",
          source: "woocommerce",
          properties: {
            step: "woo_import",
            integration: "woocommerce",
            outcome: "completed",
            imported_count: 1,
            failed_count: 0,
            skipped_count: 1,
          },
        },
      ]);
      await shops.jobs.request({
        ...publishing,
        kind: "publish",
        currency: { code: "USD", decimals: 2 },
        rate: null,
        publicationId: undefined,
      });
      expect(await shops.jobs.rows(one.merchantId, publishing.id)).toEqual([]);
      expect((await rows("dashboard_live_sales_mail"))[0]?.event.publication).toMatchObject({
        published: 1,
        fix: 1,
        read: 2,
        total: 2,
        status: "completed",
      });
      await dispatch();
      expect(sent[0]?.body).toContain("1 product from woo.nuanu.ai");
    });
    it("keeps withdrawal mail, approval and journal unchanged when a new publication intent is refused", async () => {
      const one = await seller();
      await approve(one.merchantId);
      await store.withdrawLiveApproval(one.merchantId, press(one.merchantId, "withdraw"));
      await pool.query(
        "create function refuse_publication() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$",
      );
      await pool.query(
        "create trigger refuse_publication before insert on dashboard_live_publications for each row execute function refuse_publication()",
      );
      try {
        await expect(approve(one.merchantId)).rejects.toThrow();
        expect((await store.merchantById(one.merchantId))?.liveApprovedAt).toBeNull();
        expect(
          (await store.journal({ about: { merchant: one.merchantId }, limit: 20 })).rows
            .map((row) => row.action)
            .sort(),
        ).toEqual(["admit", "withdraw"]);
        expect(
          (await rows("dashboard_live_sales_mail")).find((row) => row.kind === "withdrawn"),
        ).toMatchObject({ state: "pending", suppression: null });
      } finally {
        await pool.query("drop trigger refuse_publication on dashboard_live_publications");
        await pool.query("drop function refuse_publication()");
      }
    });
    it("rolls terminal state back when its mail intent fails, then captures it on retry", async () => {
      const one = await seller();
      const checking = await check(one);
      await finishCheck(checking.id);
      await approve(one.merchantId);
      await advanceLivePublication(pool, shops);
      const job = await shops.jobs.claim();
      if (!job) throw new Error("publication missing");
      await pool.query(
        "create function refuse_result_mail() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$",
      );
      await pool.query(
        "create trigger refuse_result_mail before insert on dashboard_live_sales_mail for each row execute function refuse_result_mail()",
      );
      try {
        await expect(
          shops.jobs.finish(job.id, { status: "completed", why: null, stopCode: null }),
        ).rejects.toThrow();
        expect((await shops.jobs.latest(one.merchantId)).find((j) => j.id === job.id)?.status).toBe(
          "running",
        );
        expect((await rows("dashboard_live_publications"))[0]?.state).toBe("pending");
      } finally {
        await pool.query("drop trigger refuse_result_mail on dashboard_live_sales_mail");
        await pool.query("drop function refuse_result_mail()");
      }
      await shops.jobs.close();
      await shops.jobs.interrupted();
      expect((await rows("dashboard_live_sales_mail"))[0]?.event.publication).toMatchObject({
        status: "stopped",
        stopCode: "interrupted",
        read: 0,
        total: null,
      });
    });
    it("starts publication for the first saved wallet after approval, never its replacement", async () => {
      const one = await seller({ withWallet: false });
      await approve(one.merchantId);
      expect((await rows("dashboard_live_sales_mail"))[0]?.event.next).toBe("wallet");
      expect(await rows("dashboard_live_publications")).toEqual([]);
      await saveWallet(one.merchantId);
      await saveWallet(one.merchantId, replacement);
      expect(await rows("dashboard_live_publications")).toHaveLength(1);
      expect((await rows("dashboard_live_publications"))[0]?.event.kind).toBe("first_wallet");
    });
    it("keeps a first wallet and its split unsaved if the automatic publication intent fails", async () => {
      const one = await seller({ withWallet: false });
      await approve(one.merchantId);
      await pool.query(
        "create function refuse_wallet_publication() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$",
      );
      await pool.query(
        "create trigger refuse_wallet_publication before insert on dashboard_live_publications for each row execute function refuse_wallet_publication()",
      );
      try {
        await expect(saveWallet(one.merchantId)).rejects.toThrow();
        expect((await store.merchantById(one.merchantId))?.payoutWallet.address).toBeNull();
        const split = payoutSplitFor(
          payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:8453"),
          one.merchantId,
          wallet,
        );
        expect(await store.payoutSplitAt(split.address)).toBeNull();
      } finally {
        await pool.query("drop trigger refuse_wallet_publication on dashboard_live_publications");
        await pool.query("drop function refuse_wallet_publication()");
      }
      await saveWallet(one.merchantId);
      expect(await rows("dashboard_live_publications")).toHaveLength(1);
    });
    it("keeps approval and its prior notice when the withdrawal note cannot be retained", async () => {
      const one = await seller({ withWallet: false });
      await approve(one.merchantId);
      await pool.query(
        "create function refuse_withdrawal_mail() returns trigger language plpgsql as $$ begin if NEW.kind='withdrawn' then raise exception 'refused'; end if; return NEW; end $$",
      );
      await pool.query(
        "create trigger refuse_withdrawal_mail before insert on dashboard_live_sales_mail for each row execute function refuse_withdrawal_mail()",
      );
      try {
        await expect(
          store.withdrawLiveApproval(one.merchantId, press(one.merchantId, "withdraw")),
        ).rejects.toThrow();
        expect((await store.merchantById(one.merchantId))?.liveApprovedAt).toBe(at + 500);
        expect((await rows("dashboard_live_sales_mail"))[0]?.state).toBe("pending");
        expect(
          (await store.journal({ about: { merchant: one.merchantId }, limit: 20 })).rows.map(
            (row) => row.action,
          ),
        ).toEqual(["admit"]);
      } finally {
        await pool.query("drop trigger refuse_withdrawal_mail on dashboard_live_sales_mail");
        await pool.query("drop function refuse_withdrawal_mail()");
      }
    });
    it("refreshes the check when a saved exchange-rate version changes before automatic publication", async () => {
      const one = await seller();
      await shops.connect({ ...one.connection, currency: { code: "EUR", decimals: 2 } });
      const entry = {
        currency: "EUR",
        rate: "0.9",
        setAt: new Date(at),
        sessionSignedInAt: null,
        reference: null,
        confirmed: false,
      };
      const original = await shops.saveRate(one.accountId, one.connection.shopUrl, entry);
      const checking = await shops.jobs.claim();
      if (!checking) throw new Error("rate check missing");
      await shops.jobs.currency(checking.id, { code: "EUR", decimals: 2 });
      await shops.jobs.rate(checking.id, original);
      await shops.jobs.finish(checking.id, { status: "completed", stopCode: null, why: null });
      await approve(one.merchantId);
      await shops.saveRate(one.accountId, one.connection.shopUrl, {
        ...entry,
        rate: "0.95",
        setAt: new Date(at + 1000),
      });
      await advanceLivePublication(pool, shops);
      expect((await shops.jobs.latest(one.merchantId))[0]).toMatchObject({
        kind: "check",
        status: "queued",
      });
      expect((await shops.jobs.latest(one.merchantId)).some((job) => job.kind === "publish")).toBe(
        false,
      );
      expect(await rows("dashboard_live_sales_mail")).toEqual([]);
    });
    it("does not start publication for SDK merchants and gives manual approval an honest next action", async () => {
      const one = await seller({
        integration: "api",
        name: false,
        connected: false,
        withWallet: false,
      });
      await approve(one.merchantId);
      expect((await store.merchantById(one.merchantId))?.liveApprovedAt).not.toBeNull();
      expect(await rows("dashboard_live_publications")).toEqual([]);
      expect((await rows("dashboard_live_sales_mail"))[0]?.event.next).toBe("settings");
      await saveWallet(one.merchantId);
      expect(await rows("dashboard_live_publications")).toEqual([]);
    });
    it.each([
      { integration: "api", withWallet: false, key: false, next: "wallet" },
      { integration: "api", withWallet: true, key: false, next: "connect" },
      { integration: "api", withWallet: true, key: true, next: "code" },
      { integration: "woocommerce", withWallet: true, key: false, next: "settings" },
    ] as const)(
      "sends a named $integration merchant without a site to the step the dashboard shows (wallet $withWallet, key $key)",
      async ({ integration, withWallet, key, next }) => {
        const one = await seller({ integration, site: false, connected: false, withWallet });
        if (key)
          await store.addKey(
            {
              id: `key_${randomUUID()}`,
              merchantId: one.merchantId,
              label: "Server",
              digest: randomUUID(),
            },
            at,
          );
        await approve(one.merchantId);
        expect((await rows("dashboard_live_sales_mail")).map((row) => row.event.next)).toEqual([
          next,
        ]);
        await dispatch();
        expect(sent[0]?.body.includes("/dashboard/settings")).toBe(next === "settings");
        if (next === "code")
          expect(sent[0]?.body).toContain("/docs/quickstart#_4-publish-one-card");
      },
    );
    it("requests a fresh check after a connection changes instead of publishing the stale basis", async () => {
      const one = await seller();
      const checking = await check(one);
      await finishCheck(checking.id);
      await shops.connect({ ...one.connection, revision: "new-grant" });
      await approve(one.merchantId);
      await advanceLivePublication(pool, shops);
      const latest = await shops.jobs.latest(one.merchantId);
      expect(latest[0]).toMatchObject({
        kind: "check",
        status: "queued",
        connectionRevision: "new-grant",
      });
      expect(latest.some((j) => j.kind === "publish")).toBe(false);
      const automatic = await shops.jobs.claim();
      if (!automatic || automatic.kind !== "check") throw new Error("automatic check missing");
      await finishCheck(automatic.id);
      expect(
        (
          await pool.query(
            "select actor_type,source,refs from commerce_analytics_events where refs->>'merchant'=$1 and properties->>'step'='woo_check' order by sequence",
            [one.merchantId],
          )
        ).rows,
      ).toEqual(
        Array.from({ length: 2 }, () => ({
          actor_type: "system",
          source: "woocommerce",
          refs: { merchant: one.merchantId, person: one.accountId },
        })),
      );
    });
    it("keeps the withdrawal note whole and suppresses an earlier approval after the decision changed", async () => {
      const one = await seller({ withWallet: false });
      await approve(one.merchantId);
      await store.withdrawLiveApproval(one.merchantId, press(one.merchantId, "withdraw"));
      await dispatch();
      await dispatch();
      expect(sent).toHaveLength(1);
      expect(sent[0]?.subject).toBe("Agentify stopped your live sales");
      expect(sent[0]?.body).toContain("Correct the seller name.\nKeep the full explanation.");
      expect(
        (await rows("dashboard_live_sales_mail")).find((r) => r.kind === "admitted")?.suppression,
      ).toBe("decision_changed");
    });
    it.each(["pending", "unknown", "accepted"] as const)(
      "never replays a superseded withdrawal after another withdrawal (%s handover)",
      async (handover) => {
        const one = await seller({ withWallet: false });
        await approve(one.merchantId);
        await store.withdrawLiveApproval(one.merchantId, {
          ...press(one.merchantId, "withdraw"),
          reason: "Correct the old seller name.",
        });
        if (handover !== "pending")
          await deliverLiveSalesMail({
            pool,
            config,
            now: () => new Date("2030-01-01Z"),
            postman: async () => handover,
          });
        const old = (await rows("dashboard_live_sales_mail")).find(
          (row) => row.kind === "withdrawn",
        );
        expect(old).toMatchObject({
          state: handover === "accepted" ? "accepted" : "pending",
          attempts: handover === "pending" ? 0 : 1,
          last_outcome: handover === "pending" ? null : handover,
        });
        await approve(one.merchantId);
        expect(
          (await rows("dashboard_live_sales_mail")).find((row) => row.id === old.id)?.state,
        ).toBe(handover === "accepted" ? "accepted" : "suppressed");
        await store.withdrawLiveApproval(one.merchantId, {
          ...press(one.merchantId, "withdraw"),
          reason: "Correct the current seller site.",
        });
        await dispatch();
        await dispatch();
        expect(sent).toHaveLength(1);
        expect(sent[0]?.body).toContain("Correct the current seller site.");
        expect(sent[0]?.body).not.toContain("Correct the old seller name.");
        const retained = (await rows("dashboard_live_sales_mail")).find((row) => row.id === old.id);
        expect(retained).toMatchObject({
          state: handover === "accepted" ? "accepted" : "suppressed",
          suppression: handover === "accepted" ? null : "decision_changed",
          message: old.message,
          event: old.event,
          attempts: old.attempts,
          last_outcome: old.last_outcome,
          last_attempt_at: old.last_attempt_at,
        });
      },
    );
    it("erases a pending automatic publication with its owning account", async () => {
      const one = await seller();
      await approve(one.merchantId);
      expect(await rows("dashboard_live_publications")).toHaveLength(1);
      await pool.query("delete from dashboard_accounts where id=$1", [one.accountId]);
      expect(await rows("dashboard_live_publications")).toEqual([]);
      await advanceLivePublication(pool, shops);
      expect(await shops.jobs.latest(one.merchantId)).toEqual([]);
    });
    it("cancels an old publication intent before reapproval even when its timestamp is reused", async () => {
      const one = await seller();
      await approve(one.merchantId);
      const first = (await rows("dashboard_live_publications"))[0]?.id;
      await store.withdrawLiveApproval(one.merchantId, press(one.merchantId, "withdraw"));
      await approve(one.merchantId);
      await advanceLivePublication(pool, shops);
      const intents = await rows("dashboard_live_publications");
      expect(intents.find((row) => row.id === first)?.state).toBe("completed");
      expect(intents.filter((row) => row.state === "pending")).toHaveLength(1);
      expect((await shops.jobs.latest(one.merchantId))[0]).toMatchObject({
        kind: "check",
        status: "queued",
      });
    });
  });
}

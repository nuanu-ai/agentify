/**
 * The catalog's and the setup's analytics against PostgreSQL, for what only a
 * database can show: whether a card is new is decided by the very statement
 * that writes it, so two first publications racing record one; the event
 * commits and rolls back with its fact; and an outbox that cannot take an
 * event never costs the merchant the write it describes.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Card } from "@nuanu-ai/agentify-contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AnalyticsEvent } from "../../analytics/events.js";
import { Gateway } from "../../app/gateway.js";
import { grantLiveApproval, setPayoutWallet, setServiceName } from "../../app/merchants.js";
import type { Runtime } from "../../app/runtime.js";
import { widestChallengeOn } from "../../http/x402.js";
import { nobodyAnnounces } from "../../ports/announcer.js";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "../../testing/database.js";
import { countedIds, loggedWhile, testConfig } from "../../testing/harness.js";
import { ScriptedFacilitator } from "../memory/facilitator.js";
import { MemoryQueue } from "../memory/queue.js";
import { connect, PostgresStore } from "./store.js";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_catalog_analytics";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);
const migrationsIn = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "drizzle",
);

const A = "mch_catalog_analytics";
const SIGNED_IN = { kind: "signed_in", email: "owner@example.com" } as const;
const A_WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

const cardFor = (merchantItemId: string, title = "A room for the night"): Card => ({
  merchant_item_id: merchantItemId,
  title,
  description: `${title}, as its merchant describes it`,
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
});

const paused: AnalyticsEvent = {
  name: "agc_selling_changed",
  actor: "human",
  source: "dashboard",
  refs: { merchant: A },
  fields: { entity: "merchant", change: "paused" },
};

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));
  describe("the catalog's analytics on a real database", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const migrating = new Pool({ connectionString: databaseUrl });
  await migrating.query("drop schema public cascade");
  await migrating.query("create schema public");
  await migrating.query("drop schema if exists drizzle cascade");
  await migrate(drizzle(migrating), { migrationsFolder: migrationsIn });
  await migrating.end();

  // More connections than the races below run at once, so the database's
  // locks decide them rather than a wait for a connection.
  const { db, pool } = connect(databaseUrl, { max: 8 });
  const store = PostgresStore.over(db, "eip155:84532", countedIds());
  const config = testConfig({
    PAYMENT_NETWORK: "eip155:84532",
    FACILITATOR_URL: "https://x402.org/facilitator",
  });
  let now = Date.parse("2026-10-21T12:00:00.000Z");
  const runtime: Runtime = {
    config,
    store,
    queue: new MemoryQueue({
      attempts: config.reminderAttempts,
      retryDelayMs: config.reminderRetryDelayMs,
    }),
    facilitator: new ScriptedFacilitator(),
    clock: () => now,
    ids: countedIds(),
    announcer: nobodyAnnounces,
    widestChallenge: widestChallengeOn(config),
  };
  const gateway = new Gateway(runtime);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("drop trigger if exists refuse_at_commit on cards");
    await pool.query(
      "truncate table cards, orders, receipts, payment_claims, merchant_keys, merchants," +
        " payout_splits, commerce_analytics_events",
    );
    now += 60_000;
    await store.addMerchant({ id: A, name: "The merchant of this suite" }, now);
    await setServiceName(store, A, "The merchant of this suite", now);
    await setPayoutWallet(store, config.payoutSplit, A, A_WALLET, now);
  });

  const recorded = async () =>
    (
      await pool.query<{ name: string; refs: Record<string, string>; properties: object }>(
        "select name, refs, properties from commerce_analytics_events order by sequence",
      )
    ).rows;

  describe("the catalog's analytics on a real database", () => {
    it("records a completed publication for a new card and none for its republication", async () => {
      const first = await gateway.publishCard(A, cardFor("room-101"));
      const again = await gateway.publishCard(A, cardFor("room-101", "A room, dearer"));

      expect(first.ok && again.ok && first.id === again.id).toBe(true);
      expect(await recorded()).toStrictEqual([
        {
          name: "agc_card_publish_result",
          refs: { merchant: A, item: first.ok ? first.id : "" },
          properties: { integration: "api", outcome: "completed" },
        },
      ]);
    });

    it("records exactly one completed publication when first publications of one card race", async () => {
      const raced = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          gateway.publishCard(A, cardFor("room-202", `A room, version ${index}`)),
        ),
      );

      const ids = new Set(raced.map((one) => (one.ok ? one.id : "refused")));
      expect([...ids]).toHaveLength(1);
      expect(await recorded()).toStrictEqual([
        {
          name: "agc_card_publish_result",
          refs: { merchant: A, item: [...ids][0] },
          properties: { integration: "api", outcome: "completed" },
        },
      ]);
    });

    it("leaves no event of a publication that rolled back, together with its card", async () => {
      await pool.query(`
        create or replace function refuse_at_commit() returns trigger language plpgsql as $$
        begin
          raise exception 'refused at commit';
        end $$`);
      await pool.query(`
        create constraint trigger refuse_at_commit after insert on cards
          deferrable initially deferred for each row execute function refuse_at_commit()`);
      const made: AnalyticsEvent = {
        name: "agc_card_publish_result",
        actor: "merchant_worker",
        source: "gateway",
        refs: { merchant: A, item: "item_doomed" },
        fields: { integration: "api", outcome: "completed" },
      };

      await expect(store.publishCard(A, cardFor("room-303"), now, "api", made)).rejects.toThrow();

      expect(await store.cards(A)).toStrictEqual([]);
      expect(await recorded()).toStrictEqual([]);
    });

    it("publishes the card when the outbox cannot take its event, and says so in the log", async () => {
      await pool.query(
        "alter table commerce_analytics_events rename to commerce_analytics_events_away",
      );
      try {
        let published: Awaited<ReturnType<Gateway["publishCard"]>> | undefined;
        const said = await loggedWhile(async () => {
          published = await gateway.publishCard(A, cardFor("room-404"));
        });

        expect(published?.ok).toBe(true);
        expect(await store.cards(A)).toHaveLength(1);
        expect(said).toMatch(/analytics event could not be recorded/);
      } finally {
        await pool.query(
          "alter table commerce_analytics_events_away rename to commerce_analytics_events",
        );
      }
    });

    it("records a pause, a stop, a name and a site only when the stored value changes", async () => {
      const published = await gateway.publishCard(A, cardFor("room-505"));
      const item = published.ok ? published.id : "";
      await pool.query("delete from commerce_analytics_events");

      for (let twice = 0; twice < 2; twice += 1) {
        await gateway.setCardPaused(A, item, true, SIGNED_IN);
        await gateway.setSelling(A, "paused", SIGNED_IN);
        await gateway.setSellerName(
          A,
          { seller_name: "A name of its own", seller_site: "https://shop.example.com" },
          SIGNED_IN,
        );
        await gateway.setPayoutWallet(A, A_WALLET.toLowerCase(), SIGNED_IN);
      }

      expect((await recorded()).map(({ name, properties }) => [name, properties])).toStrictEqual([
        ["agc_selling_changed", { entity: "card", change: "paused" }],
        ["agc_selling_changed", { entity: "merchant", change: "paused" }],
        ["agc_setup_result", { step: "seller_name", integration: "none", outcome: "completed" }],
        ["agc_setup_result", { step: "seller_site", integration: "none", outcome: "completed" }],
      ]);
    });

    it("records one change when the same pause and the same stop race", async () => {
      const published = await gateway.publishCard(A, cardFor("room-606"));
      const item = published.ok ? published.id : "";
      await pool.query("delete from commerce_analytics_events");

      await Promise.all(
        Array.from({ length: 3 }, () => [
          store.setCardPaused(A, item, true, (card) => ({
            name: "agc_selling_changed",
            actor: "human",
            source: "dashboard",
            refs: { merchant: A, item: card.id },
            fields: { entity: "card", change: "paused" },
          })),
          store.setSelling(A, "paused", paused),
        ]).flat(),
      );

      expect((await recorded()).map(({ properties }) => properties)).toStrictEqual(
        expect.arrayContaining([
          { entity: "card", change: "paused" },
          { entity: "merchant", change: "paused" },
        ]),
      );
      expect(await recorded()).toHaveLength(2);
    });

    it("records a key issued, a wallet saved, and the operator's first grant only", async () => {
      await gateway.issueMerchantKey(A, "the warehouse worker", SIGNED_IN);
      await pool.query("update merchants set payout_wallet = null where id = $1", [A]);
      await gateway.setPayoutWallet(A, A_WALLET, SIGNED_IN);
      await grantLiveApproval(store, A, now);
      await grantLiveApproval(store, A, now + 1_000);

      expect((await recorded()).map(({ properties }) => properties)).toStrictEqual([
        { step: "api_key", integration: "api", outcome: "completed" },
        { step: "payout_wallet", integration: "none", outcome: "completed" },
        { step: "live_approval", integration: "none", outcome: "completed" },
      ]);
    });
  });
}

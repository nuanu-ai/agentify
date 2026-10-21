/**
 * Sending recorded analytics events to Nuanu Analytics, against PostgreSQL,
 * because what holds the outbox together is the database's: a row taken by
 * one sender only, and an account's choice to opt out read where the row is
 * taken. Nuanu is a function standing in for `fetch`, the clock is the test's,
 * and nothing leaves this machine.
 */

import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  type AnalyticsEvent,
  type AuthResult,
  type CardPublishResult,
  type DashboardViewed,
  type MerchantCreated,
  type OrderCreated,
  type OrderOutcomeChanged,
  type PaymentResult,
  record,
  type SellingChanged,
  type SetupResult,
  type UiBlocked,
} from "@agentify/gateway/analytics";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { migrateAccounts } from "./database.js";
import { deliverOnce, startNuanuAnalytics } from "./nuanu-analytics.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_dashboard_nuanu_analytics";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);
const here = dirname(fileURLToPath(import.meta.url));
const migrationsIn = join(here, "..", "drizzle");
const gatewayMigrationsIn = join(here, "..", "..", "gateway", "drizzle");

const SITE_ID = "123";
const API_KEY = ["qa", "synthetic", "nuanu", "api", "key"].join("-");
const INGEST_TOKEN = ["qa", "synthetic", "ingest", "token"].join("-");
const REFERENCE_KEY = ["qa", "synthetic", "reference", "key", "0123456789abcdef"].join("-");
const OTHER_REFERENCE_KEY = ["qa", "other", "reference", "key", "0123456789abcdef"].join("-");

/** Every raw identifier these tests record carries `_raw_`, so none can leave unnoticed. */
const RAW = {
  merchant: "mer_raw_7f3a",
  person: "acc_raw_51c2",
  item: "card_raw_9d10",
  order: "ord_raw_44be",
  attempt: "pay_raw_08aa",
  operation: "op_raw_c3d4",
} as const;

const START = new Date("2026-10-21T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const REQUIRED = {
  DATABASE_URL: "postgres://agentify:agentify@postgres:5432/agentify",
  AUTH_SECRET: TEST_AUTH_SECRET,
  PAYMENT_NETWORK: "eip155:84532",
};
const SWITCHED_ON = {
  NUANU_ANALYTICS_ENABLED: "true",
  NUANU_ANALYTICS_SITE_ID: SITE_ID,
  NUANU_ANALYTICS_API_KEY: API_KEY,
  NUANU_ANALYTICS_REF_KEY: REFERENCE_KEY,
};
const targetOf = (environment: Record<string, string>) => {
  const target = loadConfig({ ...REQUIRED, ...SWITCHED_ON, ...environment }).nuanuAnalytics;
  if (target === null) throw new Error("the configuration sends nothing");
  return target;
};
const ON_TEST = targetOf({
  FACILITATOR_URL: "https://x402.org/facilitator",
  NUANU_ANALYTICS_INGEST_TOKEN: INGEST_TOKEN,
});
const ON_LIVE = targetOf({
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
});

/** What a reference of this kind to this identifier is sent as, as the analytics team joins on it. */
const referenceOf = (kind: keyof typeof RAW, key = REFERENCE_KEY): string =>
  createHmac("sha256", key).update(`${kind}:${RAW[kind]}`).digest("hex").slice(0, 32);

/** What Nuanu was asked, as it would read it. */
interface Received {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: [string, string][];
  readonly body: string;
  readonly redirect: RequestRedirect | undefined;
  readonly at: number;
}

type Answer = number | "timeout" | "network error" | "silence";

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));
  describe("sending analytics events to Nuanu Analytics", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query("drop schema if exists drizzle cascade");
  await migrate(drizzle(pool), { migrationsFolder: gatewayMigrationsIn });
  await migrateAccounts(pool, migrationsIn);
  const db = drizzle(pool);

  afterAll(async () => {
    await pool.end();
  });

  let clock = START.getTime();
  const now = (): Date => new Date(clock);
  let told: string[] = [];

  beforeEach(async () => {
    clock = START.getTime();
    told = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...said: unknown[]) => {
        told.push(said.map(String).join(" "));
      });
    }
    await pool.query("delete from commerce_analytics_events");
    await pool.query("delete from dashboard_accounts");
  });

  afterEach(() => {
    for (const line of told) {
      expect(line).not.toMatch(/_raw_/);
      expect(line).not.toContain(API_KEY);
      expect(line).not.toContain(INGEST_TOKEN);
      expect(line).not.toContain(REFERENCE_KEY);
    }
    vi.restoreAllMocks();
  });

  /** A Nuanu that gives the answers in turn, then 200 to everything after. */
  const nuanu = (...answers: Answer[]) => {
    const received: Received[] = [];
    const post = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      received.push({
        url: String(input),
        method: init?.method,
        headers: [...new Headers(init?.headers)],
        body: String(init?.body),
        redirect: init?.redirect,
        at: clock,
      });
      const answer = answers.shift() ?? 200;
      if (answer === "timeout") {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      if (answer === "network error") {
        throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
      }
      if (answer === "silence") {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }
      return new Response(null, { status: answer });
    };
    return { post: post as typeof fetch, received };
  };

  const recorded = async (event: AnalyticsEvent, at = now()): Promise<void> => {
    await db.transaction(async (tx) => {
      await record(tx, event, at);
    });
  };

  interface Row {
    readonly id: string;
    readonly sequence: string;
    readonly name: string;
    readonly state: string;
    readonly attempts: number;
    readonly next_attempt_at: Date | null;
    readonly last_outcome: string | null;
    readonly sent_at: Date | null;
    readonly settled_at: Date | null;
  }

  const rows = async (): Promise<Row[]> =>
    (
      await pool.query<Row>(
        `select id, sequence::text as sequence, name, state, attempts, next_attempt_at,
                last_outcome, sent_at, settled_at
           from commerce_analytics_events order by commerce_analytics_events.sequence`,
      )
    ).rows;

  const onlyRow = async (): Promise<Row> => {
    const all = await rows();
    expect(all).toHaveLength(1);
    const [row] = all;
    if (row === undefined) throw new Error("there is no event");
    return row;
  };

  const drained = async (target = ON_TEST, post: typeof fetch = nuanu().post): Promise<void> => {
    for (let turn = 0; turn < 50; turn += 1) {
      if ((await deliverOnce({ pool, target, fetch: post, now })) === "idle") return;
    }
    throw new Error("the outbox never ran dry");
  };

  const optedOut = async (id: string, merchantId: string | null): Promise<void> => {
    await pool.query(
      `insert into dashboard_accounts
         (id, email, email_verified, name, created_at, updated_at, merchant_id, analytics_opt_out)
       values ($1, $2, true, '', $3, $3, $4, true)`,
      [id, `${id}@example.com`, START, merchantId],
    );
  };

  const viewed: DashboardViewed = {
    name: "agc_dashboard_viewed",
    actor: "human",
    source: "dashboard",
    refs: { merchant: RAW.merchant, person: RAW.person },
    fields: { screen: "cards" },
  };
  const ordered: OrderCreated = {
    name: "agc_order_created",
    actor: "buyer_agent",
    source: "gateway",
    refs: { merchant: RAW.merchant, order: RAW.order, item: RAW.item },
    fields: { integration: "api", money_mode: "test", network: "base_sepolia" },
  };

  describe("what goes on the wire for each of the ten events", () => {
    const created: MerchantCreated = {
      name: "agc_merchant_created",
      actor: "human",
      source: "dashboard",
      refs: { merchant: RAW.merchant, person: RAW.person },
    };
    const walletSaved: SetupResult = {
      name: "agc_setup_result",
      actor: "human",
      source: "dashboard",
      refs: { merchant: RAW.merchant, person: RAW.person },
      fields: { step: "payout_wallet", outcome: "completed", integration: "none" },
    };
    const approved: SetupResult = {
      name: "agc_setup_result",
      actor: "operator",
      source: "dashboard",
      refs: { merchant: RAW.merchant, person: RAW.person },
      fields: { step: "live_approval", outcome: "completed", integration: "api" },
    };
    const refused: CardPublishResult = {
      name: "agc_card_publish_result",
      actor: "human",
      source: "gateway",
      refs: { merchant: RAW.merchant, person: RAW.person },
      fields: { integration: "api", outcome: "blocked", reason_code: "wallet_missing" },
    };
    const unresolved: PaymentResult = {
      name: "agc_payment_result",
      actor: "buyer_agent",
      source: "gateway",
      refs: { merchant: RAW.merchant, order: RAW.order, attempt: RAW.attempt },
      fields: {
        payment_state: "unresolved",
        money_mode: "test",
        network: "base_sepolia",
        reason_code: "timeout",
      },
    };
    const paid: PaymentResult = {
      name: "agc_payment_result",
      actor: "buyer_agent",
      source: "gateway",
      refs: { merchant: RAW.merchant, order: RAW.order, attempt: RAW.attempt },
      fields: {
        payment_state: "paid",
        money_mode: "test",
        network: "base_sepolia",
        amount: "1.00",
        currency: "USDC",
      },
    };
    const signedUp: AuthResult = {
      name: "agc_auth_result",
      actor: "human",
      source: "dashboard",
      refs: { person: RAW.person },
      fields: {
        method: "email_link",
        stage: "verify",
        outcome: "confirmed",
        first_verification: true,
      },
    };
    const paused: SellingChanged = {
      name: "agc_selling_changed",
      actor: "human",
      source: "gateway",
      refs: { merchant: RAW.merchant, person: RAW.person, item: RAW.item },
      fields: { entity: "card", change: "paused" },
    };
    const blocked: UiBlocked = {
      name: "agc_ui_blocked",
      actor: "human",
      source: "dashboard",
      refs: { person: RAW.person, operation: RAW.operation },
      fields: {
        screen: "merchant",
        operation: "create_merchant",
        outcome: "failed",
        reason_code: "dependency_unavailable",
      },
    };
    const changed: OrderOutcomeChanged = {
      name: "agc_order_outcome_changed",
      actor: "system",
      source: "gateway",
      refs: { merchant: RAW.merchant, order: RAW.order },
      fields: { outcome: "in_progress", payment_state: "unresolved", money_mode: "test" },
    };

    const common = {
      contract_version: "commerce-v1",
      env: "test",
    };
    const person = referenceOf("person");
    const merchant_ref = referenceOf("merchant");
    const order_ref = referenceOf("order");

    /** Each event, and its body as Nuanu reads it, less the id and time the row fixed. */
    const expected: readonly [AnalyticsEvent, Record<string, unknown>, Record<string, unknown>][] =
      [
        [created, { actor_type: "human", source: "dashboard", merchant_ref }, { user_id: person }],
        [
          walletSaved,
          {
            actor_type: "human",
            source: "dashboard",
            merchant_ref,
            step: "payout_wallet",
            outcome: "completed",
            integration: "none",
          },
          { user_id: person },
        ],
        [
          refused,
          {
            actor_type: "human",
            source: "gateway",
            merchant_ref,
            integration: "api",
            outcome: "blocked",
            reason_code: "wallet_missing",
          },
          { user_id: person },
        ],
        [
          unresolved,
          {
            actor_type: "buyer_agent",
            source: "gateway",
            merchant_ref,
            order_ref,
            attempt_ref: referenceOf("attempt"),
            payment_state: "unresolved",
            money_mode: "test",
            network: "base_sepolia",
            reason_code: "timeout",
          },
          {},
        ],
        [
          paid,
          {
            actor_type: "buyer_agent",
            source: "gateway",
            merchant_ref,
            order_ref,
            attempt_ref: referenceOf("attempt"),
            payment_state: "paid",
            money_mode: "test",
            network: "base_sepolia",
            amount: "1.00",
            currency: "USDC",
          },
          {},
        ],
        [
          viewed,
          { actor_type: "human", source: "dashboard", merchant_ref, screen: "cards" },
          { user_id: person },
        ],
        [
          signedUp,
          {
            actor_type: "human",
            source: "dashboard",
            method: "email_link",
            stage: "verify",
            outcome: "confirmed",
            first_verification: true,
          },
          { user_id: person },
        ],
        [
          paused,
          {
            actor_type: "human",
            source: "gateway",
            merchant_ref,
            entity: "card",
            change: "paused",
            item_ref: referenceOf("item"),
          },
          { user_id: person },
        ],
        [
          blocked,
          {
            actor_type: "human",
            source: "dashboard",
            screen: "merchant",
            operation: "create_merchant",
            outcome: "failed",
            reason_code: "dependency_unavailable",
            operation_ref: referenceOf("operation"),
          },
          { user_id: person },
        ],
        [
          ordered,
          {
            actor_type: "buyer_agent",
            source: "gateway",
            merchant_ref,
            order_ref,
            item_ref: referenceOf("item"),
            integration: "api",
            money_mode: "test",
            network: "base_sepolia",
          },
          {},
        ],
        [
          changed,
          {
            actor_type: "system",
            source: "gateway",
            merchant_ref,
            order_ref,
            outcome: "in_progress",
            payment_state: "unresolved",
            money_mode: "test",
          },
          {},
        ],
        [
          approved,
          {
            actor_type: "operator",
            source: "dashboard",
            merchant_ref,
            step: "live_approval",
            outcome: "completed",
            integration: "api",
          },
          {},
        ],
      ];

    it("posts each event alone, exactly in the contract's shape, and no raw identifier anywhere", async () => {
      for (const [event] of expected) await recorded(event);
      const stored = await rows();
      const { post, received } = nuanu();

      await drained(ON_TEST, post);

      expect(received).toHaveLength(expected.length);
      expect(new Set(expected.map(([event]) => event.name)).size).toBe(10);
      for (const [index, [event, properties, top]] of expected.entries()) {
        const request = received[index];
        const row = stored[index];
        if (request === undefined || row === undefined) throw new Error("a post is missing");
        const revised =
          event.name === "agc_payment_result" || event.name === "agc_order_outcome_changed";
        const body = JSON.parse(request.body) as Record<string, unknown>;
        expect(
          { ...body, properties: JSON.parse(String(body.properties)) },
          event.name,
        ).toStrictEqual({
          type: "custom_event",
          site_id: SITE_ID,
          event_name: event.name,
          event_id: row.id,
          timestamp: START.toISOString(),
          hostname: "test.agentify.ad",
          tag: "internal",
          ...top,
          properties: {
            ...common,
            ...properties,
            ...(revised ? { revision: Number(row.sequence) } : {}),
          },
        });
        // The properties travel as a string, as Nuanu's own script sends them.
        expect(typeof body.properties).toBe("string");
        for (const part of [request.url, request.body, ...request.headers.flat()]) {
          expect(part, event.name).not.toMatch(/_raw_/);
        }
      }
      // A later result of the same payment is a later revision.
      const revisions = received
        .map((request) => JSON.parse(String(JSON.parse(request.body).properties)))
        .filter((properties) => properties.attempt_ref !== undefined)
        .map((properties) => properties.revision as number);
      expect(revisions).toHaveLength(2);
      expect(revisions[1]).toBeGreaterThan(revisions[0] ?? Number.POSITIVE_INFINITY);
    });

    it("posts to the test channel's site with its ingest token, by POST, following no redirect", async () => {
      await recorded(viewed);
      const { post, received } = nuanu();

      await drained(ON_TEST, post);

      const [request] = received;
      expect(request?.url).toBe("https://analytics.nuanu.ai/api/track");
      expect(request?.method).toBe("POST");
      expect(request?.redirect).toBe("manual");
      expect(request?.headers.sort()).toStrictEqual([
        ["authorization", `Bearer ${API_KEY}`],
        ["content-type", "application/json"],
        ["x-nuanu-ingest-token", INGEST_TOKEN],
      ]);
    });

    it("names the live site's host and environment, with no internal tag and no token it was not given", async () => {
      await recorded(viewed);
      const { post, received } = nuanu();

      await drained(ON_LIVE, post);

      const [request] = received;
      expect(request?.headers.sort()).toStrictEqual([
        ["authorization", `Bearer ${API_KEY}`],
        ["content-type", "application/json"],
      ]);
      const body = JSON.parse(request?.body ?? "{}");
      expect(body.hostname).toBe("agentify.ad");
      expect(body).not.toHaveProperty("tag");
      expect(JSON.parse(body.properties).env).toBe("prod");
    });

    it("sends one identifier as one reference under one key, and as another under another key", async () => {
      await recorded(viewed);
      await recorded(ordered);
      const first = nuanu();
      await drained(ON_TEST, first.post);
      const references = first.received.map(
        (request) => JSON.parse(JSON.parse(request.body).properties).merchant_ref,
      );
      expect(references[0]).toMatch(/^[0-9a-f]{32}$/);
      expect(references[1]).toBe(references[0]);

      await recorded(viewed);
      const other = nuanu();
      await drained({ ...ON_TEST, referenceKey: OTHER_REFERENCE_KEY }, other.post);
      const [request] = other.received;
      const body = JSON.parse(request?.body ?? "{}");
      expect(JSON.parse(body.properties).merchant_ref).toBe(
        referenceOf("merchant", OTHER_REFERENCE_KEY),
      );
      expect(JSON.parse(body.properties).merchant_ref).not.toBe(references[0]);
      expect(body.user_id).not.toBe(referenceOf("person"));
    });
  });

  describe("what each answer from Nuanu does to an event", () => {
    it("marks an event Nuanu took as sent, and never posts it again", async () => {
      await recorded(viewed);
      const { post, received } = nuanu(200);

      await deliverOnce({ pool, target: ON_TEST, fetch: post, now });
      clock += DAY;
      expect(await deliverOnce({ pool, target: ON_TEST, fetch: post, now })).toBe("idle");

      expect(received).toHaveLength(1);
      expect(await onlyRow()).toMatchObject({
        state: "sent",
        attempts: 1,
        last_outcome: "http_200",
        sent_at: START,
        settled_at: START,
      });
    });

    for (const status of [400, 413]) {
      it(`gives up for good an event Nuanu refused with ${status}, recording the status`, async () => {
        await recorded(viewed);
        const { post, received } = nuanu(status);

        await deliverOnce({ pool, target: ON_TEST, fetch: post, now });
        clock += DAY;
        await deliverOnce({ pool, target: ON_TEST, fetch: post, now });

        expect(received).toHaveLength(1);
        expect(await onlyRow()).toMatchObject({
          state: "dead",
          last_outcome: `http_${status}`,
          sent_at: null,
          settled_at: START,
        });
      });
    }

    for (const failure of [429, 500, 503, "timeout", "network error"] as const) {
      it(`tries again after ${failure} later, with the same event id and time`, async () => {
        await recorded(viewed);
        const { post, received } = nuanu(failure, 200);

        await deliverOnce({ pool, target: ON_TEST, fetch: post, now });
        const waiting = await onlyRow();
        expect(waiting).toMatchObject({ state: "pending", attempts: 1, settled_at: null });
        expect(waiting.next_attempt_at?.getTime()).toBe(START.getTime() + MINUTE);

        clock = START.getTime() + MINUTE - 1;
        expect(await deliverOnce({ pool, target: ON_TEST, fetch: post, now })).toBe("idle");
        expect(received).toHaveLength(1);

        clock = START.getTime() + MINUTE;
        await deliverOnce({ pool, target: ON_TEST, fetch: post, now });
        expect(received).toHaveLength(2);
        const [first, second] = received.map((request) => JSON.parse(request.body));
        expect(second.event_id).toBe(first.event_id);
        expect(second.timestamp).toBe(START.toISOString());
        expect(second.timestamp).toBe(first.timestamp);
        expect(await onlyRow()).toMatchObject({ state: "sent", attempts: 2 });
      });
    }

    it("waits longer after each failure", async () => {
      await recorded(viewed);
      const { post } = nuanu(503, 503, 503, 503, 503, 503);
      const waits: number[] = [];
      for (let failure = 0; failure < 6; failure += 1) {
        await deliverOnce({ pool, target: ON_TEST, fetch: post, now });
        const row = await onlyRow();
        if (row.next_attempt_at === null) throw new Error("the event is not scheduled");
        waits.push(row.next_attempt_at.getTime() - clock);
        clock = row.next_attempt_at.getTime();
      }
      expect(waits).toStrictEqual([MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR, 6 * HOUR]);
    });

    // A redirect is a configuration problem too: the endpoint named is not the one
    // that takes events, and following it would hand the key to another address.
    for (const status of [401, 403, 404, 301, 308]) {
      it(`keeps the event after ${status}, pauses for minutes and names a configuration problem`, async () => {
        await recorded(viewed);
        const { post, received } = nuanu(status, 200);
        const asked: number[] = [];
        const wait = async (ms: number): Promise<void> => {
          asked.push(ms);
          await sleep(1);
          clock += ms;
        };

        const running = startNuanuAnalytics({ pool, target: ON_TEST, fetch: post, now, wait });
        const deadline = Date.now() + 10_000;
        while (received.length < 2 && Date.now() < deadline) await sleep(5);
        await running.stop();

        expect(received).toHaveLength(2);
        expect(asked[0]).toBeGreaterThanOrEqual(MINUTE);
        expect((received[1]?.at ?? 0) - (received[0]?.at ?? 0)).toBe(asked[0]);
        expect(JSON.parse(received[1]?.body ?? "{}").event_id).toBe(
          JSON.parse(received[0]?.body ?? "{}").event_id,
        );
        expect(await onlyRow()).toMatchObject({ state: "sent" });
        expect(told.join("\n")).toMatch(new RegExp(`http_${status}.*configuration`));
      });
    }

    it("abandons a request Nuanu does not answer after five seconds, and goes on with the next event", async () => {
      await recorded(viewed);
      await recorded(ordered);
      const { post, received } = nuanu("silence", 200);

      const started = performance.now();
      await deliverOnce({ pool, target: ON_TEST, fetch: post, now });
      const waited = performance.now() - started;
      await deliverOnce({ pool, target: ON_TEST, fetch: post, now });

      expect(waited).toBeGreaterThanOrEqual(4_900);
      expect(waited).toBeLessThan(8_000);
      expect(received).toHaveLength(2);
      expect((await rows()).map((row) => [row.name, row.state, row.last_outcome])).toStrictEqual([
        ["agc_dashboard_viewed", "pending", "timeout"],
        ["agc_order_created", "sent", "http_200"],
      ]);
    });

    it("never sends an event that breaks the contract, and records which field broke it", async () => {
      await recorded({
        ...viewed,
        fields: { screen: "nowhere" },
      } as unknown as AnalyticsEvent);
      const { post, received } = nuanu();

      await deliverOnce({ pool, target: ON_TEST, fetch: post, now });

      expect(received).toStrictEqual([]);
      const row = await onlyRow();
      expect(row.state).toBe("dead");
      expect(row.last_outcome).toContain("properties.screen");
    });
  });

  describe("how long an event waits", () => {
    it("gives up unsent an event more than seven days old, which Nuanu would date by its arrival", async () => {
      await recorded(viewed, new Date(clock - 7 * DAY - MINUTE));
      await recorded(ordered, new Date(clock - 7 * DAY + MINUTE));
      const { post, received } = nuanu();

      await drained(ON_TEST, post);

      expect(received.map((request) => JSON.parse(request.body).event_name)).toStrictEqual([
        "agc_order_created",
      ]);
      expect((await rows()).map((row) => [row.name, row.state])).toStrictEqual([
        ["agc_dashboard_viewed", "given_up"],
        ["agc_order_created", "sent"],
      ]);
    });

    it("gives up an event still failing once it is seven days old", async () => {
      await recorded(viewed);
      const { post, received } = nuanu(...new Array<Answer>(100).fill(503));
      while ((await onlyRow()).state === "pending") {
        await deliverOnce({ pool, target: ON_TEST, fetch: post, now });
        const row = await onlyRow();
        clock = row.next_attempt_at?.getTime() ?? clock;
      }
      expect(await onlyRow()).toMatchObject({ state: "given_up" });
      expect(clock - START.getTime()).toBeGreaterThan(7 * DAY);
      expect(received.at(-1)?.at ?? 0).toBeLessThanOrEqual(START.getTime() + 7 * DAY);
    });

    it("deletes an event thirty days after it settled, and not before", async () => {
      await recorded(viewed);
      await drained(ON_TEST);
      expect(await onlyRow()).toMatchObject({ state: "sent" });

      clock = START.getTime() + 30 * DAY - MINUTE;
      await drained(ON_TEST);
      expect(await rows()).toHaveLength(1);

      clock = START.getTime() + 30 * DAY + MINUTE;
      await drained(ON_TEST);
      expect(await rows()).toStrictEqual([]);
    });
  });

  describe("a person who opted out", () => {
    it("is never sent an event as its person, which is marked suppressed", async () => {
      await optedOut(RAW.person, null);
      await recorded(viewed);
      const { post, received } = nuanu();

      await drained(ON_TEST, post);

      expect(received).toStrictEqual([]);
      expect(await onlyRow()).toMatchObject({ state: "suppressed" });
    });

    it("keeps the merchant their account names out of every event, whoever acted", async () => {
      await optedOut("acc_raw_owner", RAW.merchant);
      await recorded(ordered);
      const { post, received } = nuanu();

      await drained(ON_TEST, post);

      expect(received).toStrictEqual([]);
      expect(await onlyRow()).toMatchObject({ state: "suppressed" });
    });

    it("leaves everybody else's events to be sent", async () => {
      await optedOut("acc_raw_somebody_else", "mer_raw_somebody_else");
      await recorded(viewed);
      const { post, received } = nuanu();

      await drained(ON_TEST, post);

      expect(received).toHaveLength(1);
      expect(await onlyRow()).toMatchObject({ state: "sent" });
    });
  });

  describe("switched off", () => {
    it("sends nothing, gives up what is more than seven days old and deletes what settled thirty days ago", async () => {
      await recorded(viewed, new Date(clock - 7 * DAY - MINUTE));
      await recorded(ordered, new Date(clock - DAY));
      await recorded(viewed, new Date(clock - 40 * DAY));
      await pool.query(
        `update commerce_analytics_events
            set state = 'sent', sent_at = $1, settled_at = $1, next_attempt_at = null,
                last_outcome = 'http_200'
          where occurred_at = $1`,
        [new Date(clock - 40 * DAY)],
      );
      const { post, received } = nuanu();
      const wait = async (ms: number): Promise<void> => {
        await sleep(Math.min(ms, 5));
      };

      const running = startNuanuAnalytics({ pool, target: null, fetch: post, now, wait });
      const deadline = Date.now() + 10_000;
      while ((await rows()).length !== 2 && Date.now() < deadline) await sleep(5);
      await running.stop();

      expect(received).toStrictEqual([]);
      expect((await rows()).map((row) => [row.name, row.state])).toStrictEqual([
        ["agc_dashboard_viewed", "given_up"],
        ["agc_order_created", "pending"],
      ]);
    });
  });
}

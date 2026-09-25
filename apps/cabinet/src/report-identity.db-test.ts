import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { identityFor, LINK_MIN_INTERVAL_MS } from "./identity.js";
import type { Message } from "./mail.js";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_cabinet_report_test";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);
const here = dirname(fileURLToPath(import.meta.url));
const migrationsIn = join(here, "..", "drizzle");

const EMAIL = "owner@example.com";
const SCAN = "019b41a0-7c51-7d63-84bd-a5a20faef497";
const REQUEST = "019b41a0-7c51-7d63-84bd-a5a20faef498";
const MERCHANT = { id: "mer_owner", key: "the-owner-gateway-key" };
const OPERATION_ONE = "019b41a0-7c51-7d63-84bd-a5a20faef497";
const OPERATION_TWO = "019b41a0-7c52-7d63-84bd-a5a20faef497";
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
  describe("the scanner's questions on PostgreSQL", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const reportDatabaseUrl = databaseUrl;
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });

  afterAll(async () => {
    await pool.end();
  });
  afterEach(() => vi.useRealTimers());

  async function emptyEverything(): Promise<void> {
    await pool.query("drop function if exists fail_report_request() cascade");
    await pool.query("drop function if exists wait_report_tombstone() cascade");
    await pool.query(`
      drop table if exists
        cabinet_report_deletion_tombstones, cabinet_report_identity_secrets,
        cabinet_report_receipts, cabinet_link_sends, cabinet_woo_quotes,
        cabinet_woo_orders, cabinet_woo_shops, cabinet_woo_grants, cabinet_verifications,
        cabinet_credentials, cabinet_sessions, cabinet_accounts
      cascade
    `);
  }

  /** Every checked-in migration, in order, which is what a deployment applies. */
  async function migrate(): Promise<void> {
    const files = (await readdir(migrationsIn)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      for (const statement of await statementsOf(file)) await pool.query(statement);
    }
  }

  function config(authSecret = "x".repeat(44)) {
    return loadConfig({
      DATABASE_URL: reportDatabaseUrl,
      AUTH_SECRET: authSecret,
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "sandbox:scripted",
      REGISTRATION_INVITATION: "the-existing-gateway-invitation",
      PUBLIC_BASE_URL: "https://agentify.ad",
      BASE_PATH: "/cabinet",
      COOKIE_SECURE: "true",
    });
  }

  function identityOn(messages: Message[], postmanWait?: () => Promise<void>, authSecret?: string) {
    return identityFor(config(authSecret), {
      pool,
      postman: async (message) => {
        messages.push(message);
        await postmanWait?.();
        return "accepted";
      },
    });
  }

  function tokenIn(message: Message): string {
    const raw = message.body.match(/https?:\/\/\S+/)?.[0];
    if (raw === undefined) throw new Error("the message has no link");
    const token = new URL(raw).searchParams.get("token");
    if (token === null) throw new Error("the link has no token");
    return token;
  }

  /** The cookie header a browser holds after the press sets these lines. */
  const cookieFrom = (lines: readonly string[]): string =>
    lines.map((line) => line.split(";")[0] ?? "").join("; ");

  /**
   * A link now, whatever this address asked for a moment ago.
   *
   * The door keeps a minute between two links to one address. These tests are
   * about what happens to a link once it exists, so every send already on
   * record is dated a minute further back before the next one is asked for,
   * which is the minute a person would have waited. It leaves them inside the
   * rolling hour, so the three an hour still count the links that went out.
   */
  async function rewindSends(): Promise<void> {
    await pool.query("update cabinet_link_sends set sent_at = sent_at - $1::interval", [
      "1 minute",
    ]);
  }

  /** A link from the cabinet's sign-in page, on an address already written to. */
  async function cabinetLink(
    identity: ReturnType<typeof identityFor>,
    messages: Message[],
  ): Promise<string> {
    await rewindSends();
    const asked = await identity.requestLink(EMAIL, "default");
    if (asked.status !== "accepted") throw new Error("the cabinet link was not accepted");
    return tokenIn(messages.at(-1) as Message);
  }

  const sendBody = {
    operation: "send" as const,
    email: EMAIL,
    destination: { report: SCAN },
    request: REQUEST,
  };

  async function sendReport(identity: ReturnType<typeof identityFor>, messages: Message[]) {
    await rewindSends();
    const sent = await identity.sendReportLink(sendBody);
    if (sent.status !== "accepted") throw new Error("the report link was not accepted");
    return tokenIn(messages.at(-1) as Message);
  }

  describe("the scanner's questions on PostgreSQL", () => {
    beforeEach(async () => {
      await emptyEverything();
      await migrate();
    });

    it("keeps the same minute between two report links that the cabinet's door keeps", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      await expect(identity.sendReportLink(sendBody)).resolves.toMatchObject({
        status: "accepted",
      });

      const again = await identity.sendReportLink(sendBody);

      expect(again).toMatchObject({ status: "cooldown", retry_at: expect.any(String) });
      expect(messages).toHaveLength(1);
      expect(
        (await pool.query("select count(*)::int as count from cabinet_link_sends")).rows[0],
      ).toStrictEqual({ count: 1 });
      if (again.status !== "cooldown") throw new Error("the second report link should be refused");
      const owed = new Date(again.retry_at).getTime() - Date.now();
      expect(owed).toBeGreaterThan(0);
      expect(owed).toBeLessThanOrEqual(LINK_MIN_INTERVAL_MS);
    });

    it("rolls the report token and rate evidence back when the mail provider refuses", async () => {
      const identity = identityFor(config(), { pool, postman: async () => "refused" });
      await expect(identity.sendReportLink(sendBody)).resolves.toStrictEqual({
        status: "unavailable",
      });
      expect(
        (
          await pool.query(`
            select
              (select count(*)::int from cabinet_verifications) as verifications,
              (select count(*)::int from cabinet_link_sends) as sends,
              (select count(*)::int from cabinet_accounts) as people
          `)
        ).rows[0],
      ).toStrictEqual({ verifications: 0, sends: 0, people: 0 });
    });

    it("writes the request onto the session its link opens, and names it when asked", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const token = await sendReport(identity, messages);

      const opened = await identity.openLink(token);

      if (opened.status !== "opened") throw new Error("the report link did not open");
      expect(opened.destination).toStrictEqual({ report: SCAN });
      expect((await pool.query("select report_request from cabinet_sessions")).rows).toStrictEqual([
        { report_request: REQUEST },
      ]);
      const session = await identity.whoIs(cookieFrom(opened.setCookies), { renew: false });
      expect(session?.request).toBe(REQUEST);
      expect(session?.person.email).toBe(EMAIL);
    });

    it("rolls the whole press back when the request cannot be written onto the session", async () => {
      // A session that opened without the request it was asked for would name
      // nothing, and the request would wait for a visit that cannot finish it.
      // So the token, the person and the session are one act with it.
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const token = await sendReport(identity, messages);
      await pool.query(`
        create function fail_report_request() returns trigger language plpgsql as $$
        begin
          if new.report_request is not null then
            raise exception 'injected request failure';
          end if;
          return new;
        end $$
      `);
      await pool.query(`
        create trigger fail_report_request before update on cabinet_sessions
        for each row execute function fail_report_request()
      `);

      await expect(identity.openLink(token)).rejects.toThrow();
      expect(
        (
          await pool.query(`
            select
              (select count(*)::int from cabinet_accounts) as people,
              (select count(*)::int from cabinet_sessions) as sessions,
              (select count(*)::int from cabinet_verifications) as verifications
          `)
        ).rows[0],
      ).toStrictEqual({ people: 0, sessions: 0, verifications: 1 });

      await pool.query("drop trigger fail_report_request on cabinet_sessions");
      await expect(identity.openLink(token)).resolves.toMatchObject({ status: "opened" });
    });

    it("removes links that ran out more than a week ago, and keeps younger ones", async () => {
      vi.useFakeTimers({ now: NOW });
      const identity = identityOn([]);
      const aWeek = 7 * 24 * 60 * 60 * 1000;
      await pool.query(
        `insert into cabinet_verifications
           (id, identifier, value, expires_at, created_at, updated_at)
         values
           ('younger', 'younger', $1, $2, $4, $4),
           ('older', 'older', $1, $3, $4, $4)`,
        [
          JSON.stringify({ email: EMAIL, destination: "default", request: null }),
          new Date(NOW.getTime() - aWeek + 1),
          new Date(NOW.getTime() - aWeek - 1),
          NOW,
        ],
      );

      await identity.deleteUnattachedPerson({
        operation: "delete",
        operation_id: OPERATION_ONE,
        email: "nobody@example.com",
      });

      expect(
        (await pool.query("select id from cabinet_verifications order by id")).rows,
      ).toStrictEqual([{ id: "younger" }]);
    });

    it("deletes a person without a merchant with their sessions, and keeps one with a merchant", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const p1 = await identity.openLink(await sendReport(identity, messages));
      expect(p1.status).toBe("opened");
      await sendReport(identity, messages);
      await expect(
        identity.deleteUnattachedPerson({
          operation: "delete",
          operation_id: OPERATION_ONE,
          email: EMAIL,
        }),
      ).resolves.toStrictEqual({ status: "deleted" });
      expect(
        (
          await pool.query(`
            select
              (select count(*)::int from cabinet_accounts) as people,
              (select count(*)::int from cabinet_sessions) as sessions,
              (select count(*)::int from cabinet_verifications) as verifications
          `)
        ).rows[0],
      ).toStrictEqual({ people: 0, sessions: 0, verifications: 0 });

      const p2 = await identity.make(EMAIL, MERCHANT);
      if (p2 === null) throw new Error("the P2 account was not made");
      await pool.query(
        `insert into cabinet_woo_shops
           (account_id, shop_url, consumer_key, consumer_secret, permissions, connected_at)
         values ($1, 'https://shop.example', 'ck_preserved', 'cs_preserved', 'read_write', now())`,
        [p2.id],
      );
      await expect(identity.openLink(await cabinetLink(identity, messages))).resolves.toMatchObject(
        { status: "opened" },
      );
      const p2CabinetToken = await cabinetLink(identity, messages);
      const p2ReportToken = await sendReport(identity, messages);
      await expect(
        identity.deleteUnattachedPerson({
          operation: "delete",
          operation_id: OPERATION_TWO,
          email: EMAIL,
        }),
      ).resolves.toStrictEqual({ status: "retained" });
      expect(await identity.byEmail(EMAIL)).toMatchObject({ merchant: MERCHANT });
      expect(
        (
          await pool.query(
            `
            select
              (select count(*)::int from cabinet_sessions where user_id = $1) as sessions,
              (select count(*)::int from cabinet_woo_shops where account_id = $1) as shops
          `,
            [p2.id],
          )
        ).rows[0],
      ).toStrictEqual({ sessions: 1, shops: 1 });
      await expect(identity.openLink(p2CabinetToken)).resolves.toMatchObject({ status: "opened" });
      await expect(identity.openLink(p2ReportToken)).resolves.toStrictEqual({ status: "refused" });
    });

    it("serializes deletion before a concurrent send so the post-delete link survives", async () => {
      const gateClient = await pool.connect();
      await gateClient.query("select pg_advisory_lock(424242)");
      try {
        await pool.query(`
          create function wait_report_tombstone() returns trigger language plpgsql as $$
          begin perform pg_advisory_xact_lock(424242); return new; end $$
        `);
        await pool.query(`
          create trigger wait_report_tombstone before insert on cabinet_report_deletion_tombstones
          for each row execute function wait_report_tombstone()
        `);
        const messages: Message[] = [];
        const identity = identityOn(messages);
        const deleting = identity.deleteUnattachedPerson({
          operation: "delete",
          operation_id: OPERATION_ONE,
          email: EMAIL,
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        const sending = identity.sendReportLink(sendBody);
        await gateClient.query("select pg_advisory_unlock(424242)");
        await expect(deleting).resolves.toStrictEqual({ status: "already_absent" });
        await expect(sending).resolves.toMatchObject({ status: "accepted" });
        await expect(identity.openLink(tokenIn(messages[0] as Message))).resolves.toMatchObject({
          status: "opened",
        });
      } finally {
        await gateClient.query("select pg_advisory_unlock_all()");
        gateClient.release();
      }
    });

    it("spends a report link whose provider handoff committed before a concurrent deletion", async () => {
      let handoffReached!: () => void;
      const atHandoff = new Promise<void>((resolve) => {
        handoffReached = resolve;
      });
      let releaseHandoff!: () => void;
      const holdHandoff = new Promise<void>((resolve) => {
        releaseHandoff = resolve;
      });
      const messages: Message[] = [];
      const identity = identityOn(messages, async () => {
        handoffReached();
        await holdHandoff;
      });
      const sending = identity.sendReportLink(sendBody);
      await atHandoff;
      const deleting = identity.deleteUnattachedPerson({
        operation: "delete",
        operation_id: OPERATION_ONE,
        email: EMAIL,
      });
      releaseHandoff();

      await expect(sending).resolves.toMatchObject({ status: "accepted" });
      await expect(deleting).resolves.toStrictEqual({ status: "already_absent" });
      await expect(identity.openLink(tokenIn(messages[0] as Message))).resolves.toStrictEqual({
        status: "refused",
      });
    });

    it("shares the person lock with merchant attachment so deletion retains the committed P2", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      await identity.openLink(await sendReport(identity, messages));
      const person = await identity.byEmail(EMAIL);
      if (person === null) throw new Error("the report person was not made");

      let registrationReached!: () => void;
      const atRegistration = new Promise<void>((resolve) => {
        registrationReached = resolve;
      });
      let releaseRegistration!: () => void;
      const holdRegistration = new Promise<void>((resolve) => {
        releaseRegistration = resolve;
      });
      const attaching = identity.attachMerchant(person.id, async () => {
        registrationReached();
        await holdRegistration;
        return MERCHANT;
      });
      await atRegistration;
      const deleting = identity.deleteUnattachedPerson({
        operation: "delete",
        operation_id: OPERATION_ONE,
        email: EMAIL,
      });
      releaseRegistration();

      await expect(attaching).resolves.toMatchObject({ status: "attached" });
      await expect(deleting).resolves.toStrictEqual({ status: "retained" });
      expect(await identity.byId(person.id)).toMatchObject({ merchant: MERCHANT });
    });

    it("replays a deleted tombstone after credential rotation without touching a replacement", async () => {
      const messages: Message[] = [];
      const first = identityOn(messages);
      await expect(first.openLink(await sendReport(first, messages))).resolves.toMatchObject({
        status: "opened",
      });
      const request = {
        operation: "delete" as const,
        operation_id: OPERATION_ONE,
        email: EMAIL,
      };
      await expect(first.deleteUnattachedPerson(request)).resolves.toStrictEqual({
        status: "deleted",
      });

      const replacement = await first.make(EMAIL, MERCHANT);
      if (replacement === null) throw new Error("the replacement person was not made");
      const replacementLink = await cabinetLink(first, messages);
      const restarted = identityOn(
        [],
        undefined,
        "a-rotated-session-secret-that-is-at-least-32-characters-long",
      );

      await expect(restarted.deleteUnattachedPerson(request)).resolves.toStrictEqual({
        status: "deleted",
      });
      expect(await restarted.byId(replacement.id)).toMatchObject({ merchant: MERCHANT });
      await expect(restarted.openLink(replacementLink)).resolves.toMatchObject({
        status: "opened",
      });
    });

    it("replays a retained tombstone after credential rotation without touching a new link", async () => {
      const messages: Message[] = [];
      const first = identityOn(messages);
      const person = await first.make(EMAIL, MERCHANT);
      if (person === null) throw new Error("the merchant person was not made");
      const request = {
        operation: "delete" as const,
        operation_id: OPERATION_ONE,
        email: EMAIL,
      };
      await expect(first.deleteUnattachedPerson(request)).resolves.toStrictEqual({
        status: "retained",
      });
      const newLink = await cabinetLink(first, messages);
      const restarted = identityOn(
        [],
        undefined,
        "a-rotated-session-secret-that-is-at-least-32-characters-long",
      );

      await expect(restarted.deleteUnattachedPerson(request)).resolves.toStrictEqual({
        status: "retained",
      });
      expect(await restarted.byId(person.id)).toMatchObject({ merchant: MERCHANT });
      await expect(restarted.openLink(newLink)).resolves.toMatchObject({ status: "opened" });
    });

    it("replays a permanent terminal tombstone without resolving the address again", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const request = { operation: "delete" as const, operation_id: OPERATION_ONE, email: EMAIL };
      await expect(identity.deleteUnattachedPerson(request)).resolves.toStrictEqual({
        status: "already_absent",
      });
      const made = await identity.make(EMAIL, MERCHANT);
      if (made === null) throw new Error("the replacement person was not made");
      const cabinetToken = await cabinetLink(identity, messages);

      await expect(identity.deleteUnattachedPerson(request)).resolves.toStrictEqual({
        status: "already_absent",
      });
      await expect(
        identity.deleteUnattachedPerson({ ...request, email: "other@example.com" }),
      ).resolves.toStrictEqual({ status: "refused" });
      expect(await identity.byId(made.id)).toMatchObject({ merchant: MERCHANT });
      await expect(identity.openLink(cabinetToken)).resolves.toMatchObject({ status: "opened" });
      expect(
        (
          await pool.query(`
            select column_name from information_schema.columns
            where table_name = 'cabinet_report_deletion_tombstones'
            order by column_name
          `)
        ).rows.map((row) => row.column_name),
      ).toStrictEqual(["completed_at", "created_at", "operation_digest", "operation_id", "result"]);
      expect(
        JSON.stringify(await pool.query("select * from cabinet_report_deletion_tombstones")),
      ).not.toContain(EMAIL);
    });
  });
}

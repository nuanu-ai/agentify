import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  noDatabaseHere,
  readyDatabase,
  testDatabaseUrl,
} from "@agentify/commerce-gateway/testing/database";
import { reportIdentityTokenHash } from "@agentify/scanner-contracts/report-identity";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { identityFor } from "./identity.js";
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
const STATE = "s".repeat(43);
const OTHER_STATE = "o".repeat(43);
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
  describe("private report identity on PostgreSQL", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const reportDatabaseUrl = databaseUrl;
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const migrationFiles = [
    "0000_accounts.sql",
    "0001_merchant_on_account.sql",
    "0002_the_old_sign_in_goes.sql",
    "0003_identity_component.sql",
    "0004_woocommerce_connection.sql",
    "0005_one_way_in_identity.sql",
    "0006_report_identity.sql",
  ] as const;

  afterAll(async () => {
    await pool.end();
  });
  afterEach(() => vi.useRealTimers());

  async function run(file: string): Promise<void> {
    for (const statement of await statementsOf(file)) await pool.query(statement);
  }

  async function emptyEverything(): Promise<void> {
    await pool.query("drop function if exists fail_report_receipt() cascade");
    await pool.query("drop function if exists wait_report_tombstone() cascade");
    await pool.query(`
      drop table if exists
        cabinet_report_deletion_tombstones, cabinet_report_identity_secrets,
        cabinet_report_receipts, cabinet_link_sends,
        cabinet_woo_orders, cabinet_woo_shops, cabinet_woo_grants, cabinet_verifications,
        cabinet_credentials, cabinet_sessions, cabinet_accounts
      cascade
    `);
  }

  async function migrate(): Promise<void> {
    for (const migration of migrationFiles) await run(migration);
  }

  function config(
    authSecret = "a-secret-that-is-at-least-32-characters-long",
    reportIdentitySecret?: string,
  ) {
    return loadConfig({
      DATABASE_URL: reportDatabaseUrl,
      AUTH_SECRET: authSecret,
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "sandbox:scripted",
      REGISTRATION_INVITATION: "the-existing-gateway-invitation",
      PUBLIC_BASE_URL: "https://agentify.ad",
      BASE_PATH: "/cabinet",
      REPORT_IDENTITY_SECRET: reportIdentitySecret,
    });
  }

  function identityOn(
    messages: Message[],
    postmanWait?: () => Promise<void>,
    authSecret?: string,
    reportIdentitySecret?: string,
  ) {
    return identityFor(config(authSecret, reportIdentitySecret), {
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
    if (raw === undefined) throw new Error("the message has no identity link");
    const action = new URL(raw);
    const token =
      new URLSearchParams(action.hash.slice(1)).get("token") ?? action.searchParams.get("token");
    if (token === null) throw new Error("the identity link has no token");
    return token;
  }

  async function sendReport(
    identity: ReturnType<typeof identityFor>,
    messages: Message[],
    intentKind: "registration" | "recovery" = "registration",
  ) {
    const sent = await identity.sendReportLink({
      operation: "send",
      email: EMAIL,
      intent_kind: intentKind,
      state: STATE,
    });
    if (sent.status !== "accepted") throw new Error("the report link was not accepted");
    return { token: tokenIn(messages.at(-1) as Message), tokenHash: sent.token_hash };
  }

  async function consume(
    identity: ReturnType<typeof identityFor>,
    token: string,
    intentKind: "registration" | "recovery" = "registration",
  ) {
    return await identity.consumeReportLink({
      operation: "verify",
      phase: "consume",
      token,
      email: EMAIL,
      intent_kind: intentKind,
      state: STATE,
    });
  }

  describe("private report identity on PostgreSQL", () => {
    beforeEach(async () => {
      await emptyEverything();
      await migrate();
    });

    it("rolls verification, person and generated session back when receipt storage fails", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const link = await sendReport(identity, messages);
      await pool.query(`
        create function fail_report_receipt() returns trigger language plpgsql as $$
        begin raise exception 'injected receipt failure'; end $$
      `);
      await pool.query(`
        create trigger fail_report_receipt before insert on cabinet_report_receipts
        for each row execute function fail_report_receipt()
      `);

      await expect(consume(identity, link.token)).rejects.toThrow(/cabinet_report_receipts/i);
      expect(
        (
          await pool.query(`
            select
              (select count(*)::int from cabinet_accounts) as people,
              (select count(*)::int from cabinet_sessions) as sessions,
              (select count(*)::int from cabinet_report_receipts) as receipts,
              (select count(*)::int from cabinet_verifications) as verifications
          `)
        ).rows[0],
      ).toStrictEqual({ people: 0, sessions: 0, receipts: 0, verifications: 1 });

      await pool.query("drop trigger fail_report_receipt on cabinet_report_receipts");
      await pool.query("drop function fail_report_receipt()");
      await expect(consume(identity, link.token)).resolves.toMatchObject({ status: "pending" });
      expect(
        (await pool.query("select count(*)::int as count from cabinet_sessions")).rows[0],
      ).toStrictEqual({ count: 0 });
    });

    it("rolls the report token and rate evidence back when the mail provider refuses", async () => {
      const identity = identityFor(config(), {
        pool,
        postman: async () => "refused",
      });
      await expect(
        identity.sendReportLink({
          operation: "send",
          email: EMAIL,
          intent_kind: "recovery",
          state: STATE,
        }),
      ).resolves.toStrictEqual({ status: "unavailable" });
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

    it("retries the exact pending receipt after original link expiry and refuses mismatches", async () => {
      vi.useFakeTimers({ now: NOW });
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const link = await sendReport(identity, messages);
      await pool.query("update cabinet_verifications set expires_at = $1", [
        new Date(NOW.getTime() + 1_000),
      ]);
      await expect(
        identity.consumeReportLink({
          operation: "verify",
          phase: "consume",
          token: link.token,
          email: EMAIL,
          intent_kind: "registration",
          state: OTHER_STATE,
        }),
      ).resolves.toStrictEqual({ status: "refused" });
      const first = await consume(identity, link.token);
      expect(first.status).toBe("pending");
      vi.advanceTimersByTime(2_000);
      await expect(consume(identity, link.token)).resolves.toStrictEqual(first);
      expect(
        (await pool.query("select count(*)::int as count from cabinet_sessions")).rows[0],
      ).toStrictEqual({ count: 0 });
    });

    it("acknowledges only a bound pending receipt and issues one usable cabinet link", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const link = await sendReport(identity, messages);
      const receipt = await consume(identity, link.token);
      if (receipt.status !== "pending") throw new Error("the report link was refused");
      const proof = { receipt_id: receipt.receipt_id, token_hash: link.tokenHash };
      await expect(
        identity.issueCabinetLink({ operation: "issue", ...proof }),
      ).resolves.toStrictEqual({
        status: "refused",
      });
      await expect(
        identity.acknowledgeReportLink({
          operation: "verify",
          phase: "acknowledge",
          receipt_id: receipt.receipt_id,
          token_hash: "x".repeat(43),
        }),
      ).resolves.toStrictEqual({ status: "refused" });
      await expect(
        identity.acknowledgeReportLink({
          operation: "verify",
          phase: "acknowledge",
          ...proof,
        }),
      ).resolves.toStrictEqual({ status: "completed" });

      const issued = await identity.issueCabinetLink({ operation: "issue", ...proof });
      if (issued.status !== "issued") throw new Error("the cabinet link was not issued");
      await pool.query(
        "update cabinet_report_receipts set completion_deadline = now() - interval '1 second'",
      );
      await expect(
        identity.issueCabinetLink({ operation: "issue", ...proof }),
      ).resolves.toStrictEqual({
        status: "already_attempted",
      });
      expect(
        (await pool.query("select count(*)::int as count from cabinet_verifications")).rows[0],
      ).toStrictEqual({ count: 1 });
      const cabinetToken = new URL(issued.action_url).searchParams.get("token");
      if (cabinetToken === null) throw new Error("the issued URL has no token");
      const persisted = (
        await pool.query(
          `select secret.digest_key, receipt.id, receipt.token_hash, proof.identifier
           from cabinet_report_identity_secrets secret
           join cabinet_report_receipts receipt on receipt.id = $1
           join cabinet_verifications proof on proof.value like '%"purpose":"cabinet"%'
           where secret.id = 'digest-v1'`,
          [receipt.receipt_id],
        )
      ).rows[0] as
        | { digest_key: string; id: string; token_hash: string; identifier: string }
        | undefined;
      if (persisted === undefined) throw new Error("the issued proof was not stored");
      const oldCandidate = createHmac("sha256", persisted.digest_key)
        .update(`report-cabinet-link\0${persisted.id}\0${persisted.token_hash}`)
        .digest("hex")
        .slice(0, 32);
      expect(oldCandidate).not.toBe(cabinetToken);
      await expect(identity.openLink(oldCandidate)).resolves.toStrictEqual({ status: "refused" });
      expect(persisted.identifier).toBe(reportIdentityTokenHash(cabinetToken));
      const opened = await identity.openLink(cabinetToken);
      expect(opened).toMatchObject({ status: "opened", person: { email: EMAIL } });
    });

    it("closes pending completion at five minutes but keeps completed acknowledgement idempotent", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const expiredPendingLink = await sendReport(identity, messages);
      const expiredPending = await consume(identity, expiredPendingLink.token);
      if (expiredPending.status !== "pending") throw new Error("the report link was refused");
      await pool.query(
        "update cabinet_report_receipts set completion_deadline = now() where id = $1",
        [expiredPending.receipt_id],
      );
      await expect(
        identity.acknowledgeReportLink({
          operation: "verify",
          phase: "acknowledge",
          receipt_id: expiredPending.receipt_id,
          token_hash: expiredPendingLink.tokenHash,
        }),
      ).resolves.toStrictEqual({ status: "refused" });

      const completedLink = await sendReport(identity, messages);
      const completed = await consume(identity, completedLink.token);
      if (completed.status !== "pending") throw new Error("the second report link was refused");
      const proof = { receipt_id: completed.receipt_id, token_hash: completedLink.tokenHash };
      await identity.acknowledgeReportLink({
        operation: "verify",
        phase: "acknowledge",
        ...proof,
      });
      await pool.query(
        "update cabinet_report_receipts set completion_deadline = now() where id = $1",
        [completed.receipt_id],
      );
      await expect(
        identity.acknowledgeReportLink({
          operation: "verify",
          phase: "acknowledge",
          ...proof,
        }),
      ).resolves.toStrictEqual({ status: "completed" });
      await expect(
        identity.issueCabinetLink({ operation: "issue", ...proof }),
      ).resolves.toStrictEqual({
        status: "refused",
      });
    });

    it("refuses and removes every receipt state at its exact seven-day boundary", async () => {
      vi.useFakeTimers({ now: NOW });
      const messages: Message[] = [];
      const identity = identityOn(messages);

      const freshProof = async () => {
        await pool.query("delete from cabinet_link_sends");
        const link = await sendReport(identity, messages);
        const receipt = await consume(identity, link.token);
        if (receipt.status !== "pending") throw new Error("the report link was refused");
        return {
          receipt,
          proof: { receipt_id: receipt.receipt_id, token_hash: link.tokenHash },
        };
      };
      const rowCount = async (receiptId: string) =>
        Number(
          (
            await pool.query(
              "select count(*)::int as count from cabinet_report_receipts where id = $1",
              [receiptId],
            )
          ).rows[0]?.count,
        );

      const pending = await freshProof();
      await pool.query(
        `update cabinet_report_receipts
         set completion_deadline = $1, retention_until = $2 where id = $3`,
        [new Date(NOW.getTime() - 1), new Date(NOW.getTime() + 1), pending.receipt.receipt_id],
      );
      await expect(
        identity.acknowledgeReportLink({
          operation: "verify",
          phase: "acknowledge",
          ...pending.proof,
        }),
      ).resolves.toStrictEqual({ status: "refused" });
      expect(await rowCount(pending.receipt.receipt_id)).toBe(1);
      await pool.query("update cabinet_report_receipts set retention_until = $1 where id = $2", [
        NOW,
        pending.receipt.receipt_id,
      ]);
      await expect(
        identity.acknowledgeReportLink({
          operation: "verify",
          phase: "acknowledge",
          ...pending.proof,
        }),
      ).resolves.toStrictEqual({ status: "refused" });
      expect(await rowCount(pending.receipt.receipt_id)).toBe(0);

      const completed = await freshProof();
      await identity.acknowledgeReportLink({
        operation: "verify",
        phase: "acknowledge",
        ...completed.proof,
      });
      await pool.query("update cabinet_report_receipts set retention_until = $1 where id = $2", [
        new Date(NOW.getTime() + 1),
        completed.receipt.receipt_id,
      ]);
      await expect(
        identity.acknowledgeReportLink({
          operation: "verify",
          phase: "acknowledge",
          ...completed.proof,
        }),
      ).resolves.toStrictEqual({ status: "completed" });
      expect(await rowCount(completed.receipt.receipt_id)).toBe(1);
      await pool.query("update cabinet_report_receipts set retention_until = $1 where id = $2", [
        NOW,
        completed.receipt.receipt_id,
      ]);
      await expect(
        identity.acknowledgeReportLink({
          operation: "verify",
          phase: "acknowledge",
          ...completed.proof,
        }),
      ).resolves.toStrictEqual({ status: "refused" });
      expect(await rowCount(completed.receipt.receipt_id)).toBe(0);

      const invalidated = await freshProof();
      await pool.query(
        `update cabinet_report_receipts
         set status = 'invalidated', invalidated_at = $1, retention_until = $2 where id = $3`,
        [NOW, new Date(NOW.getTime() + 1), invalidated.receipt.receipt_id],
      );
      await expect(
        identity.acknowledgeReportLink({
          operation: "verify",
          phase: "acknowledge",
          ...invalidated.proof,
        }),
      ).resolves.toStrictEqual({ status: "refused" });
      expect(await rowCount(invalidated.receipt.receipt_id)).toBe(1);
      await pool.query("update cabinet_report_receipts set retention_until = $1 where id = $2", [
        NOW,
        invalidated.receipt.receipt_id,
      ]);
      await identity.acknowledgeReportLink({
        operation: "verify",
        phase: "acknowledge",
        ...invalidated.proof,
      });
      expect(await rowCount(invalidated.receipt.receipt_id)).toBe(0);

      const issued = await freshProof();
      await identity.acknowledgeReportLink({
        operation: "verify",
        phase: "acknowledge",
        ...issued.proof,
      });
      await identity.issueCabinetLink({ operation: "issue", ...issued.proof });
      await pool.query("update cabinet_report_receipts set retention_until = $1 where id = $2", [
        new Date(NOW.getTime() + 1),
        issued.receipt.receipt_id,
      ]);
      await expect(
        identity.issueCabinetLink({ operation: "issue", ...issued.proof }),
      ).resolves.toStrictEqual({ status: "already_attempted" });
      expect(await rowCount(issued.receipt.receipt_id)).toBe(1);
      await pool.query("update cabinet_report_receipts set retention_until = $1 where id = $2", [
        NOW,
        issued.receipt.receipt_id,
      ]);
      await expect(
        identity.issueCabinetLink({ operation: "issue", ...issued.proof }),
      ).resolves.toStrictEqual({ status: "refused" });
      expect(await rowCount(issued.receipt.receipt_id)).toBe(0);
    });

    it("cleans report verifications only after expiry plus seven days", async () => {
      vi.useFakeTimers({ now: NOW });
      const identity = identityOn([]);
      const beforeBoundary = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000 + 1);
      await pool.query(
        `insert into cabinet_verifications
           (id, identifier, value, expires_at, created_at, updated_at)
         values
           ('report-proof', 'report-proof', $1, $2, $3, $3),
           ('cabinet-proof', 'cabinet-proof', $4, $5, $3, $3)`,
        [
          JSON.stringify({
            email: EMAIL,
            purpose: "report",
            intentKind: "registration",
            state: STATE,
          }),
          beforeBoundary,
          NOW,
          JSON.stringify({ email: EMAIL, purpose: "cabinet", destination: "default" }),
          new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000),
        ],
      );
      const missingProof = {
        operation: "verify" as const,
        phase: "acknowledge" as const,
        receipt_id: "019b41a0-7c53-7d63-84bd-a5a20faef497",
        token_hash: "x".repeat(43),
      };
      await identity.acknowledgeReportLink(missingProof);
      expect(
        (await pool.query("select id from cabinet_verifications order by id")).rows,
      ).toStrictEqual([{ id: "cabinet-proof" }, { id: "report-proof" }]);

      await pool.query("update cabinet_verifications set expires_at = $1 where id = $2", [
        new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000),
        "report-proof",
      ]);
      await identity.acknowledgeReportLink(missingProof);
      expect(
        (await pool.query("select id from cabinet_verifications order by id")).rows,
      ).toStrictEqual([{ id: "cabinet-proof" }]);
    });

    it("keeps a pending receipt usable after restart and credential rotation", async () => {
      const messages: Message[] = [];
      const first = identityOn(
        messages,
        undefined,
        undefined,
        "an-initial-report-secret-that-is-at-least-32-characters-long",
      );
      const link = await sendReport(first, messages);
      const receipt = await consume(first, link.token);
      if (receipt.status !== "pending") throw new Error("the report link was refused");

      const restarted = identityOn(
        [],
        undefined,
        "a-rotated-session-secret-that-is-at-least-32-characters-long",
        "a-rotated-report-secret-that-is-at-least-32-characters-long",
      );
      await expect(consume(restarted, link.token)).resolves.toStrictEqual(receipt);
      const proof = { receipt_id: receipt.receipt_id, token_hash: link.tokenHash };
      await expect(
        restarted.acknowledgeReportLink({
          operation: "verify",
          phase: "acknowledge",
          ...proof,
        }),
      ).resolves.toStrictEqual({ status: "completed" });
      await expect(
        restarted.issueCabinetLink({ operation: "issue", ...proof }),
      ).resolves.toMatchObject({ status: "issued", action_url: expect.any(String) });
      expect(
        (await pool.query("select count(*)::int as count from cabinet_report_identity_secrets"))
          .rows[0],
      ).toStrictEqual({ count: 1 });
    });

    it("replays a deleted tombstone after credential rotation without touching a replacement", async () => {
      const messages: Message[] = [];
      const first = identityOn(messages);
      const report = await sendReport(first, messages);
      await expect(consume(first, report.token)).resolves.toMatchObject({ status: "pending" });
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
      await first.requestLink(EMAIL, "default");
      const replacementLink = tokenIn(messages.at(-1) as Message);
      const restarted = identityOn(
        [],
        undefined,
        "a-rotated-session-secret-that-is-at-least-32-characters-long",
        "a-rotated-report-secret-that-is-at-least-32-characters-long",
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
      await first.requestLink(EMAIL, "default");
      const newLink = tokenIn(messages.at(-1) as Message);
      const restarted = identityOn(
        [],
        undefined,
        "a-rotated-session-secret-that-is-at-least-32-characters-long",
        "a-rotated-report-secret-that-is-at-least-32-characters-long",
      );

      await expect(restarted.deleteUnattachedPerson(request)).resolves.toStrictEqual({
        status: "retained",
      });
      expect(await restarted.byId(person.id)).toMatchObject({ merchant: MERCHANT });
      await expect(restarted.openLink(newLink)).resolves.toMatchObject({ status: "opened" });
    });

    it("deletes P1 and its cabinet proofs but retains P2 commerce and cabinet access", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const p1Report = await sendReport(identity, messages);
      const p1Receipt = await consume(identity, p1Report.token);
      expect(p1Receipt.status).toBe("pending");
      await identity.requestLink(EMAIL, "default");
      const p1Session = await identity.openLink(tokenIn(messages.at(-1) as Message));
      expect(p1Session.status).toBe("opened");
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
      await identity.requestLink(EMAIL, "default");
      await expect(identity.openLink(tokenIn(messages.at(-1) as Message))).resolves.toMatchObject({
        status: "opened",
      });
      await identity.requestLink(EMAIL, "default");
      const p2CabinetToken = tokenIn(messages.at(-1) as Message);
      const p2Report = await sendReport(identity, messages, "recovery");
      const p2Receipt = await consume(identity, p2Report.token, "recovery");
      if (p2Receipt.status !== "pending") throw new Error("the recovery link was refused");
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
      await expect(
        identity.acknowledgeReportLink({
          operation: "verify",
          phase: "acknowledge",
          receipt_id: p2Receipt.receipt_id,
          token_hash: p2Report.tokenHash,
        }),
      ).resolves.toStrictEqual({ status: "refused" });
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
        const sending = identity.sendReportLink({
          operation: "send",
          email: EMAIL,
          intent_kind: "registration",
          state: STATE,
        });
        await gateClient.query("select pg_advisory_unlock(424242)");
        await expect(deleting).resolves.toStrictEqual({ status: "already_absent" });
        await expect(sending).resolves.toMatchObject({ status: "accepted" });
        await expect(consume(identity, tokenIn(messages[0] as Message))).resolves.toMatchObject({
          status: "pending",
        });
      } finally {
        await gateClient.query("select pg_advisory_unlock_all()");
        gateClient.release();
      }
    });

    it("invalidates a report link whose provider handoff committed before concurrent deletion", async () => {
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
      const sending = identity.sendReportLink({
        operation: "send",
        email: EMAIL,
        intent_kind: "registration",
        state: STATE,
      });
      await atHandoff;
      const deleting = identity.deleteUnattachedPerson({
        operation: "delete",
        operation_id: OPERATION_ONE,
        email: EMAIL,
      });
      releaseHandoff();

      await expect(sending).resolves.toMatchObject({ status: "accepted" });
      await expect(deleting).resolves.toStrictEqual({ status: "already_absent" });
      await expect(consume(identity, tokenIn(messages[0] as Message))).resolves.toStrictEqual({
        status: "refused",
      });
    });

    it("shares the person lock with merchant attachment so deletion retains the committed P2", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const link = await sendReport(identity, messages);
      const receipt = await consume(identity, link.token);
      if (receipt.status !== "pending") throw new Error("the report link was refused");
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

    it("replays a permanent terminal tombstone without resolving the address again", async () => {
      const messages: Message[] = [];
      const identity = identityOn(messages);
      const request = { operation: "delete" as const, operation_id: OPERATION_ONE, email: EMAIL };
      await expect(identity.deleteUnattachedPerson(request)).resolves.toStrictEqual({
        status: "already_absent",
      });
      const made = await identity.make(EMAIL, MERCHANT);
      if (made === null) throw new Error("the replacement person was not made");
      await identity.requestLink(EMAIL, "default");
      const cabinetToken = tokenIn(messages.at(-1) as Message);

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

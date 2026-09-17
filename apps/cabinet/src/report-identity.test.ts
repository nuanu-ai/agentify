import { createHmac } from "node:crypto";
import { reportIdentityTokenHash } from "@agentify/scanner-contracts/report-identity";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { identityFor } from "./identity.js";
import type { Message } from "./mail.js";

const EMAIL = "owner@example.com";
const STATE = "s".repeat(43);
const MERCHANT = { id: "mer_owner", key: "the-owner-gateway-key" };
const OPERATION_ONE = "019b41a0-7c51-7d63-84bd-a5a20faef497";
const OPERATION_TWO = "019b41a0-7c52-7d63-84bd-a5a20faef497";

function config(
  authSecret = "a-secret-that-is-at-least-32-characters-long",
  reportIdentitySecret?: string,
) {
  return loadConfig({
    DATABASE_URL: "postgres://unused.example/unused",
    AUTH_SECRET: authSecret,
    PAYMENT_NETWORK: "eip155:84532",
    FACILITATOR_URL: "sandbox:scripted",
    REGISTRATION_INVITATION: "the-existing-gateway-invitation",
    PUBLIC_BASE_URL: "https://agentify.ad",
    BASE_PATH: "/cabinet",
    REPORT_IDENTITY_SECRET: reportIdentitySecret,
  });
}

function fixture(
  rows: Record<string, Record<string, unknown>[]> = {
    cabinet_accounts: [],
    cabinet_sessions: [],
    cabinet_credentials: [],
    cabinet_verifications: [],
    cabinet_link_sends: [],
    cabinet_report_receipts: [],
    cabinet_report_deletion_tombstones: [],
  },
  authSecret?: string,
  reportIdentitySecret?: string,
) {
  const messages: Message[] = [];
  const identity = identityFor(config(authSecret, reportIdentitySecret), {
    rows,
    postman: async (message) => {
      messages.push(message);
      return "accepted";
    },
  });
  return { identity, messages, rows };
}

function tokenIn(message: Message): string {
  const raw = message.body.match(/https?:\/\/\S+/)?.[0];
  if (raw === undefined) throw new Error("the message has no report link");
  const action = new URL(raw);
  const token =
    new URLSearchParams(action.hash.slice(1)).get("token") ?? action.searchParams.get("token");
  if (token === null) throw new Error("the report link has no token");
  return token;
}

function actionIn(message: Message): URL {
  const raw = message.body.match(/https?:\/\/\S+/)?.[0];
  if (raw === undefined) throw new Error("the message has no report link");
  return new URL(raw);
}

async function sendReport(
  one: ReturnType<typeof fixture>,
  intentKind: "registration" | "recovery" = "registration",
) {
  const result = await one.identity.sendReportLink({
    operation: "send",
    email: EMAIL,
    intent_kind: intentKind,
    state: STATE,
  });
  if (result.status !== "accepted") throw new Error("the report link was not accepted");
  return { token: tokenIn(one.messages.at(-1) as Message), tokenHash: result.token_hash };
}

describe("private report identity", () => {
  it("sends branded purpose-specific mail without creating a person", async () => {
    const one = fixture();
    const registration = await sendReport(one);
    const recovery = await sendReport(one, "recovery");

    expect(registration.tokenHash).toHaveLength(43);
    expect(recovery.tokenHash).toHaveLength(43);
    expect(one.messages[0]).toMatchObject({
      to: EMAIL,
      subject: "Unlock your Agentify report",
    });
    expect(one.messages[0]?.html).toContain("Open my report");
    expect(one.messages[1]).toMatchObject({
      to: EMAIL,
      subject: "Recover your Agentify report",
    });
    expect(one.messages[1]?.body).toContain("If a private report is linked to this address");
    const registrationAction = actionIn(one.messages[0] as Message);
    expect(registrationAction.search).toBe("");
    expect(registrationAction.hash).toBe(`#state=${STATE}&token=${registration.token}`);
    expect(await one.identity.byEmail(EMAIL)).toBeNull();
  });

  it("limits report sends independently without storing the raw address as rate evidence", async () => {
    const one = fixture();
    for (let count = 0; count < 3; count += 1) {
      await expect(
        one.identity.sendReportLink({
          operation: "send",
          email: EMAIL,
          intent_kind: "registration",
          state: STATE,
        }),
      ).resolves.toMatchObject({ status: "accepted" });
    }
    await expect(
      one.identity.sendReportLink({
        operation: "send",
        email: EMAIL,
        intent_kind: "registration",
        state: STATE,
      }),
    ).resolves.toMatchObject({ status: "cooldown", retry_at: expect.any(String) });
    await expect(one.identity.requestLink(EMAIL, "default")).resolves.toStrictEqual({
      status: "accepted",
    });
    expect(JSON.stringify(one.rows.cabinet_link_sends)).not.toContain(EMAIL);
  });

  it("consumes an exact report claim once without leaving a cabinet session", async () => {
    const one = fixture();
    const { token, tokenHash } = await sendReport(one);
    await expect(
      one.identity.consumeReportLink({
        operation: "verify",
        phase: "consume",
        token,
        email: "somebody@example.com",
        intent_kind: "registration",
        state: STATE,
      }),
    ).resolves.toStrictEqual({ status: "refused" });

    const consumed = await one.identity.consumeReportLink({
      operation: "verify",
      phase: "consume",
      token,
      email: EMAIL,
      intent_kind: "registration",
      state: STATE,
    });
    expect(consumed).toMatchObject({ status: "pending", receipt_id: expect.any(String) });
    expect(one.rows.cabinet_sessions).toHaveLength(0);
    expect(await one.identity.byEmail(EMAIL)).toMatchObject({ confirmed: true, merchant: null });

    await expect(
      one.identity.consumeReportLink({
        operation: "verify",
        phase: "consume",
        token,
        email: EMAIL,
        intent_kind: "registration",
        state: STATE,
      }),
    ).resolves.toStrictEqual(consumed);
    const storedReceipt = one.rows.cabinet_report_receipts?.[0] as
      | { tokenHash: string }
      | undefined;
    expect(storedReceipt?.tokenHash).toBe(tokenHash);
  });

  it("requires acknowledgement before issuing one cabinet link", async () => {
    const one = fixture();
    const { token, tokenHash } = await sendReport(one);
    const consumed = await one.identity.consumeReportLink({
      operation: "verify",
      phase: "consume",
      token,
      email: EMAIL,
      intent_kind: "registration",
      state: STATE,
    });
    if (consumed.status !== "pending") throw new Error("the report link was refused");
    const proof = {
      receipt_id: consumed.receipt_id,
      token_hash: tokenHash,
    };

    await expect(
      one.identity.issueCabinetLink({ operation: "issue", ...proof }),
    ).resolves.toStrictEqual({ status: "refused" });
    await expect(
      one.identity.acknowledgeReportLink({
        operation: "verify",
        phase: "acknowledge",
        ...proof,
      }),
    ).resolves.toStrictEqual({ status: "completed" });
    await expect(
      one.identity.acknowledgeReportLink({
        operation: "verify",
        phase: "acknowledge",
        ...proof,
      }),
    ).resolves.toStrictEqual({ status: "completed" });
    await expect(
      one.identity.consumeReportLink({
        operation: "verify",
        phase: "consume",
        token,
        email: EMAIL,
        intent_kind: "registration",
        state: STATE,
      }),
    ).resolves.toStrictEqual({ status: "refused" });

    const issued = await one.identity.issueCabinetLink({ operation: "issue", ...proof });
    expect(issued).toMatchObject({ status: "issued", action_url: expect.any(String) });
    if (issued.status !== "issued") throw new Error("the cabinet link was not issued");
    const rawToken = new URL(issued.action_url).searchParams.get("token");
    if (rawToken === null) throw new Error("the issued URL has no token");
    expect(rawToken).toMatch(/^[A-Za-z0-9]{32}$/);
    const digestKey = String(one.rows.cabinet_report_identity_secrets?.[0]?.digestKey);
    const storedReceipt = one.rows.cabinet_report_receipts?.[0];
    const oldCandidate = createHmac("sha256", digestKey)
      .update(`report-cabinet-link\0${storedReceipt?.id}\0${storedReceipt?.tokenHash}`)
      .digest("hex")
      .slice(0, 32);
    const cabinetProof = one.rows.cabinet_verifications?.find((row) =>
      String(row.value).includes('"purpose":"cabinet"'),
    );
    expect(oldCandidate).not.toBe(rawToken);
    await expect(one.identity.openLink(oldCandidate)).resolves.toStrictEqual({
      status: "refused",
    });
    expect(cabinetProof?.identifier).toBe(reportIdentityTokenHash(rawToken));
    await expect(one.identity.openLink(rawToken)).resolves.toMatchObject({ status: "opened" });
    await expect(
      one.identity.issueCabinetLink({ operation: "issue", ...proof }),
    ).resolves.toStrictEqual({ status: "already_attempted" });
  });

  it("keeps a pending receipt usable across credential rotation and restart", async () => {
    const first = fixture(
      undefined,
      undefined,
      "an-initial-report-secret-that-is-at-least-32-characters-long",
    );
    const link = await sendReport(first);
    const consumed = await first.identity.consumeReportLink({
      operation: "verify",
      phase: "consume",
      token: link.token,
      email: EMAIL,
      intent_kind: "registration",
      state: STATE,
    });
    if (consumed.status !== "pending") throw new Error("the report link was refused");
    const originalDigestKey = first.rows.cabinet_report_identity_secrets?.[0]?.digestKey;
    expect(originalDigestKey).toEqual(expect.any(String));

    const restarted = fixture(
      first.rows,
      "a-rotated-session-secret-that-is-at-least-32-characters-long",
      "a-rotated-report-secret-that-is-at-least-32-characters-long",
    );
    await expect(
      restarted.identity.consumeReportLink({
        operation: "verify",
        phase: "consume",
        token: link.token,
        email: EMAIL,
        intent_kind: "registration",
        state: STATE,
      }),
    ).resolves.toStrictEqual(consumed);
    const proof = { receipt_id: consumed.receipt_id, token_hash: link.tokenHash };
    await expect(
      restarted.identity.acknowledgeReportLink({
        operation: "verify",
        phase: "acknowledge",
        ...proof,
      }),
    ).resolves.toStrictEqual({ status: "completed" });
    await expect(
      restarted.identity.issueCabinetLink({ operation: "issue", ...proof }),
    ).resolves.toMatchObject({ status: "issued", action_url: expect.any(String) });
    expect(first.rows.cabinet_report_identity_secrets).toHaveLength(1);
    expect(first.rows.cabinet_report_identity_secrets?.[0]?.digestKey).toBe(originalDigestKey);
  });

  it("deletes P1 but retains P2 while invalidating their report proof", async () => {
    const p1 = fixture();
    const p1Link = await sendReport(p1);
    const p1Receipt = await p1.identity.consumeReportLink({
      operation: "verify",
      phase: "consume",
      token: p1Link.token,
      email: EMAIL,
      intent_kind: "registration",
      state: STATE,
    });
    expect(p1Receipt.status).toBe("pending");
    await expect(
      p1.identity.deleteUnattachedPerson({
        operation: "delete",
        operation_id: OPERATION_ONE,
        email: EMAIL,
      }),
    ).resolves.toStrictEqual({ status: "deleted" });
    expect(await p1.identity.byEmail(EMAIL)).toBeNull();

    const p2 = fixture();
    await p2.identity.make(EMAIL, MERCHANT);
    const p2Link = await sendReport(p2, "recovery");
    const p2Receipt = await p2.identity.consumeReportLink({
      operation: "verify",
      phase: "consume",
      token: p2Link.token,
      email: EMAIL,
      intent_kind: "recovery",
      state: STATE,
    });
    if (p2Receipt.status !== "pending") throw new Error("the recovery link was refused");
    const unconsumedP2Link = await sendReport(p2, "recovery");
    await expect(
      p2.identity.deleteUnattachedPerson({
        operation: "delete",
        operation_id: OPERATION_TWO,
        email: EMAIL,
      }),
    ).resolves.toStrictEqual({ status: "retained" });
    expect(await p2.identity.byEmail(EMAIL)).toMatchObject({ merchant: MERCHANT });
    await expect(
      p2.identity.consumeReportLink({
        operation: "verify",
        phase: "consume",
        token: unconsumedP2Link.token,
        email: EMAIL,
        intent_kind: "recovery",
        state: STATE,
      }),
    ).resolves.toStrictEqual({ status: "refused" });
    await expect(
      p2.identity.acknowledgeReportLink({
        operation: "verify",
        phase: "acknowledge",
        receipt_id: p2Receipt.receipt_id,
        token_hash: p2Link.tokenHash,
      }),
    ).resolves.toStrictEqual({ status: "refused" });
  });

  it("replays a terminal delete without touching a person made afterward", async () => {
    const one = fixture();
    const operationId = OPERATION_ONE;
    const request = { operation: "delete" as const, operation_id: operationId, email: EMAIL };
    await expect(one.identity.deleteUnattachedPerson(request)).resolves.toStrictEqual({
      status: "already_absent",
    });
    await one.identity.make(EMAIL, MERCHANT);
    await one.identity.requestLink(EMAIL, "default");

    await expect(one.identity.deleteUnattachedPerson(request)).resolves.toStrictEqual({
      status: "already_absent",
    });
    expect(await one.identity.byEmail(EMAIL)).toMatchObject({ merchant: MERCHANT });
    expect(one.rows.cabinet_verifications).toHaveLength(1);
    await expect(
      one.identity.deleteUnattachedPerson({ ...request, email: "other@example.com" }),
    ).resolves.toStrictEqual({ status: "refused" });
  });
});

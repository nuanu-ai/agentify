import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  consumeReportLinkResponseSchema,
  sendReportLinkResponseSchema,
} from "@agentify/scanner-contracts/report-identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { identityFor } from "./identity.js";
import type { Message, Postman } from "./mail.js";
import {
  buildReportIdentityApp,
  REPORT_IDENTITY_PATH,
  startReportIdentityServer,
} from "./report-identity-server.js";

const SECRET = "a-dedicated-private-secret-at-least-32-characters";
const EMAIL = "owner@example.com";
const STATE = "s".repeat(43);
const servers: Server[] = [];

function config() {
  return loadConfig({
    DATABASE_URL: "postgres://unused.example/unused",
    AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
    REPORT_IDENTITY_SECRET: SECRET,
    PAYMENT_NETWORK: "eip155:84532",
    FACILITATOR_URL: "sandbox:scripted",
    REGISTRATION_INVITATION: "the-existing-gateway-invitation",
    PUBLIC_BASE_URL: "https://agentify.ad",
    BASE_PATH: "/cabinet",
  });
}

function identityWith(postman: Postman) {
  return identityFor(config(), {
    rows: {
      cabinet_accounts: [],
      cabinet_sessions: [],
      cabinet_credentials: [],
      cabinet_verifications: [],
      cabinet_link_sends: [],
      cabinet_report_receipts: [],
      cabinet_report_deletion_tombstones: [],
    },
    postman,
  });
}

async function serve(postman: Postman) {
  const identity = identityWith(postman);
  const server = buildReportIdentityApp(SECRET, identity).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return { identity, url: `http://127.0.0.1:${address.port}${REPORT_IDENTITY_PATH}` };
}

async function post(url: string, body: unknown, secret = SECRET, contentType = "application/json") {
  return await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
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

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("the private report identity listener", () => {
  it("opens no listener for a standalone cabinet without the private secret", () => {
    const identity = identityWith(async () => "accepted");
    expect(startReportIdentityServer(null, identity)).toBeNull();
  });

  it("authenticates before parsing and exposes one strict operation route", async () => {
    const messages: Message[] = [];
    const { url } = await serve(async (message) => {
      messages.push(message);
      return "accepted";
    });
    const request = {
      operation: "send",
      email: EMAIL,
      intent_kind: "registration",
      state: STATE,
    };

    const missing = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json-with-sensitive-token",
    });
    expect(missing.status).toBe(401);
    expect(await missing.text()).toBe("");
    const wrong = await post(url, request, "the-wrong-private-secret-at-least-32-chars");
    expect(wrong.status).toBe(401);
    expect(messages).toHaveLength(0);

    const accepted = await post(url, request);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      status: "accepted",
      token_hash: expect.any(String),
    });
    expect(messages).toHaveLength(1);
    const wrongMethod = await fetch(url, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(wrongMethod.status).toBe(404);
    expect(messages).toHaveLength(1);
  });

  it("refuses malformed, oversized, wrong-media and non-contract requests without a body", async () => {
    const { url } = await serve(async () => "accepted");
    const cases = [
      ["{", "application/json", 400],
      [JSON.stringify({ operation: "send", padding: "x".repeat(9_000) }), "application/json", 413],
      [JSON.stringify({ operation: "send" }), "text/plain", 415],
      [JSON.stringify({ operation: "inspect" }), "application/json", 400],
    ] as const;
    for (const [body, contentType, status] of cases) {
      const response = await post(url, body, SECRET, contentType);
      expect(response.status, `${contentType}:${body.length}`).toBe(status);
      expect(await response.text()).toBe("");
    }
  });

  it("runs consume, acknowledge and one-shot issue through the closed route", async () => {
    const messages: Message[] = [];
    const { url } = await serve(async (message) => {
      messages.push(message);
      return "accepted";
    });
    const sent = sendReportLinkResponseSchema.parse(
      await (
        await post(url, {
          operation: "send",
          email: EMAIL,
          intent_kind: "registration",
          state: STATE,
        })
      ).json(),
    );
    if (sent.status !== "accepted") throw new Error("the report send was not accepted");
    const consumed = consumeReportLinkResponseSchema.parse(
      await (
        await post(url, {
          operation: "verify",
          phase: "consume",
          token: tokenIn(messages[0] as Message),
          email: EMAIL,
          intent_kind: "registration",
          state: STATE,
        })
      ).json(),
    );
    expect(consumed).toMatchObject({ status: "pending", receipt_id: expect.any(String) });
    if (consumed.status !== "pending") throw new Error("the report consume was refused");
    const proof = { receipt_id: consumed.receipt_id, token_hash: sent.token_hash };
    expect(
      await (await post(url, { operation: "verify", phase: "acknowledge", ...proof })).json(),
    ).toStrictEqual({ status: "completed" });
    expect(await (await post(url, { operation: "issue", ...proof })).json()).toMatchObject({
      status: "issued",
      action_url: expect.stringContaining("/cabinet/sign-in/open?token="),
    });
    expect(await (await post(url, { operation: "issue", ...proof })).json()).toStrictEqual({
      status: "already_attempted",
    });
  });

  it("returns a silent 503 without logging a thrown sensitive request", async () => {
    const marker = "sensitive-token-email-state-marker";
    const { url } = await serve(async () => {
      throw new Error(marker);
    });
    const lines: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...parts) => {
      lines.push(parts.map(String).join(" "));
    });
    const log = vi.spyOn(console, "log").mockImplementation((...parts) => {
      lines.push(parts.map(String).join(" "));
    });
    try {
      const response = await post(url, {
        operation: "send",
        email: EMAIL,
        intent_kind: "recovery",
        state: STATE,
      });
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("");
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
    expect(lines.join("\n")).not.toContain(marker);
    expect(lines).toHaveLength(0);
  });
});

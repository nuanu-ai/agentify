import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  readSessionResponseSchema,
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
const SCAN = "019b41a0-7c51-7d63-84bd-a5a20faef497";
const REQUEST = "019b41a0-7c51-7d63-84bd-a5a20faef498";
const COOKIE = "__Host-agentify.session_token";
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
    COOKIE_SECURE: "true",
  });
}

function identityWith(postman: Postman) {
  const rows: Record<string, Record<string, unknown>[]> = {
    cabinet_accounts: [],
    cabinet_sessions: [],
    cabinet_credentials: [],
    cabinet_verifications: [],
    cabinet_link_sends: [],
    cabinet_report_deletion_tombstones: [],
  };
  return { identity: identityFor(config(), { rows, postman }), rows };
}

/** Nobody here owns a merchant, so there is no key for a reading to renew. */
const noKeyToRenew = async (): Promise<void> => undefined;

async function serve(postman: Postman) {
  const { identity, rows } = identityWith(postman);
  const server = buildReportIdentityApp(SECRET, identity, noKeyToRenew).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return { identity, rows, url: `http://127.0.0.1:${address.port}${REPORT_IDENTITY_PATH}` };
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
  if (raw === undefined) throw new Error("the message has no link");
  const token = new URL(raw).searchParams.get("token");
  if (token === null) throw new Error("the link has no token");
  return token;
}

const sendBody = {
  operation: "send",
  email: EMAIL,
  destination: { report: SCAN },
  request: REQUEST,
};

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("the cabinet's internal route for the scanner", () => {
  it("opens no listener for a standalone cabinet without the private secret", () => {
    const { identity } = identityWith(async () => "accepted");
    expect(startReportIdentityServer(null, identity, noKeyToRenew)).toBeNull();
  });

  it("authenticates before parsing and exposes one strict operation route", async () => {
    const messages: Message[] = [];
    const { url } = await serve(async (message) => {
      messages.push(message);
      return "accepted";
    });

    const missing = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json-with-sensitive-token",
    });
    expect(missing.status).toBe(401);
    expect(await missing.text()).toBe("");
    const wrong = await post(url, sendBody, "the-wrong-private-secret-at-least-32-chars");
    expect(wrong.status).toBe(401);
    expect(messages).toHaveLength(0);

    const accepted = await post(url, sendBody);
    expect(accepted.status).toBe(200);
    expect(sendReportLinkResponseSchema.parse(await accepted.json())).toStrictEqual({
      status: "accepted",
    });
    expect(messages).toHaveLength(1);
    const wrongMethod = await fetch(url, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(wrongMethod.status).toBe(404);
    expect(messages).toHaveLength(1);
  });

  it("refuses malformed, oversized, wrong-media and non-contract requests without a body", async () => {
    const messages: Message[] = [];
    const { url } = await serve(async (message) => {
      messages.push(message);
      return "accepted";
    });
    const cases = [
      ["{", "application/json", 400],
      [JSON.stringify({ operation: "send", padding: "x".repeat(17_000) }), "application/json", 413],
      [JSON.stringify(sendBody), "text/plain", 415],
      [JSON.stringify({ operation: "inspect" }), "application/json", 400],
      [
        JSON.stringify({ ...sendBody, destination: { url: "https://evil.example/" } }),
        "application/json",
        400,
      ],
      [JSON.stringify({ ...sendBody, destination: "/cabinet/settings" }), "application/json", 400],
    ] as const;
    for (const [body, contentType, status] of cases) {
      const response = await post(url, body, SECRET, contentType);
      expect(response.status, `${contentType}:${body.slice(0, 60)}`).toBe(status);
      expect(await response.text()).toBe("");
    }
    // Nothing refused at the door reached a mailbox.
    expect(messages).toHaveLength(0);
  });

  it("answers whose session a cookie is, naming the request its link was asked for", async () => {
    const messages: Message[] = [];
    const { identity, url } = await serve(async (message) => {
      messages.push(message);
      return "accepted";
    });
    await post(url, sendBody);
    const opened = await identity.openLink(tokenIn(messages[0] as Message));
    if (opened.status !== "opened") throw new Error("the report link did not open");
    const cookie = opened.setCookies.map((line) => line.split(";")[0]).join("; ");

    const asked = readSessionResponseSchema.parse(
      await (
        await post(url, { operation: "session", cookie: `other=1; ${cookie}`, renew: false })
      ).json(),
    );

    expect(asked).toStrictEqual({
      status: "signed_in",
      email: EMAIL,
      request: REQUEST,
      set_cookie: [],
    });
    for (const unknown of ["", "other=1", `${COOKIE}=made-up.value`]) {
      expect(
        await (await post(url, { operation: "session", cookie: unknown, renew: true })).json(),
        unknown,
      ).toStrictEqual({ status: "signed_out" });
    }
  });

  it("passes the renewed cookie on when asked to renew a day-old session, and only then", async () => {
    // A visit to a report counts toward the thirty days only if the cookie the
    // cabinet renews reaches the browser, and the scanner can pass a line on
    // from some of its answers and not from others (ADR-0026 §2).
    const messages: Message[] = [];
    const { identity, rows, url } = await serve(async (message) => {
      messages.push(message);
      return "accepted";
    });
    await post(url, sendBody);
    const opened = await identity.openLink(tokenIn(messages[0] as Message));
    if (opened.status !== "opened") throw new Error("the report link did not open");
    const cookie = opened.setCookies.map((line) => line.split(";")[0]).join("; ");
    const aDayAndAnHourAgo = Date.now() - 25 * 60 * 60 * 1_000;
    for (const session of rows.cabinet_sessions ?? []) {
      session.expiresAt = new Date(aDayAndAnHourAgo + 30 * 24 * 60 * 60 * 1_000);
    }
    const before = structuredClone(rows.cabinet_sessions);

    const quiet = readSessionResponseSchema.parse(
      await (await post(url, { operation: "session", cookie, renew: false })).json(),
    );
    expect(quiet).toMatchObject({ status: "signed_in", set_cookie: [] });
    expect(rows.cabinet_sessions).toStrictEqual(before);

    const renewed = readSessionResponseSchema.parse(
      await (await post(url, { operation: "session", cookie, renew: true })).json(),
    );
    if (renewed.status !== "signed_in") throw new Error("the session was not read");
    expect(renewed.set_cookie.some((line) => line.startsWith(`${COOKIE}=`))).toBe(true);
    expect(new Date(rows.cabinet_sessions?.[0]?.expiresAt as Date).getTime()).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60 * 1_000,
    );
  });

  it("answers whose session a cookie is before a slow key renewal finishes", async () => {
    // The scanner gives up on this question in seconds and a key renewal can
    // wait on the gateway for longer; an answer held for the renewal would
    // lose the browser its renewed cookie for a day (ADR-0026 §2).
    let release: () => void = () => undefined;
    const renewals: string[] = [];
    const slowRenewal = async (person: { email: string }) => {
      renewals.push(person.email);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const messages: Message[] = [];
    const { identity, rows } = identityWith(async (message) => {
      messages.push(message);
      return "accepted";
    });
    await identity.make(EMAIL, { id: "mer_owner", key: "the-owner-gateway-key" });
    await identity.requestLink(EMAIL, "default");
    const opened = await identity.openLink(tokenIn(messages[0] as Message));
    if (opened.status !== "opened") throw new Error("the sign-in link did not open");
    const cookie = opened.setCookies.map((line) => line.split(";")[0]).join("; ");
    const aDayAndAnHourAgo = Date.now() - 25 * 60 * 60 * 1_000;
    for (const session of rows.cabinet_sessions ?? []) {
      session.expiresAt = new Date(aDayAndAnHourAgo + 30 * 24 * 60 * 60 * 1_000);
    }
    const server = buildReportIdentityApp(SECRET, identity, slowRenewal).listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;

    const answered = await Promise.race([
      post(`http://127.0.0.1:${port}${REPORT_IDENTITY_PATH}`, {
        operation: "session",
        cookie,
        renew: true,
      }).then(async (response) => readSessionResponseSchema.parse(await response.json())),
      new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 2_000)),
    ]);

    release();
    expect(answered).not.toBe("held");
    if (answered === "held" || answered.status !== "signed_in") throw new Error("no answer");
    expect(answered.set_cookie.some((line) => line.startsWith(`${COOKIE}=`))).toBe(true);
    expect(renewals).toStrictEqual([EMAIL]);
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
      const response = await post(url, sendBody);
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { identityFor } from "./identity.js";
import type { Message } from "./mail.js";
import { cookieHeader, type GoogleProfile, googleExchange } from "./testing/google.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";

const config = loadConfig({
  DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
  AUTH_SECRET: TEST_AUTH_SECRET,
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "sandbox:scripted",
  GOOGLE_CLIENT_ID: "offline-client",
  GOOGLE_CLIENT_SECRET: "offline-secret",
});

function setup(overrides = {}) {
  const rows: Record<string, Record<string, unknown>[]> = {
    dashboard_accounts: [],
    dashboard_sessions: [],
    dashboard_credentials: [],
    dashboard_verifications: [],
    dashboard_link_sends: [],
  };
  const messages: Message[] = [];
  const identity = identityFor(
    { ...config, ...overrides },
    {
      rows,
      postman: async (message) => {
        messages.push(message);
        return "accepted";
      },
    },
  );
  const google = googleExchange();
  vi.stubGlobal("fetch", google.fetch);
  const start = async (profile: Partial<GoogleProfile> = {}) => {
    const began = await identity.startGoogle("settings");
    if (began.status !== "redirect") throw new Error("Google must be available");
    return {
      began,
      query: google.authorize(began.location, profile),
      cookie: cookieHeader(began.setCookies),
    };
  };
  const login = async (profile: Partial<GoogleProfile> = {}) => {
    const flow = await start(profile);
    return await identity.finishGoogle(flow.query, flow.cookie);
  };
  return { identity, rows, messages, google, start, login };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google dashboard identity", () => {
  it("keeps operator provisioning available without an OAuth request", async () => {
    const { identity } = setup();
    expect(await identity.make("operator-created@example.com", "mer_operator")).toMatchObject({
      email: "operator-created@example.com",
      confirmed: false,
    });
  });
  it("opens a verified person with the requested destination and an empty merchant name", async () => {
    const { login, identity, rows, google } = setup();
    const opened = await login();
    expect(opened).toMatchObject({
      status: "opened",
      destination: "settings",
      person: { email: "person@gmail.com", confirmed: true, merchant: null },
    });
    if (opened.status !== "opened") throw new Error("Google must open the person");
    expect(rows.dashboard_accounts?.[0]?.name).toBe("");
    expect(rows.dashboard_credentials).toHaveLength(1);
    expect(await identity.whoIs(cookieHeader(opened.setCookies))).toMatchObject({
      person: opened.person,
    });
    const stored = JSON.stringify(rows) + opened.setCookies.join(";");
    for (const token of google.issuedTokens) expect(stored).not.toContain(token);
  });

  it("uses the same trimmed lowercase email identity as the email-link path", async () => {
    const { login, rows } = setup();
    expect(await login({ email: " Person@Gmail.Com " })).toMatchObject({
      status: "opened",
      person: { email: "person@gmail.com" },
    });
    expect(rows.dashboard_accounts?.[0]?.email).toBe("person@gmail.com");
  });

  it("links the existing verified merchant and keeps the same person on repeat login without tokens", async () => {
    const { identity, login, rows, messages, google } = setup();
    await identity.requestLink("person@gmail.com", "default");
    const token = /token=([^\s]+)/.exec(messages[0]?.body ?? "")?.[1] ?? "";
    const linked = await identity.openLink(token);
    if (linked.status !== "opened") throw new Error("mail link must open");
    await identity.attachMerchant(linked.person.id, async () => "mer_google");
    const first = await login();
    const repeated = await login();
    for (const opened of [first, repeated])
      expect(opened).toMatchObject({
        status: "opened",
        person: { id: linked.person.id, merchant: { id: "mer_google" } },
      });
    expect(rows.dashboard_accounts).toHaveLength(1);
    expect(rows.dashboard_credentials).toHaveLength(1);
    const stored = JSON.stringify(rows) + JSON.stringify([first, repeated]);
    for (const tokenValue of google.issuedTokens) expect(stored).not.toContain(tokenValue);
  });

  it.each([
    { email: "reader@yandex.ru", email_verified: true },
    { email: "reader@gmail.com", email_verified: false },
    { email: "reader@company.example", email_verified: false, hd: "company.example" },
    { email: "reader@gmail.com.evil.example", email_verified: true },
  ])(
    "refuses unsupported or unverified Google email before creating a person: $email",
    async (profile) => {
      const { login, rows } = setup();
      expect(await login(profile)).toMatchObject({
        status: "refused",
        reason: "email-unverified",
        email: profile.email,
      });
      expect(rows.dashboard_accounts).toHaveLength(0);
      expect(rows.dashboard_sessions).toHaveLength(0);
      expect(rows.dashboard_credentials).toHaveLength(0);
    },
  );

  it.each(["reader@company.example", "reader@googlemail.com"])(
    "accepts a verified address Google controls: %s",
    async (email) => {
      const { login } = setup();
      expect(
        await login({
          email,
          ...(email.endsWith("company.example") ? { hd: "company.example" } : {}),
        }),
      ).toMatchObject({ status: "opened", person: { email } });
    },
  );

  it.each([
    { email: undefined },
    { email: "" },
    { sub: undefined },
    { sub: "" },
    { sub: 12 },
    { email_verified: undefined },
    { email_verified: "true" },
    { email: "reader@company.example", hd: true },
    { email: "reader@company.example", hd: "" },
    { email: "reader@company.example", hd: "not a domain" },
  ])("refuses absent or malformed required Google claims: %j", async (profile) => {
    const { login, rows } = setup();
    expect(await login(profile as Partial<GoogleProfile>)).toMatchObject({ status: "refused" });
    expect(rows.dashboard_accounts).toHaveLength(0);
    expect(rows.dashboard_sessions).toHaveLength(0);
    expect(rows.dashboard_credentials).toHaveLength(0);
  });

  it("refuses an already linked Workspace subject when its address loses Google's authority", async () => {
    const { login, rows } = setup();
    expect(await login({ email: "reader@company.example", hd: "company.example" })).toMatchObject({
      status: "opened",
    });
    expect(await login({ email: "reader@company.example" })).toMatchObject({
      status: "refused",
      reason: "email-unverified",
    });
    expect(rows.dashboard_sessions).toHaveLength(1);
  });

  it("rejects an already linked subject when Google stops verifying its address", async () => {
    const { login, rows } = setup();
    expect(await login()).toMatchObject({ status: "opened" });
    expect(await login({ email_verified: false })).toMatchObject({
      status: "refused",
      reason: "email-unverified",
    });
    expect(rows.dashboard_sessions).toHaveLength(1);
  });

  it("rejects a renamed linked subject rather than opening the account under another address", async () => {
    const { login, rows } = setup();
    expect(await login({ email: "old@company.example", hd: "company.example" })).toMatchObject({
      status: "opened",
    });
    expect(await login({ email: "new@company.example", hd: "company.example" })).toMatchObject({
      status: "refused",
      reason: "email-changed",
      email: "new@company.example",
    });
    expect(rows.dashboard_accounts?.[0]?.email).toBe("old@company.example");
    expect(rows.dashboard_sessions).toHaveLength(1);
  });

  it("keeps literal Gmail aliases distinct and does not merge accounts by guessing", async () => {
    const { login, rows } = setup();
    for (const [sub, email] of [
      ["one", "person@gmail.com"],
      ["two", "per.son+shop@gmail.com"],
    ]) {
      expect(await login({ sub, email })).toMatchObject({ status: "opened", person: { email } });
    }
    expect(rows.dashboard_accounts).toHaveLength(2);
  });

  it.each(["missing-cookie", "foreign-state", "missing-state"])(
    "refuses callback with %s and creates no identity",
    async (kind) => {
      const { start, identity, rows } = setup();
      const flow = await start();
      if (kind === "foreign-state") flow.query.set("state", "other-browser");
      if (kind === "missing-state") flow.query.delete("state");
      const result = await identity.finishGoogle(
        flow.query,
        kind === "missing-cookie" ? undefined : flow.cookie,
      );
      expect(result).toMatchObject({ status: "refused", reason: "invalid", email: null });
      expect(rows.dashboard_accounts).toHaveLength(0);
      expect(rows.dashboard_sessions).toHaveLength(0);
    },
  );

  it("consumes state once and refuses replay and authorization code reuse", async () => {
    const { start, identity, rows } = setup();
    const one = await start();
    expect(await identity.finishGoogle(one.query, one.cookie)).toMatchObject({ status: "opened" });
    expect(await identity.finishGoogle(one.query, one.cookie)).toMatchObject({
      status: "refused",
      reason: "invalid",
    });
    const two = await start();
    two.query.set("code", one.query.get("code") ?? "");
    expect(await identity.finishGoogle(two.query, two.cookie)).toMatchObject({
      status: "refused",
    });
    expect(rows.dashboard_sessions).toHaveLength(1);
  });

  it.each(["state", "code", "error", "both", "neither"])(
    "refuses ambiguous callback proof parameters: %s",
    async (kind) => {
      const { start, identity, rows } = setup();
      const flow = await start();
      const query = new URLSearchParams(flow.query);
      if (kind === "state") {
        query.delete("state");
        query.append("state", "unrelated-lock");
        query.append("state", flow.query.get("state") ?? "");
      }
      if (kind === "code") query.append("code", flow.query.get("code") ?? "");
      if (kind === "error") {
        query.delete("code");
        query.append("error", "access_denied");
        query.append("error", "access_denied");
      }
      if (kind === "both") query.append("error", "access_denied");
      if (kind === "neither") query.delete("code");
      expect(await identity.finishGoogle(query, flow.cookie)).toMatchObject({
        status: "refused",
        reason: "invalid",
        email: null,
      });
      expect(rows.dashboard_accounts).toHaveLength(0);
      expect(rows.dashboard_sessions).toHaveLength(0);
    },
  );

  it("returns a cancelled flow to the original destination without opening a session", async () => {
    const { start, identity, rows } = setup();
    const flow = await start();
    flow.query.delete("code");
    flow.query.set("error", "access_denied");
    expect(await identity.finishGoogle(flow.query, flow.cookie)).toMatchObject({
      status: "refused",
      reason: "cancelled",
      destination: "settings",
      email: null,
    });
    expect(rows.dashboard_sessions).toHaveLength(0);
  });

  it("refuses a Google outage without creating an identity", async () => {
    const { start, identity, rows, google } = setup();
    const flow = await start();
    google.goOffline();
    expect(await identity.finishGoogle(flow.query, flow.cookie)).toMatchObject({
      status: "refused",
      reason: "unavailable",
    });
    expect(rows.dashboard_accounts).toHaveLength(0);
    expect(rows.dashboard_sessions).toHaveLength(0);
  });

  it("has no Google entry when its credentials are absent", async () => {
    const { identity } = setup({ google: null });
    expect(identity.googleEnabled).toBe(false);
    expect(await identity.startGoogle("default")).toStrictEqual({ status: "unavailable" });
  });

  it("uses a host-protected state cookie in production and includes it in sign-out cleanup", async () => {
    const { identity } = setup({ cookieSecure: true, publicBaseUrl: "https://test.agentify.ad" });
    const started = await identity.startGoogle("orders");
    if (started.status !== "redirect") throw new Error("Google must be enabled");
    const state = started.setCookies.find((cookie) => cookie.startsWith("__Host-agentify.state="));
    expect(state).toMatch(/; Secure/i);
    expect(state).toMatch(/; HttpOnly/i);
    expect(state).toMatch(/; Path=\//i);
    expect(state).not.toMatch(/; Domain=/i);
    expect(identity.cookieNames).toContain("__Host-agentify.state");
    expect(new URL(started.location).searchParams.get("redirect_uri")).toBe(
      "https://test.agentify.ad/sign-in/google/callback",
    );
  });
});

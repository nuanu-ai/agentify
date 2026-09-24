import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { identityFor, LINK_MIN_INTERVAL_MS } from "./identity.js";
import type { Message } from "./mail.js";
import { rewindLinkSends } from "./testing/link-sends.js";

const EMAIL = "owner@example.com";
const SCAN = "019b41a0-7c51-7d63-84bd-a5a20faef497";
const REQUEST = "019b41a0-7c51-7d63-84bd-a5a20faef498";
const MERCHANT = { id: "mer_owner", key: "the-owner-gateway-key" };
const OPERATION_ONE = "019b41a0-7c51-7d63-84bd-a5a20faef497";
const OPERATION_TWO = "019b41a0-7c52-7d63-84bd-a5a20faef497";
const COOKIE = "__Host-agentify.session_token";

function config() {
  return loadConfig({
    DATABASE_URL: "postgres://unused.example/unused",
    AUTH_SECRET: "x".repeat(44),
    PAYMENT_NETWORK: "eip155:84532",
    FACILITATOR_URL: "sandbox:scripted",
    REGISTRATION_INVITATION: "the-existing-gateway-invitation",
    PUBLIC_BASE_URL: "https://agentify.ad",
    BASE_PATH: "/cabinet",
    COOKIE_SECURE: "true",
  });
}

function fixture(
  rows: Record<string, Record<string, unknown>[]> = {
    cabinet_accounts: [],
    cabinet_sessions: [],
    cabinet_credentials: [],
    cabinet_verifications: [],
    cabinet_link_sends: [],
    cabinet_report_deletion_tombstones: [],
  },
) {
  const messages: Message[] = [];
  const identity = identityFor(config(), {
    rows,
    postman: async (message) => {
      messages.push(message);
      return "accepted";
    },
  });
  return { identity, messages, rows };
}

function actionIn(message: Message): URL {
  const raw = message.body.match(/https?:\/\/\S+/)?.[0];
  if (raw === undefined) throw new Error("the message has no link");
  return new URL(raw);
}

/** The cookie header a browser holds after the press sets these lines. */
const cookieFrom = (lines: readonly string[]): string =>
  lines.map((line) => line.split(";")[0] ?? "").join("; ");

/**
 * A report link now, whatever this address asked for a moment ago.
 *
 * The door keeps a minute between two links to one address, and the tests
 * below are about what a link is worth once it arrives. So the sends already
 * recorded are moved back out of the way, the same minute a person would have
 * waited. The test that is about the walls asks for its links without this.
 */
async function sendReport(one: ReturnType<typeof fixture>, email = EMAIL) {
  rewindLinkSends(one.rows);
  const result = await one.identity.sendReportLink({
    operation: "send",
    email,
    destination: { report: SCAN },
    request: REQUEST,
  });
  if (result.status !== "accepted") throw new Error("the report link was not accepted");
  const action = actionIn(one.messages.at(-1) as Message);
  return { action, token: action.searchParams.get("token") ?? "" };
}

describe("a report link asked for by the scanner", () => {
  it("lands on the cabinet's one-control page and makes nobody until it is pressed", async () => {
    // Every link lands on the cabinet's page, and nothing in it but the token
    // is read: the destination and the request were recorded with the token
    // when the link was asked for (ADR-0026 §1).
    const one = fixture();
    const { action, token } = await sendReport(one);

    expect(one.messages[0]).toMatchObject({ to: EMAIL, subject: "Unlock your Agentify report" });
    expect(`${action.origin}${action.pathname}`).toBe("https://agentify.ad/cabinet/sign-in/open");
    expect([...action.searchParams.keys()]).toStrictEqual(["token"]);
    expect(action.hash).toBe("");
    expect(one.messages[0]?.body).not.toContain(SCAN);
    expect(one.messages[0]?.body).not.toContain(REQUEST);
    expect(await one.identity.byEmail(EMAIL)).toBeNull();
    expect(await one.identity.addressOfLink(token)).toBe(EMAIL);
  });

  it("opens a session that leads to the report and names the request its link was asked for", async () => {
    const one = fixture();
    const { token } = await sendReport(one);

    const opened = await one.identity.openLink(token);

    if (opened.status !== "opened") throw new Error("the report link did not open");
    expect(opened.destination).toStrictEqual({ report: SCAN });
    expect(opened.person).toMatchObject({ email: EMAIL, merchant: null, confirmed: true });
    const session = await one.identity.whoIs(cookieFrom(opened.setCookies));
    expect(session?.person.email).toBe(EMAIL);
    expect(session?.request).toBe(REQUEST);
    // Spent by that one press.
    expect(await one.identity.openLink(token)).toStrictEqual({ status: "refused" });
    expect(await one.identity.addressOfLink(token)).toBeNull();
  });

  it("names no request for a session its own sign-in opened", async () => {
    // A request is finished only by the session its own link opened; a
    // session opened from the sign-in page carries none, so it cannot finish
    // a request somebody else made with this address (ADR-0026 §2).
    const one = fixture();
    await sendReport(one);
    rewindLinkSends(one.rows);
    await one.identity.requestLink(EMAIL, "default");
    const signIn = actionIn(one.messages.at(-1) as Message).searchParams.get("token") ?? "";

    const opened = await one.identity.openLink(signIn);

    if (opened.status !== "opened") throw new Error("the sign-in link did not open");
    expect(opened.destination).toBe("default");
    expect((await one.identity.whoIs(cookieFrom(opened.setCookies)))?.request).toBeNull();
  });

  it("reads a session without moving its end when asked not to renew", async () => {
    const one = fixture();
    const { token } = await sendReport(one);
    const opened = await one.identity.openLink(token);
    if (opened.status !== "opened") throw new Error("the report link did not open");
    const aDayAndAnHourAgo = Date.now() - 25 * 60 * 60 * 1_000;
    for (const session of one.rows.cabinet_sessions ?? []) {
      session.expiresAt = new Date(aDayAndAnHourAgo + 30 * 24 * 60 * 60 * 1_000);
    }
    const before = structuredClone(one.rows.cabinet_sessions);

    const read = await one.identity.whoIs(cookieFrom(opened.setCookies), { renew: false });

    expect(read?.person.email).toBe(EMAIL);
    expect(read?.setCookies).toStrictEqual([]);
    expect(one.rows.cabinet_sessions).toStrictEqual(before);

    const renewed = await one.identity.whoIs(cookieFrom(opened.setCookies));
    expect(renewed?.setCookies.some((line) => line.startsWith(`${COOKIE}=`))).toBe(true);
  });

  it("keeps the same minute between two report links that the cabinet's door keeps", async () => {
    const one = fixture();
    const ask = async () =>
      await one.identity.sendReportLink({
        operation: "send",
        email: EMAIL,
        destination: { report: SCAN },
        request: REQUEST,
      });
    await expect(ask()).resolves.toMatchObject({ status: "accepted" });

    const again = await ask();

    // One rule, two doors: a second link inside the minute is refused, sends
    // nothing, and spends none of the three the hour allows.
    expect(again).toMatchObject({ status: "cooldown", retry_at: expect.any(String) });
    expect(one.messages).toHaveLength(1);
    expect(one.rows.cabinet_link_sends).toHaveLength(1);
    if (again.status !== "cooldown") throw new Error("the second report link should be refused");
    const owed = new Date(again.retry_at).getTime() - Date.now();
    expect(owed).toBeGreaterThan(0);
    expect(owed).toBeLessThanOrEqual(LINK_MIN_INTERVAL_MS);
  });

  it("limits report sends independently without storing the raw address as rate evidence", async () => {
    const one = fixture();
    for (let count = 0; count < 3; count += 1) {
      await sendReport(one);
    }
    rewindLinkSends(one.rows);
    await expect(
      one.identity.sendReportLink({
        operation: "send",
        email: EMAIL,
        destination: { report: SCAN },
        request: REQUEST,
      }),
    ).resolves.toMatchObject({ status: "cooldown", retry_at: expect.any(String) });
    await expect(one.identity.requestLink(EMAIL, "default")).resolves.toStrictEqual({
      status: "accepted",
      retryAt: expect.any(Date),
    });
    expect(JSON.stringify(one.rows.cabinet_link_sends)).not.toContain(EMAIL);
  });
});

describe("a privacy deletion asked for by the scanner", () => {
  it("removes a person who owns no merchant with their sessions, and keeps one who owns one", async () => {
    const p1 = fixture();
    const p1Link = await sendReport(p1);
    const opened = await p1.identity.openLink(p1Link.token);
    if (opened.status !== "opened") throw new Error("the report link did not open");
    await expect(
      p1.identity.deleteUnattachedPerson({
        operation: "delete",
        operation_id: OPERATION_ONE,
        email: EMAIL,
      }),
    ).resolves.toStrictEqual({ status: "deleted" });
    expect(await p1.identity.byEmail(EMAIL)).toBeNull();
    expect(await p1.identity.whoIs(cookieFrom(opened.setCookies))).toBeNull();

    const p2 = fixture();
    await p2.identity.make(EMAIL, MERCHANT);
    const unconsumed = await sendReport(p2);
    await expect(
      p2.identity.deleteUnattachedPerson({
        operation: "delete",
        operation_id: OPERATION_TWO,
        email: EMAIL,
      }),
    ).resolves.toStrictEqual({ status: "retained" });
    expect(await p2.identity.byEmail(EMAIL)).toMatchObject({ merchant: MERCHANT });
    // The report link still in the mailbox leads nowhere once the reports it
    // was for are being deleted.
    expect(await p2.identity.openLink(unconsumed.token)).toStrictEqual({ status: "refused" });
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

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import type { DashboardIdentity } from "./dashboard-entry.js";
import {
  identityFor,
  LINK_CHANNEL_LIMIT,
  LINK_CLIENT_LIMIT,
  LINK_MIN_INTERVAL_MS,
  LINK_RATE_WINDOW_MS,
} from "./identity.js";
import type { Message } from "./mail.js";
import { ONE_CLIENT, rewindLinkSends } from "./testing/link-sends.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";

const SETTINGS = {
  DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
  AUTH_SECRET: TEST_AUTH_SECRET,
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "sandbox:scripted",
} as const;
const config = loadConfig(SETTINGS);
/** A laptop's dashboard with the report switched on, posting to a receiver of its own. */
const reporting = loadConfig({
  ...SETTINGS,
  REGISTRATION_POSTBACK_ENABLED: "true",
  REGISTRATION_POSTBACK_KEY: ["qa", "synthetic", "postback", "key"].join("-"),
  REGISTRATION_POSTBACK_URL: "http://127.0.0.1:4010/postback",
});

type MemoryRows = Record<string, Record<string, unknown>[]>;

/** `rows` shares another identity's store, as two processes share a database. */
function memoryIdentity(
  handed: "accepted" | "refused" = "accepted",
  configured = config,
  rows: MemoryRows = {
    dashboard_accounts: [],
    dashboard_sessions: [],
    dashboard_credentials: [],
    dashboard_verifications: [],
    dashboard_link_sends: [],
  },
) {
  const messages: Message[] = [];
  const store = identityFor(configured, {
    rows,
    postman: async (message) => {
      messages.push(message);
      return handed;
    },
  });
  return { identity: store as unknown as DashboardIdentity, messages, rows, store };
}

function tokenIn(message: Message): string {
  const found = /https?:\/\/\S+\/sign-in\/open\?token=([^\s]+)/.exec(message.body)?.[1];
  if (found === undefined) throw new Error("the dashboard link was not in the message");
  return decodeURIComponent(found);
}

function linkIn(message: Message): string {
  const found = /https?:\/\/\S+\/sign-in\/open\?token=[^\s]+/.exec(message.body)?.[0];
  if (found === undefined) throw new Error("the dashboard link was not in the message");
  return found;
}

describe("dashboard magic links", () => {
  it("tells the person what the link does, how long it lasts, and carries it on a line of its own", async () => {
    const { identity, messages } = memoryIdentity();

    await identity.requestLink("person@example.com", "default", ONE_CLIENT);

    const message = messages[0] as Message;
    expect(message.subject).toMatch(/sign in/i);
    // A client that draws no button leaves the plain text, and a URL sharing a
    // line with words is a URL somebody copies half of.
    expect(message.body.split("\n")).toContain(linkIn(message));
    for (const said of [message.body, message.html]) {
      expect(said).toMatch(/opens once/i);
      expect(said).toMatch(/expires an hour after it was sent/i);
    }
  });

  it("keeps two links independent and creates a person only when each is opened", async () => {
    const { identity, messages, rows } = memoryIdentity();

    await expect(
      identity.requestLink(" Person@Example.com ", "default", ONE_CLIENT),
    ).resolves.toStrictEqual({
      status: "accepted",
      retryAt: expect.any(Date),
    });
    rewindLinkSends(rows);
    await expect(
      identity.requestLink("person@example.com", "settings", ONE_CLIENT),
    ).resolves.toStrictEqual({
      status: "accepted",
      retryAt: expect.any(Date),
    });

    expect(rows.dashboard_accounts).toHaveLength(0);
    expect(rows.dashboard_sessions).toHaveLength(0);
    expect(messages).toHaveLength(2);
    const firstToken = tokenIn(messages[0] as Message);
    const secondToken = tokenIn(messages[1] as Message);
    expect(firstToken).not.toBe(secondToken);
    expect(rows.dashboard_verifications?.map((row) => row.identifier)).toStrictEqual([
      createHash("sha256").update(firstToken).digest("base64url"),
      createHash("sha256").update(secondToken).digest("base64url"),
    ]);

    const first = await identity.openLink(firstToken);
    expect(first).toMatchObject({
      status: "opened",
      destination: "default",
      person: { email: "person@example.com", confirmed: true, merchant: null },
    });
    expect(rows.dashboard_accounts).toHaveLength(1);
    expect(rows.dashboard_sessions).toHaveLength(1);

    await expect(identity.openLink(firstToken)).resolves.toStrictEqual({ status: "refused" });

    const second = await identity.openLink(secondToken);
    expect(second).toMatchObject({
      status: "opened",
      destination: "settings",
      person: { id: first.status === "opened" ? first.person.id : "wrong person" },
    });
    expect(rows.dashboard_accounts).toHaveLength(1);
    expect(rows.dashboard_sessions).toHaveLength(2);
  });

  it("sends nothing and spends nothing when a second link is asked for inside the minute", async () => {
    const { identity, messages, rows } = memoryIdentity();
    await expect(
      identity.requestLink("person@example.com", "default", ONE_CLIENT),
    ).resolves.toStrictEqual({
      status: "accepted",
      retryAt: expect.any(Date),
    });
    const sentAt = new Date(rows.dashboard_link_sends?.[0]?.sentAt as Date);

    const refused = await identity.requestLink("person@example.com", "default", ONE_CLIENT);

    expect(refused).toStrictEqual({
      status: "cooldown",
      wall: "interval",
      retryAt: new Date(sentAt.getTime() + LINK_MIN_INTERVAL_MS),
    });
    expect(messages).toHaveLength(1);
    // A request the minute refused was never a send, so it may not count toward
    // the hourly limit.
    expect(rows.dashboard_link_sends).toHaveLength(1);
  });

  it("answers an accepted link with the wait in front of the next one, which after the third is the hour", async () => {
    const { identity, rows } = memoryIdentity();

    const first = await identity.requestLink("person@example.com", "default", ONE_CLIENT);
    const firstSentAt = new Date(rows.dashboard_link_sends?.[0]?.sentAt as Date);
    expect(first).toStrictEqual({
      status: "accepted",
      retryAt: new Date(firstSentAt.getTime() + LINK_MIN_INTERVAL_MS),
    });

    rewindLinkSends(rows);
    await identity.requestLink("person@example.com", "default", ONE_CLIENT);
    rewindLinkSends(rows);
    const third = await identity.requestLink("person@example.com", "default", ONE_CLIENT);

    // The third link spends the hour's allowance; an answer still saying "a
    // minute" would bring the person back in sixty seconds to a refusal for the
    // rest of the hour.
    const oldest = new Date(rows.dashboard_link_sends?.[0]?.sentAt as Date);
    expect(third).toStrictEqual({
      status: "accepted",
      retryAt: new Date(oldest.getTime() + LINK_RATE_WINDOW_MS),
    });
    if (third.status !== "accepted") throw new Error("the third link should have gone out");
    expect(third.retryAt.getTime() - Date.now()).toBeGreaterThan(LINK_MIN_INTERVAL_MS);
  });

  it("lets the next link out once the minute has passed and still stops at three in the hour", async () => {
    const { identity, messages, rows } = memoryIdentity();

    for (let sent = 0; sent < 3; sent += 1) {
      await expect(
        identity.requestLink("person@example.com", "default", ONE_CLIENT),
      ).resolves.toStrictEqual({
        status: "accepted",
        retryAt: expect.any(Date),
      });
      rewindLinkSends(rows);
    }

    expect(messages).toHaveLength(3);
    const oldest = new Date(rows.dashboard_link_sends?.[0]?.sentAt as Date);
    await expect(
      identity.requestLink("person@example.com", "default", ONE_CLIENT),
    ).resolves.toStrictEqual({
      status: "cooldown",
      wall: "hourly",
      retryAt: new Date(oldest.getTime() + LINK_RATE_WINDOW_MS),
    });
    expect(messages).toHaveLength(3);
    expect(rows.dashboard_link_sends).toHaveLength(3);
  });

  it("names the hourly wall, not the minute, when waiting out the minute would change nothing", async () => {
    const { identity, rows } = memoryIdentity();
    for (let sent = 0; sent < 3; sent += 1) {
      await identity.requestLink("person@example.com", "default", ONE_CLIENT);
      if (sent < 2) rewindLinkSends(rows);
    }

    // Both limits stand, and the answer names the later one: told "forty
    // seconds", a person presses in forty seconds and is refused for another
    // hour.
    const refused = await identity.requestLink("person@example.com", "default", ONE_CLIENT);

    expect(refused).toMatchObject({ status: "cooldown", wall: "hourly" });
    if (refused.status !== "cooldown") throw new Error("the fourth link should be refused");
    expect(refused.retryAt.getTime() - Date.now()).toBeGreaterThan(LINK_MIN_INTERVAL_MS);
  });

  it("keeps the Woo destination inside the one-time dashboard claim", async () => {
    const { identity, messages } = memoryIdentity();
    await identity.requestLink("person@example.com", "woocommerce", ONE_CLIENT);

    const opened = await identity.openLink(tokenIn(messages[0] as Message));

    expect(opened).toMatchObject({ status: "opened", destination: "woocommerce" });
  });

  it("refuses a token whose recorded destination is outside the closed set, spending nothing", async () => {
    // A row naming a destination outside the closed set was not written by the
    // dashboard, and opens nothing rather than sending somebody where it says.
    const { identity, messages, rows } = memoryIdentity();
    await identity.requestLink("person@example.com", "default", ONE_CLIENT);
    const token = tokenIn(messages[0] as Message);

    for (const destination of [
      "https://evil.example/",
      { url: "https://evil.example/" },
      { report: "not-a-scan" },
      { report: "019b41a0-7c51-7d63-84bd-a5a20faef497", also: "settings" },
    ]) {
      // Read afresh: every call replaces the stored rows with its transaction's
      // copy, so a row held from before the first call is no longer stored.
      const verification = rows.dashboard_verifications?.[0];
      if (verification === undefined) throw new Error("the link was not stored");
      verification.value = JSON.stringify({ email: "person@example.com", destination });

      await expect(identity.openLink(token)).resolves.toStrictEqual({ status: "refused" });
      expect(await identity.landingOf(token)).toBeNull();
      expect(rows.dashboard_verifications).toHaveLength(1);
      expect(rows.dashboard_accounts).toHaveLength(0);
      expect(rows.dashboard_sessions).toHaveLength(0);
    }
  });

  it("removes another address's unpressed link a week past its end when a link is asked for, and keeps a younger one", async () => {
    // An unpressed link keeps an address and whatever its claim carries, such
    // as an ad's click, until something removes it.
    const { identity, rows } = memoryIdentity();
    const aWeek = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const unpressed = (id: string, expiresAt: Date) => ({
      id,
      identifier: id,
      value: JSON.stringify({ email: "other@example.com", destination: "default", request: null }),
      expiresAt,
      createdAt: new Date(expiresAt.getTime() - 60 * 60 * 1000),
      updatedAt: new Date(expiresAt.getTime() - 60 * 60 * 1000),
    });
    rows.dashboard_verifications = [
      unpressed("younger", new Date(now - aWeek + 60_000)),
      unpressed("older", new Date(now - aWeek - 1)),
    ];

    await identity.requestLink("person@example.com", "default", ONE_CLIENT);

    const kept = rows.dashboard_verifications?.map((row) => row.id) ?? [];
    expect(kept).toContain("younger");
    expect(kept).not.toContain("older");
    expect(kept).toHaveLength(2);
  });

  it("still removes week-old unpressed links when the mail provider refuses the link asked for", async () => {
    // The sweep is not the request's to undo: it runs before the mail is
    // tried, on its own.
    const { identity, rows } = memoryIdentity("refused");
    const aWeek = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const unpressed = (id: string, expiresAt: Date) => ({
      id,
      identifier: id,
      value: JSON.stringify({ email: "other@example.com", destination: "default", request: null }),
      expiresAt,
      createdAt: new Date(expiresAt.getTime() - 60 * 60 * 1000),
      updatedAt: new Date(expiresAt.getTime() - 60 * 60 * 1000),
    });
    rows.dashboard_verifications = [
      unpressed("younger", new Date(now - aWeek + 60_000)),
      unpressed("older", new Date(now - aWeek - 1)),
    ];

    await expect(
      identity.requestLink("person@example.com", "default", ONE_CLIENT),
    ).resolves.toStrictEqual({
      status: "unavailable",
    });

    expect(rows.dashboard_verifications?.map((row) => row.id)).toStrictEqual(["younger"]);
  });

  it("keeps no token or rate event when the mail provider refuses the message", async () => {
    const { identity, rows } = memoryIdentity("refused");

    await expect(
      identity.requestLink("person@example.com", "default", ONE_CLIENT),
    ).resolves.toStrictEqual({
      status: "unavailable",
    });
    expect(rows.dashboard_verifications).toHaveLength(0);
    expect(rows.dashboard_link_sends).toHaveLength(0);
    expect(rows.dashboard_accounts).toHaveLength(0);
  });

  it("refuses an empty merchant instead of hiding corrupt data as P1", async () => {
    const { store, rows } = memoryIdentity();
    rows.dashboard_accounts?.push({
      id: "person_corrupt",
      email: "person@example.com",
      emailVerified: true,
      name: "",
      createdAt: new Date(),
      updatedAt: new Date(),
      merchantId: "",
    });

    await expect(store.byEmail("person@example.com")).rejects.toThrow(
      "dashboard_account_unreadable_merchant",
    );
  });
});

describe("sign-in links counted per client and across the channel", () => {
  /** Documentation addresses: none of them is anybody's. */
  const CROWDED = { client: "198.51.100.7" };
  const ELSEWHERE = { client: "198.51.100.8" };
  const clientOf = (sent: number) => ({
    client: `203.0.113.${Math.floor(sent / LINK_CLIENT_LIMIT)}`,
  });

  it("refuses a client's link past its hourly allowance, sending and counting nothing, while another client still gets one", async () => {
    const { identity, messages, rows } = memoryIdentity();
    for (let sent = 0; sent < LINK_CLIENT_LIMIT; sent += 1) {
      await expect(
        identity.requestLink(`person-${sent}@example.com`, "default", CROWDED),
      ).resolves.toMatchObject({ status: "accepted" });
    }
    const oldest = new Date(rows.dashboard_link_sends?.[0]?.sentAt as Date);

    const refused = await identity.requestLink("one-more@example.com", "default", CROWDED);

    expect(refused).toStrictEqual({
      status: "cooldown",
      wall: "client",
      retryAt: new Date(oldest.getTime() + LINK_RATE_WINDOW_MS),
    });
    expect(messages).toHaveLength(LINK_CLIENT_LIMIT);
    expect(rows.dashboard_link_sends).toHaveLength(LINK_CLIENT_LIMIT);
    await expect(
      identity.requestLink("one-more@example.com", "default", ELSEWHERE),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(messages.at(-1)?.to).toBe("one-more@example.com");
  });

  it("lets a client's links out again once its hour has passed", async () => {
    const { identity, rows } = memoryIdentity();
    for (let sent = 0; sent < LINK_CLIENT_LIMIT; sent += 1) {
      await identity.requestLink(`person-${sent}@example.com`, "default", CROWDED);
    }
    expect(await identity.requestLink("one-more@example.com", "default", CROWDED)).toMatchObject({
      status: "cooldown",
      wall: "client",
    });

    rewindLinkSends(rows, LINK_RATE_WINDOW_MS);

    await expect(
      identity.requestLink("one-more@example.com", "default", CROWDED),
    ).resolves.toMatchObject({ status: "accepted" });
  });

  it("refuses every client and address once the channel has sent its hour's links, and lets them out once the hour has passed", async () => {
    const { identity, messages, rows } = memoryIdentity();
    for (let sent = 0; sent < LINK_CHANNEL_LIMIT; sent += 1) {
      await expect(
        identity.requestLink(`person-${sent}@example.com`, "default", clientOf(sent)),
      ).resolves.toMatchObject({ status: "accepted" });
    }
    const oldest = new Date(rows.dashboard_link_sends?.[0]?.sentAt as Date);

    for (const [email, asker] of [
      ["fresh@example.com", ELSEWHERE],
      ["person-0@example.com", CROWDED],
    ] as const) {
      await expect(identity.requestLink(email, "default", asker)).resolves.toStrictEqual({
        status: "cooldown",
        wall: "ceiling",
        retryAt: new Date(oldest.getTime() + LINK_RATE_WINDOW_MS),
      });
    }
    expect(messages).toHaveLength(LINK_CHANNEL_LIMIT);
    expect(rows.dashboard_link_sends).toHaveLength(LINK_CHANNEL_LIMIT);

    rewindLinkSends(rows, LINK_RATE_WINDOW_MS);

    await expect(
      identity.requestLink("fresh@example.com", "default", ELSEWHERE),
    ).resolves.toMatchObject({ status: "accepted" });
  });

  /**
   * What an ingress in front of the edge, a proxy on the way or an unreadable
   * header leaves in place of a visitor's address.
   */
  const NOT_A_VISITOR = [
    "10.20.10.11",
    "::ffff:10.20.10.11",
    "172.16.4.2",
    "192.168.1.20",
    "100.64.0.9",
    "127.0.0.1",
    "::1",
    "169.254.10.1",
    "fe80::1",
    "fd00::5",
    "unknown",
  ];

  it.each(NOT_A_VISITOR)(
    "does not limit visitors arriving through %s together as one client",
    async (client) => {
      const { identity, messages } = memoryIdentity();

      for (let sent = 0; sent <= LINK_CLIENT_LIMIT; sent += 1) {
        await expect(
          identity.requestLink(`visitor-${sent}@example.com`, "default", { client }),
        ).resolves.toMatchObject({ status: "accepted" });
      }

      expect(messages).toHaveLength(LINK_CLIENT_LIMIT + 1);
    },
  );

  it("still stops visitors arriving through one private proxy address at the channel's ceiling", async () => {
    const { identity, messages } = memoryIdentity();
    const proxy = { client: "::ffff:10.20.10.11" };
    for (let sent = 0; sent < LINK_CHANNEL_LIMIT; sent += 1) {
      await identity.requestLink(`visitor-${sent}@example.com`, "default", proxy);
    }
    expect(messages).toHaveLength(LINK_CHANNEL_LIMIT);

    await expect(
      identity.requestLink("one-more@example.com", "default", proxy),
    ).resolves.toMatchObject({ status: "cooldown", wall: "ceiling" });
    expect(messages).toHaveLength(LINK_CHANNEL_LIMIT);
  });

  it("keeps an address to one link a minute and three an hour behind a private proxy address too", async () => {
    const { identity, rows } = memoryIdentity();
    const proxy = { client: "10.20.10.11" };
    await identity.requestLink("person@example.com", "default", proxy);
    await expect(
      identity.requestLink("person@example.com", "default", proxy),
    ).resolves.toMatchObject({ status: "cooldown", wall: "interval" });
    for (let sent = 0; sent < 2; sent += 1) {
      rewindLinkSends(rows);
      await identity.requestLink("person@example.com", "default", proxy);
    }
    rewindLinkSends(rows);
    await expect(
      identity.requestLink("person@example.com", "default", proxy),
    ).resolves.toMatchObject({ status: "cooldown", wall: "hourly" });
  });

  it("keeps an address to one link a minute and three an hour whichever client asks", async () => {
    const { identity, messages, rows } = memoryIdentity();
    await identity.requestLink("person@example.com", "default", { client: "192.0.2.1" });

    await expect(
      identity.requestLink("person@example.com", "default", { client: "192.0.2.2" }),
    ).resolves.toMatchObject({ status: "cooldown", wall: "interval" });
    for (const client of ["192.0.2.3", "192.0.2.4"]) {
      rewindLinkSends(rows);
      await expect(
        identity.requestLink("person@example.com", "default", { client }),
      ).resolves.toMatchObject({ status: "accepted" });
    }
    rewindLinkSends(rows);
    await expect(
      identity.requestLink("person@example.com", "default", { client: "192.0.2.5" }),
    ).resolves.toMatchObject({ status: "cooldown", wall: "hourly" });
    expect(messages).toHaveLength(3);
  });

  it("names the client's hour, not the address's minute, when waiting out the minute would change nothing", async () => {
    const { identity } = memoryIdentity();
    await identity.requestLink("person@example.com", "default", ELSEWHERE);
    for (let sent = 0; sent < LINK_CLIENT_LIMIT; sent += 1) {
      await identity.requestLink(`person-${sent}@example.com`, "default", CROWDED);
    }

    const refused = await identity.requestLink("person@example.com", "default", CROWDED);

    expect(refused).toMatchObject({ status: "cooldown", wall: "client" });
    if (refused.status !== "cooldown") throw new Error("the link should be refused");
    expect(refused.retryAt.getTime() - Date.now()).toBeGreaterThan(LINK_MIN_INTERVAL_MS);
  });

  it("refuses report links once the channel has sent its hour's report links, and sign-in links still go", async () => {
    const { identity, messages, store } = memoryIdentity();
    const report = (email: string) =>
      store.sendReportLink({
        operation: "send",
        email,
        destination: { report: "019b41a0-7c51-7d63-84bd-a5a20faef497" },
        request: "019b41a0-7c51-7d63-84bd-a5a20faef498",
      });
    for (let sent = 0; sent < LINK_CHANNEL_LIMIT; sent += 1) {
      await expect(report(`reader-${sent}@example.com`)).resolves.toStrictEqual({
        status: "accepted",
      });
    }

    await expect(report("one-more@example.com")).resolves.toMatchObject({
      status: "cooldown",
      retry_at: expect.any(String),
    });
    expect(messages).toHaveLength(LINK_CHANNEL_LIMIT);
    await expect(
      identity.requestLink("person@example.com", "default", ONE_CLIENT),
    ).resolves.toMatchObject({ status: "accepted" });
  });
});

/**
 * Synthetic: each passes the partner click identifier's pattern and was never
 * issued by any tracker.
 */
const CLICK = "qa_click_0123456789abcdef";
const ANOTHER_CLICK = "qa_click_fedcba9876543210";
const SCAN = "019b41a0-7c51-7d63-84bd-a5a20faef497";
const REQUEST = "019b41a0-7c51-7d63-84bd-a5a20faef498";
const OPERATION = "019b41a0-7c51-7d63-84bd-a5a20faef497";

const registrationsIn = (rows: Record<string, Record<string, unknown>[]>) =>
  rows.dashboard_registration_postbacks ?? [];

describe("the registration a link asked for with an ad's click leaves for the tracker", () => {
  it("leaves one pending registration holding the click, and nothing else of the sign-in, when the link makes a new address's account", async () => {
    const { identity, messages, rows } = memoryIdentity("accepted", reporting);
    await identity.requestLink("person@example.com", "default", { ...ONE_CLIENT, clickId: CLICK });
    const pressedAt = Date.now();

    const opened = await identity.openLink(tokenIn(messages[0] as Message));

    if (opened.status !== "opened") throw new Error("the link did not open");
    expect(opened.person).toMatchObject({ email: "person@example.com", confirmed: true });
    expect(registrationsIn(rows)).toStrictEqual([
      {
        accountId: opened.person.id,
        clickId: CLICK,
        state: "pending",
        attempts: 0,
        nextAttemptAt: expect.any(Date),
        lastOutcome: null,
        createdAt: expect.any(Date),
        settledAt: null,
      },
    ]);
    const registration = registrationsIn(rows)[0];
    // Due at once: nothing about a new registration is worth waiting for.
    const due = new Date(registration?.nextAttemptAt as Date).getTime();
    expect(due).toBeGreaterThanOrEqual(pressedAt);
    expect(due).toBeLessThanOrEqual(Date.now());
  });

  it("writes no registration when the link asked for while reporting was on is opened after it went off", async () => {
    // Switched off, nothing about a click is kept past the press, whatever the
    // link was asked for with.
    const on = memoryIdentity("accepted", reporting);
    await on.identity.requestLink("person@example.com", "default", {
      ...ONE_CLIENT,
      clickId: CLICK,
    });
    const off = memoryIdentity("accepted", config, on.rows);

    const opened = await off.identity.openLink(tokenIn(on.messages[0] as Message));

    expect(opened).toMatchObject({ status: "opened", person: { confirmed: true } });
    expect(registrationsIn(on.rows)).toStrictEqual([]);
  });

  it("refuses to send a link carrying a click it could not read back, and sends or counts nothing", async () => {
    // The page checks the identifier before passing it; a click that reaches
    // this far malformed is a defect, and a link carrying it would open nothing.
    const { identity, messages, rows } = memoryIdentity("accepted", reporting);

    await expect(
      identity.requestLink("person@example.com", "default", {
        ...ONE_CLIENT,
        clickId: "too-short",
      }),
    ).rejects.toThrow();

    expect(messages).toHaveLength(0);
    expect(rows.dashboard_verifications).toHaveLength(0);
    expect(rows.dashboard_link_sends).toHaveLength(0);
  });

  it("leaves no registration when the link was asked for without a click", async () => {
    const { identity, messages, rows } = memoryIdentity("accepted", reporting);
    await identity.requestLink("person@example.com", "default", ONE_CLIENT);

    await expect(identity.openLink(tokenIn(messages[0] as Message))).resolves.toMatchObject({
      status: "opened",
      person: { confirmed: true },
    });

    expect(rows.dashboard_accounts).toHaveLength(1);
    expect(registrationsIn(rows)).toStrictEqual([]);
  });

  it("writes no registration for an address that already has a verified account, even with a fresh click", async () => {
    const { identity, messages, rows } = memoryIdentity("accepted", reporting);
    await identity.requestLink("person@example.com", "default", ONE_CLIENT);
    await identity.openLink(tokenIn(messages[0] as Message));
    rewindLinkSends(rows);
    await identity.requestLink("person@example.com", "default", { ...ONE_CLIENT, clickId: CLICK });

    await expect(identity.openLink(tokenIn(messages[1] as Message))).resolves.toMatchObject({
      status: "opened",
    });

    expect(rows.dashboard_accounts).toHaveLength(1);
    expect(registrationsIn(rows)).toStrictEqual([]);
  });

  it("writes one registration for an address whose only account the operator made unverified, at its first verification", async () => {
    const { identity, messages, rows, store } = memoryIdentity("accepted", reporting);
    const made = await store.make("person@example.com", "mer_made");
    if (made === null) throw new Error("the account was not made");
    await identity.requestLink("person@example.com", "default", { ...ONE_CLIENT, clickId: CLICK });

    await expect(identity.openLink(tokenIn(messages[0] as Message))).resolves.toMatchObject({
      status: "opened",
      person: { id: made.id, confirmed: true, merchant: { id: "mer_made" } },
    });

    expect(registrationsIn(rows)).toMatchObject([{ accountId: made.id, clickId: CLICK }]);
    expect(registrationsIn(rows)).toHaveLength(1);
  });

  it("writes nothing for a token that opens nothing: malformed, unknown or expired", async () => {
    const { identity, messages, rows } = memoryIdentity("accepted", reporting);
    await identity.requestLink("person@example.com", "default", { ...ONE_CLIENT, clickId: CLICK });
    const verification = rows.dashboard_verifications?.[0];
    if (verification === undefined) throw new Error("the link was not stored");
    verification.expiresAt = new Date(Date.now() - 1000);

    for (const token of ["short", "A".repeat(32), tokenIn(messages[0] as Message)]) {
      await expect(identity.openLink(token)).resolves.toStrictEqual({ status: "refused" });
    }

    expect(rows.dashboard_accounts).toHaveLength(0);
    expect(rows.dashboard_sessions).toHaveLength(0);
    expect(registrationsIn(rows)).toStrictEqual([]);
  });

  it("leaves one registration when the same link is opened twice", async () => {
    const { identity, messages, rows } = memoryIdentity("accepted", reporting);
    await identity.requestLink("person@example.com", "default", { ...ONE_CLIENT, clickId: CLICK });
    const token = tokenIn(messages[0] as Message);

    await expect(identity.openLink(token)).resolves.toMatchObject({ status: "opened" });
    await expect(identity.openLink(token)).resolves.toStrictEqual({ status: "refused" });

    expect(registrationsIn(rows)).toHaveLength(1);
  });

  it("writes nothing when the landing page reads a link asked for with a click", async () => {
    const { identity, messages, rows } = memoryIdentity("accepted", reporting);
    await identity.requestLink("person@example.com", "default", { ...ONE_CLIENT, clickId: CLICK });

    expect(await identity.landingOf(tokenIn(messages[0] as Message))).toStrictEqual({
      email: "person@example.com",
    });

    expect(rows.dashboard_accounts).toHaveLength(0);
    expect(rows.dashboard_verifications).toHaveLength(1);
    expect(registrationsIn(rows)).toStrictEqual([]);
  });

  it("writes no registration for a report link opened by a new address", async () => {
    const { messages, rows, store } = memoryIdentity("accepted", reporting);
    await store.sendReportLink({
      operation: "send",
      email: "person@example.com",
      destination: { report: SCAN },
      request: REQUEST,
    });

    await expect(store.openLink(tokenIn(messages[0] as Message))).resolves.toMatchObject({
      status: "opened",
      person: { confirmed: true },
    });

    expect(rows.dashboard_accounts).toHaveLength(1);
    expect(registrationsIn(rows)).toStrictEqual([]);
  });

  it("adds no registration and leaves the existing one as it was when a merchant is attached afterwards", async () => {
    const { identity, messages, rows } = memoryIdentity("accepted", reporting);
    await identity.requestLink("person@example.com", "default", { ...ONE_CLIENT, clickId: CLICK });
    const opened = await identity.openLink(tokenIn(messages[0] as Message));
    if (opened.status !== "opened") throw new Error("the link did not open");
    const before = structuredClone(registrationsIn(rows));

    await expect(
      identity.attachMerchant(opened.person.id, async () => "mer_attached"),
    ).resolves.toMatchObject({ status: "attached" });

    expect(before).toHaveLength(1);
    expect(registrationsIn(rows)).toStrictEqual(before);
  });

  it("removes the registration with an account deleted for privacy, and keeps another account's", async () => {
    const { identity, messages, rows, store } = memoryIdentity("accepted", reporting);
    await identity.requestLink("person@example.com", "default", { ...ONE_CLIENT, clickId: CLICK });
    await identity.openLink(tokenIn(messages[0] as Message));
    await identity.requestLink("bystander@example.com", "default", {
      ...ONE_CLIENT,
      clickId: ANOTHER_CLICK,
    });
    const bystander = await identity.openLink(tokenIn(messages[1] as Message));
    if (bystander.status !== "opened") throw new Error("the bystander's link did not open");
    expect(registrationsIn(rows)).toHaveLength(2);

    await expect(
      store.deleteUnattachedPerson({
        operation: "delete",
        operation_id: OPERATION,
        email: "person@example.com",
      }),
    ).resolves.toStrictEqual({ status: "deleted" });

    expect(registrationsIn(rows)).toMatchObject([
      { accountId: bystander.person.id, clickId: ANOTHER_CLICK },
    ]);
    expect(registrationsIn(rows)).toHaveLength(1);
  });

  it("still opens a link stored in the shape without a click, and writes no registration", async () => {
    const { identity, messages, rows } = memoryIdentity("accepted", reporting);
    await identity.requestLink("person@example.com", "settings", { ...ONE_CLIENT, clickId: CLICK });
    const verification = rows.dashboard_verifications?.[0];
    if (verification === undefined) throw new Error("the link was not stored");
    verification.value = JSON.stringify({
      email: "person@example.com",
      destination: "settings",
      request: null,
    });

    await expect(identity.openLink(tokenIn(messages[0] as Message))).resolves.toMatchObject({
      status: "opened",
      destination: "settings",
    });

    expect(rows.dashboard_accounts).toHaveLength(1);
    expect(registrationsIn(rows)).toStrictEqual([]);
  });

  it("opens nothing and writes nothing for a stored click outside the closed set", async () => {
    // A row holding a click this file would not have written was not written by
    // it, and opens nothing rather than reporting somebody else's click.
    const { identity, messages, rows } = memoryIdentity("accepted", reporting);
    await identity.requestLink("person@example.com", "default", { ...ONE_CLIENT, clickId: CLICK });
    const token = tokenIn(messages[0] as Message);
    const dashboard = { email: "person@example.com", destination: "default", request: null };

    for (const claim of [
      { ...dashboard, clickId: "too-short" },
      { ...dashboard, clickId: "qa click 0123456789abcdef" },
      { ...dashboard, clickId: "a".repeat(65) },
      { ...dashboard, clickId: 1234567890123456 },
      { ...dashboard, clickId: { id: CLICK } },
      { ...dashboard, clickId: [CLICK] },
      { ...dashboard, clickId: null },
      {
        email: "person@example.com",
        destination: { report: SCAN },
        request: REQUEST,
        clickId: CLICK,
      },
    ]) {
      // Read afresh, as above: each call replaces the stored rows.
      const verification = rows.dashboard_verifications?.[0];
      if (verification === undefined) throw new Error("the link was not stored");
      verification.value = JSON.stringify(claim);

      await expect(identity.openLink(token), JSON.stringify(claim)).resolves.toStrictEqual({
        status: "refused",
      });
      expect(await identity.landingOf(token)).toBeNull();
      expect(rows.dashboard_verifications).toHaveLength(1);
      expect(rows.dashboard_accounts).toHaveLength(0);
      expect(rows.dashboard_sessions).toHaveLength(0);
      expect(registrationsIn(rows)).toStrictEqual([]);
    }
  });

  it("fails the press loudly and spends nothing when the account already holds a registration it could not have", async () => {
    // An unverified account has never been registered, so a row for it is a
    // broken invariant; writing over it or beside it would hide that.
    const { identity, messages, rows, store } = memoryIdentity("accepted", reporting);
    const made = await store.make("person@example.com", "mer_made");
    if (made === null) throw new Error("the account was not made");
    const planted = {
      accountId: made.id,
      clickId: ANOTHER_CLICK,
      state: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
      lastOutcome: null,
      createdAt: new Date(),
      settledAt: null,
    };
    rows.dashboard_registration_postbacks = [planted];
    await identity.requestLink("person@example.com", "default", { ...ONE_CLIENT, clickId: CLICK });

    await expect(identity.openLink(tokenIn(messages[0] as Message))).rejects.toThrow();

    expect(await store.byId(made.id)).toMatchObject({ confirmed: false });
    expect(rows.dashboard_sessions).toHaveLength(0);
    expect(rows.dashboard_verifications).toHaveLength(1);
    expect(registrationsIn(rows)).toStrictEqual([planted]);
  });
});

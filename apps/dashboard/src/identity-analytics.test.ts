/**
 * What the identity records for product analytics, on its memory store: a
 * sign-in confirmed, a sign-in refused at its start or its verification, and a
 * merchant made for a person. The memory store keeps an event beside the rows
 * of the fact it records, so a sign-in that is undone leaves none.
 * `identity-analytics.db-test.ts` holds the same promises on PostgreSQL.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { identityFor } from "./identity.js";
import type { Message } from "./mail.js";
import { cookieHeader, type GoogleProfile, googleExchange } from "./testing/google.js";
import { ONE_CLIENT, rewindLinkSends } from "./testing/link-sends.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";

const SETTINGS = {
  DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
  AUTH_SECRET: TEST_AUTH_SECRET,
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "sandbox:scripted",
  GOOGLE_CLIENT_ID: "offline-client",
  GOOGLE_CLIENT_SECRET: "offline-secret",
} as const;
/** Synthetic: it passes the click identifier's pattern and no tracker issued it. */
const CLICK = "qa_click_0123456789abcdef";
const EMAIL = "person@example.com";

type MemoryRows = Record<string, Record<string, unknown>[]>;

function setup(
  settings: Record<string, string> = {},
  handover: "accepted" | "refused" = "accepted",
) {
  const rows: MemoryRows = {
    dashboard_accounts: [],
    dashboard_sessions: [],
    dashboard_credentials: [],
    dashboard_verifications: [],
    dashboard_link_sends: [],
  };
  const messages: Message[] = [];
  const identity = identityFor(loadConfig({ ...SETTINGS, ...settings }), {
    rows,
    postman: async (message) => {
      messages.push(message);
      return handover;
    },
  });
  const google = googleExchange();
  vi.stubGlobal("fetch", google.fetch);

  const tokenOf = (message: Message | undefined): string => {
    const raw = message?.body.match(/https?:\/\/\S+/)?.[0];
    const token = raw === undefined ? null : new URL(raw).searchParams.get("token");
    if (token === null || token === undefined) throw new Error("the message has no link");
    return token;
  };
  const linkFor = async (email = EMAIL, click?: string): Promise<string> => {
    rewindLinkSends(rows);
    const asked = await identity.requestLink(email, "default", {
      ...ONE_CLIENT,
      ...(click === undefined ? {} : { clickId: click }),
    });
    if (asked.status !== "accepted") throw new Error(`the link was ${asked.status}`);
    return tokenOf(messages.at(-1));
  };
  const signIn = async (email = EMAIL) => {
    const opened = await identity.openLink(await linkFor(email));
    if (opened.status !== "opened") throw new Error("the link did not open");
    return opened.person;
  };
  const startGoogle = async (profile: Partial<GoogleProfile> = {}) => {
    const began = await identity.startGoogle("default");
    if (began.status !== "redirect") throw new Error("Google must be available");
    return {
      query: google.authorize(began.location, profile),
      cookie: cookieHeader(began.setCookies),
    };
  };
  const googleLogin = async (profile: Partial<GoogleProfile> = {}) => {
    const flow = await startGoogle(profile);
    return await identity.finishGoogle(flow.query, flow.cookie);
  };

  /** Every event recorded, as the outbox holds it. */
  const recorded = () =>
    (rows.commerce_analytics_events ?? []).map(({ occurredAt, ...event }) => event);
  const named = (name: string) => recorded().filter((event) => event.name === name);
  /** An observation is not waited for, so a test waits for it to land. */
  const settled = async (count: number) => {
    await vi.waitFor(() => expect(recorded().length).toBeGreaterThanOrEqual(count));
    // Anything recorded twice would have landed by now as well.
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return {
    identity,
    rows,
    messages,
    google,
    linkFor,
    signIn,
    startGoogle,
    googleLogin,
    recorded,
    named,
    settled,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const refusal = (method: string, stage: string, outcome: string, reason: string) => ({
  name: "agc_auth_result",
  actor: "human",
  source: "dashboard",
  fields: { method, stage, outcome, reason_code: reason },
});

describe("what the identity records for product analytics", () => {
  it("records a first verification by link as one confirmed sign-in, and a returning one as not the first", async () => {
    const { signIn, named } = setup();

    const first = await signIn();
    const again = await signIn();

    expect(again.id).toBe(first.id);
    expect(named("agc_auth_result")).toStrictEqual([
      {
        name: "agc_auth_result",
        actor: "human",
        source: "dashboard",
        refs: { person: first.id },
        fields: {
          method: "email_link",
          stage: "verify",
          outcome: "confirmed",
          first_verification: true,
        },
      },
      {
        name: "agc_auth_result",
        actor: "human",
        source: "dashboard",
        refs: { person: first.id },
        fields: {
          method: "email_link",
          stage: "verify",
          outcome: "confirmed",
          first_verification: false,
        },
      },
    ]);
  });

  it("counts an account made for an address before it was ever verified as that address's first verification", async () => {
    const { identity, signIn, named } = setup();
    await identity.make(EMAIL, "mer_made_by_the_operator");

    await signIn();

    expect(named("agc_auth_result").map((event) => event.fields)).toStrictEqual([
      { method: "email_link", stage: "verify", outcome: "confirmed", first_verification: true },
    ]);
  });

  it("records a first Google sign-in as confirmed and the first, and a returning one as not the first", async () => {
    const { googleLogin, named } = setup();

    const first = await googleLogin();
    const again = await googleLogin();

    if (first.status !== "opened" || again.status !== "opened") throw new Error("Google must open");
    expect(named("agc_auth_result")).toStrictEqual(
      [true, false].map((firstVerification) => ({
        name: "agc_auth_result",
        actor: "human",
        source: "dashboard",
        refs: { person: first.person.id },
        fields: {
          method: "google",
          stage: "verify",
          outcome: "confirmed",
          first_verification: firstVerification,
        },
      })),
    );
  });

  it("records nothing of a sign-in that was undone, and no confirmation for it", async () => {
    // A registration already on record for the account fails the press's
    // transaction after the session was made, so the whole sign-in is undone.
    const { identity, rows, linkFor, recorded } = setup({
      REGISTRATION_POSTBACK_ENABLED: "true",
      REGISTRATION_POSTBACK_KEY: ["qa", "synthetic", "postback", "key"].join("-"),
      REGISTRATION_POSTBACK_URL: "http://127.0.0.1:4010/postback",
    });
    const person = await identity.make(EMAIL, "mer_made_by_the_operator");
    if (person === null) throw new Error("the account was not made");
    rows.dashboard_ad_reports = [{ accountId: person.id, event: "reg" }];

    await expect(identity.openLink(await linkFor(EMAIL, CLICK))).rejects.toThrow();

    expect(recorded().filter((event) => event.name === "agc_auth_result")).toStrictEqual([]);
    expect(rows.dashboard_sessions).toHaveLength(0);
  });

  it("records a link that opens nothing as one refusal at its verification, never as a sign-in", async () => {
    const { identity, linkFor, named, settled } = setup();
    const token = await linkFor();
    await identity.openLink(token);

    const spent = await identity.openLink(token);
    const unknown = await identity.openLink("A".repeat(32));
    const malformed = await identity.openLink("not a token");
    await settled(4);

    expect([spent.status, unknown.status, malformed.status]).toStrictEqual([
      "refused",
      "refused",
      "refused",
    ]);
    const results = named("agc_auth_result");
    expect(
      results.filter((event) => (event.fields as { outcome: string }).outcome === "confirmed"),
    ).toHaveLength(1);
    expect(
      results.filter((event) => (event.fields as { outcome: string }).outcome !== "confirmed"),
    ).toStrictEqual(
      Array.from({ length: 3 }, () => refusal("email_link", "verify", "blocked", "invalid_link")),
    );
  });

  it("records a link asked for again too soon as one refusal at its start, and a link the mail would not take as another", async () => {
    const limited = setup();
    await limited.identity.requestLink(EMAIL, "default", ONE_CLIENT);
    const again = await limited.identity.requestLink(EMAIL, "default", ONE_CLIENT);
    await limited.settled(1);

    const unsent = setup({}, "refused");
    const refused = await unsent.identity.requestLink(EMAIL, "default", ONE_CLIENT);
    await unsent.settled(1);

    expect(again.status).toBe("cooldown");
    expect(limited.recorded()).toStrictEqual([
      refusal("email_link", "start", "blocked", "rate_limited"),
    ]);
    expect(refused.status).toBe("unavailable");
    expect(unsent.recorded()).toStrictEqual([
      refusal("email_link", "start", "failed", "dependency_unavailable"),
    ]);
  });

  it("records nothing for a link sent, which is no sign-in yet", async () => {
    const { linkFor, recorded } = setup();

    await linkFor();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(recorded()).toStrictEqual([]);
  });

  it("records a Google return whose state is not this browser's, or spent, as a refused link", async () => {
    const { identity, startGoogle, named, settled } = setup();
    const foreign = await startGoogle();
    foreign.query.set("state", "other-browser");
    const replayed = await startGoogle();
    await identity.finishGoogle(replayed.query, replayed.cookie);

    await identity.finishGoogle(foreign.query, foreign.cookie);
    await identity.finishGoogle(replayed.query, replayed.cookie);
    await settled(3);

    expect(
      named("agc_auth_result").filter(
        (event) => (event.fields as { outcome: string }).outcome !== "confirmed",
      ),
    ).toStrictEqual([
      refusal("google", "verify", "blocked", "invalid_link"),
      refusal("google", "verify", "blocked", "invalid_link"),
    ]);
  });

  it("records an address Google does not vouch for as a mismatch of identity, and a cancelled sign-in as nothing", async () => {
    const { identity, googleLogin, startGoogle, recorded, settled } = setup();
    const cancelled = await startGoogle();
    cancelled.query.delete("code");
    cancelled.query.set("error", "access_denied");

    await googleLogin({ email: "reader@gmail.com", email_verified: false });
    await identity.finishGoogle(cancelled.query, cancelled.cookie);
    await settled(1);

    expect(recorded()).toStrictEqual([refusal("google", "verify", "blocked", "identity_mismatch")]);
  });

  it("records a Google sign-in that could not be started, and one Google did not answer, as failures", async () => {
    const { identity, google, startGoogle, recorded, settled } = setup();
    const flow = await startGoogle();
    google.goOffline();

    const started = await identity.startGoogle("default", "not a click identifier");
    const finished = await identity.finishGoogle(flow.query, flow.cookie);
    await settled(2);

    expect(started.status).toBe("unavailable");
    expect(finished).toMatchObject({ status: "refused", reason: "unavailable" });
    expect(recorded()).toStrictEqual([
      refusal("google", "start", "failed", "dependency_unavailable"),
      refusal("google", "verify", "failed", "dependency_unavailable"),
    ]);
  });

  it("records a merchant made for a person once, naming both, and nothing for a repeat or a merchant not made", async () => {
    const { identity, signIn, named } = setup();
    const person = await signIn();
    const other = await signIn("other@example.com");

    await identity.attachMerchant(person.id, async () => "mer_new");
    await identity.attachMerchant(person.id, async () => "mer_second");
    await identity.attachMerchant(other.id, async () => null);

    expect(named("agc_merchant_created")).toStrictEqual([
      {
        name: "agc_merchant_created",
        actor: "human",
        source: "dashboard",
        refs: { merchant: "mer_new", person: person.id },
      },
    ]);
  });
});

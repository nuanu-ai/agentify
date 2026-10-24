/**
 * Who the operator's workspace answers and when an operator may act, with the
 * real sign-in component over its memory store. If these fail, a signed-in
 * merchant could read every merchant's records, or a stolen cookie of an
 * operator's could act for thirty days instead of fifteen minutes.
 */

import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import type { DashboardIdentity } from "../dashboard-entry.js";
import { identityFor } from "../identity.js";
import type { Message } from "../mail.js";
import { flagRow } from "../testing/account-rows.js";
import { ONE_CLIENT } from "../testing/link-sends.js";
import { TEST_AUTH_SECRET } from "../testing/secrets.js";
import { FRESH_SIGN_IN_MS, operatorOf, signedInFreshly } from "./access.js";

const PERSON = "operator@example.com";

const config = loadConfig({
  DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
  AUTH_SECRET: TEST_AUTH_SECRET,
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "sandbox:scripted",
});

/** A person signed in through a mailed link, as a browser holds them. */
const signedIn = async () => {
  const mails: Message[] = [];
  const rows: Record<string, Record<string, unknown>[]> = {
    dashboard_accounts: [],
    dashboard_sessions: [],
    dashboard_credentials: [],
    dashboard_verifications: [],
    dashboard_link_sends: [],
  };
  const identity = identityFor(config, {
    rows,
    postman: async (message) => {
      mails.push(message);
      return "accepted";
    },
  });
  await identity.make(PERSON, "mer_operator");
  await identity.requestLink(PERSON, "default", ONE_CLIENT);
  const link = new URL(/(https?:\/\/\S+)/.exec(mails.at(-1)?.body ?? "")?.[1] ?? "");
  const opened = await identity.openLink(link.searchParams.get("token") ?? "");
  if (opened.status !== "opened") throw new Error("the test's link did not open");
  const cookie = opened.setCookies.map((line) => line.split(";")[0]).join("; ");
  return { identity, cookie, rows };
};

describe("who the operator's workspace answers", () => {
  it("answers an account the operator flag confirms, with the moment its session was signed in", async () => {
    const { identity, cookie, rows } = await signedIn();
    flagRow(rows, PERSON, true);

    const operator = await operatorOf(identity, cookie);

    expect(operator?.person.email).toBe(PERSON);
    expect(operator?.signedInAt).toBeInstanceOf(Date);
    await identity.close();
  });

  it("answers nobody for an account without the flag, a session that ended, no cookie, or a flag taken away", async () => {
    const { identity, cookie, rows } = await signedIn();

    expect(await operatorOf(identity, cookie)).toBeNull();
    expect(await operatorOf(identity, undefined)).toBeNull();
    flagRow(rows, PERSON, true);
    flagRow(rows, PERSON, false);
    expect(await operatorOf(identity, cookie)).toBeNull();
    flagRow(rows, PERSON, true);
    await identity.signOut(cookie);
    expect(await operatorOf(identity, cookie)).toBeNull();
    await identity.close();
  });

  it("answers nobody while the identity cannot answer", async () => {
    const failing = {
      whoIs: async () => {
        throw new Error("the database is gone");
      },
    } as unknown as DashboardIdentity;

    expect(await operatorOf(failing, "agentify.session_token=anything")).toBeNull();
  });
});

describe("when an operator may act", () => {
  it("only within fifteen minutes of signing in", async () => {
    const { identity, cookie, rows } = await signedIn();
    flagRow(rows, PERSON, true);
    const operator = await operatorOf(identity, cookie);
    if (operator === null) throw new Error("the operator was not confirmed");
    const at = operator.signedInAt.getTime();

    expect(signedInFreshly(operator, new Date(at))).toBe(true);
    expect(signedInFreshly(operator, new Date(at + FRESH_SIGN_IN_MS - 1))).toBe(true);
    expect(signedInFreshly(operator, new Date(at + FRESH_SIGN_IN_MS))).toBe(false);
    expect(signedInFreshly(operator, new Date(at + 2 * 60 * 60 * 1000))).toBe(false);
    expect(FRESH_SIGN_IN_MS).toBe(15 * 60 * 1000);
    await identity.close();
  });

  it("reads the moment of signing in, which a session's daily renewal keeps", async () => {
    // The session row's creation moment stands for the sign-in; a renewed
    // session is written with the old one's, so this is what renewal carries.
    const { identity, cookie, rows } = await signedIn();
    flagRow(rows, PERSON, true);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    for (const row of rows.dashboard_sessions ?? []) row.createdAt = hourAgo;

    const operator = await operatorOf(identity, cookie);

    expect(operator?.signedInAt.getTime()).toBe(hourAgo.getTime());
    expect(operator === null ? true : signedInFreshly(operator, new Date())).toBe(false);
    await identity.close();
  });
});

/**
 * The gate every React page behind it is drawn through, run as React Router
 * runs it, with the real sign-in component over its memory store. A page moved
 * under the gate gets all of this by being nested there, so these hold for
 * every such page before the first one with a form exists.
 */

import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { DRAWN_FOR } from "../../src/drawn-for.js";
import { identityFor } from "../../src/identity.js";
import type { Message } from "../../src/mail.js";
import { pageServicesFor } from "../../src/page-services.js";
import { services, signedIn } from "../services.js";
import { middleware } from "./gate.js";

const PERSON = "owner@example.com";
const ORDERS = "http://127.0.0.1/dashboard/orders";

const config = loadConfig({
  DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
  AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "sandbox:scripted",
  BASE_PATH: "/dashboard",
});

/** A person signed in through a mailed link, as a browser holds them. */
const signedInBrowser = async () => {
  const mails: Message[] = [];
  const identity = identityFor(config, {
    postman: async (message) => {
      mails.push(message);
      return "accepted";
    },
  });
  await identity.make(PERSON, "mer_gate");
  await identity.requestLink(PERSON, "default");
  const link = new URL(/(https?:\/\/\S+)/.exec(mails.at(-1)?.body ?? "")?.[1] ?? "");
  const opened = await identity.openLink(link.searchParams.get("token") ?? "");
  if (opened.status !== "opened") throw new Error("the test's link did not open");
  const cookie = opened.setCookies.map((line) => line.split(";")[0]).join("; ");
  return { identity, cookie };
};

/** The gate run on one request; what it let through, or what it answered with. */
const throughTheGate = async (request: Request, identity: ReturnType<typeof identityFor>) => {
  const context = new RouterContextProvider(
    new Map([
      [
        services,
        pageServicesFor(config, {
          identity,
          clientFor: () => {
            throw new Error("the gate asks the gateway nothing");
          },
          registrar: {
            register: () => {
              throw new Error("the gate makes no merchant");
            },
          },
          woo: null,
        }),
      ],
    ]),
  );
  const gate = middleware[0];
  if (gate === undefined) throw new Error("the gate route has no middleware");
  let reached = false;
  try {
    const response = await gate(
      { request, context, params: {}, url: new URL(request.url), pattern: "/orders" },
      async () => {
        reached = true;
        return new Response("the page");
      },
    );
    return { reached, response, person: context.get(signedIn), thrown: undefined };
  } catch (thrown) {
    return { reached, response: undefined, person: undefined, thrown };
  }
};

const form = (cookie: string, fields: Record<string, string> | string[][]): Request =>
  new Request(ORDERS, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

describe("the gate in front of the React pages", () => {
  it("sends a visitor with no session to the sign-in, naming the section, before the page runs", async () => {
    const { identity } = await signedInBrowser();

    const passed = await throughTheGate(new Request(ORDERS), identity);

    expect(passed.reached).toBe(false);
    const sent = passed.thrown as Response;
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe("/dashboard/sign-in?destination=orders");
    await identity.close();
  });

  it("lets a signed-in person through to the page, as themselves", async () => {
    const { identity, cookie } = await signedInBrowser();

    const passed = await throughTheGate(new Request(ORDERS, { headers: { cookie } }), identity);

    expect(passed.reached).toBe(true);
    expect(passed.person?.email).toBe(PERSON);
    await identity.close();
  });

  it("refuses a form drawn for somebody else, for nobody, or marked more than once, before any action reads it", async () => {
    // A mark given twice is not a form any page draws, and which of the two
    // counts would be a guess.
    const { identity, cookie } = await signedInBrowser();

    const drawn: (Record<string, string> | string[][])[] = [
      { [DRAWN_FOR]: "someone@example.com" },
      {},
      [
        [DRAWN_FOR, PERSON],
        [DRAWN_FOR, "someone@example.com"],
      ],
      [
        [DRAWN_FOR, PERSON],
        [DRAWN_FOR, PERSON],
      ],
    ];
    for (const fields of drawn) {
      const passed = await throughTheGate(form(cookie, fields), identity);

      expect(passed.reached, JSON.stringify(fields)).toBe(false);
      const refused = passed.thrown as { init?: { status?: number }; data?: { kind?: string } };
      expect(refused.init?.status).toBe(409);
      expect(refused.data?.kind).toBe("not-drawn-for-you");
    }
    await identity.close();
  });

  it("lets through a form drawn for the address signed in now, with its body still to be read", async () => {
    const { identity, cookie } = await signedInBrowser();
    const request = form(cookie, { [DRAWN_FOR]: PERSON, label: "nightly" });

    const passed = await throughTheGate(request, identity);

    expect(passed.reached).toBe(true);
    expect((await request.formData()).get("label")).toBe("nightly");
    await identity.close();
  });
});

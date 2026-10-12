/**
 * The dashboard driven over HTTP against the real gateway on in-memory
 * adapters, called in-process as a deployment calls it, so a dashboard that
 * drifted from the contract fails here rather than in front of a merchant. What
 * a merchant's own code would do (publishing, buying) goes over the gateway's
 * real HTTP surface. Sign-in is the real component too; only its rows live in
 * its memory store, so `pnpm test` needs no database (`identity.db-test.ts`
 * runs the same flows on Postgres). The assertions are about what a merchant
 * can see and do, never markup.
 */

import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import type { Gateway } from "@agentify/gateway";
import {
  buyOverHttp,
  type Harness,
  harness,
  type Served,
  serve,
  theMerchantKey,
} from "@agentify/gateway/testing";
import {
  type Card,
  checksummedAddressOf,
  MERCHANT_FINDINGS,
  type MerchantKey,
  type MerchantKeyList,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DashboardConfig, loadConfig } from "./config.js";
import {
  type Acting,
  type Answer,
  type GatewayClient,
  gatewayFor,
  type Registrar,
} from "./gateway.js";
import { DRAWN_FOR } from "./html.js";
import {
  type Identity,
  identityFor,
  LINK_MIN_INTERVAL_MS,
  LINK_RATE_WINDOW_MS,
} from "./identity.js";
import type { Handover, Message, Postman } from "./mail.js";
import { buildApp } from "./server.js";
import { readable, shownMarkIn, waitingButton } from "./testing/html.js";
import { rewindLinkSends } from "./testing/link-sends.js";
import { memoryWooShops, type WooShops } from "./woo-shops.js";

/**
 * Named rather than spelled again: the gateway reads the environment off the
 * key's prefix, so a copy would come apart from the harness when the prefix
 * changed.
 */
const KEY = theMerchantKey("test");
const asMerchant = { authorization: `Bearer ${KEY}` };
const PAY_TO = "0x0000000000000000000000000000000000000001";

/** On the plain-http local origin. */
const COOKIE = "agentify.session_token";
/**
 * The browser refuses a `__Host-` cookie unless it is Secure, for the whole
 * origin and with no Domain, so another host under the same registrable domain
 * can neither plant nor overwrite a session.
 */
const SECURE_COOKIE = "__Host-agentify.session_token";
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const SESSION_ENDED = "/sign-in?reason=session-ended";
/**
 * Not the dashboard's page, so these tests read the redirect and do not follow
 * it.
 */
const LATEST_REPORT = "/report/latest";
const SESSION_ENDED_UNSAVED = "/sign-in?reason=session-ended-unsaved";
/**
 * The gate cannot say a session ended, only that what was sent was not kept.
 */
const UNSAVED = "/sign-in?reason=unsaved";

const PERSON = "owner@example.com";
/** "Somebody else's session" cannot be tested with one account in the store. */
const OTHER = "someone@example.com";
/** Has no account until they register. */
const FRESH = { email: "fresh-merchant@example.com" };

/**
 * The harness's seeded merchant, so every screen is drawn from the real
 * gateway.
 */
const theMerchant = (harnessed: Harness): string => harnessed.merchant.id;

/**
 * The rows are handed in so a test can put an account into a state no route
 * produces and read what the component wrote. Tests that need another person
 * make that person themselves.
 */
const withIdentity = async (
  config: DashboardConfig,
  postman: Postman,
  merchant: string,
): Promise<{
  identity: Identity;
  forgetMerchant: (email: string) => void;
  rows: Record<string, Record<string, unknown>[]>;
}> => {
  const rows: Record<string, Record<string, unknown>[]> = {
    dashboard_accounts: [],
    dashboard_sessions: [],
    dashboard_credentials: [],
    dashboard_verifications: [],
    dashboard_link_sends: [],
  };
  const identity = identityFor(config, { rows, postman });
  await identity.make(PERSON, merchant);
  const forgetMerchant = (email: string): void => {
    for (const row of rows.dashboard_accounts ?? []) {
      if (row.email === email) {
        row.merchantId = null;
      }
    }
  };
  return { identity, forgetMerchant, rows };
};

/** Exposed only by the deterministic memory adapter. */
const sessionRows = (): Record<string, unknown>[] => open?.rows.dashboard_sessions ?? [];

const roomCard: Card = {
  merchant_item_id: "SKU 100/1",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

const esimCard: Card = {
  merchant_item_id: "esim-eu-5",
  title: "eSIM Europe, 5 GB for 30 days",
  description: "A data plan delivered as a profile after the purchase",
  price: { amount: "8.00", currency: "USD" },
  result: { iccid: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 14_400,
};

interface Visit {
  readonly status: number;
  readonly headers: Headers;
  readonly html: string;
  /** Null where the answer is a page. */
  readonly to: string | null;
}

interface Browser {
  get(path: string): Promise<Visit>;
  post(path: string, form?: Record<string, string>): Promise<Visit>;
  /** A body this dashboard's forms never send, as a scanner would. */
  postRaw(path: string, contentType: string, body: string): Promise<Visit>;
  /**
   * The minute between two links to one address is moved out of the way first,
   * so signing a second device in, or the same person twice, gets a link rather
   * than the cooldown screen; the cooldown tests ask for links directly.
   */
  signIn(email?: string): Promise<Visit>;
  /** And follows where it leads. */
  makeMerchant(): Promise<Visit>;
  sessionToken(): string | null;
  withRawCookie(cookie: string): Browser;
  from(origin: string): Browser;
  /**
   * A terminator in front of the dashboard cannot be driven as a browser, so
   * the headers it would add are put on the request here.
   */
  sending(headers: Record<string, string>): Browser;
  close(): Promise<void>;
}

interface Running {
  readonly harnessed: Harness;
  readonly gateway: Served;
  readonly browser: Browser;
  /**
   * An origin the browser claims is compared with the request's `Host`, so a
   * test naming an origin needs the real host and port.
   */
  readonly url: string;
  readonly identity: Identity;
  /**
   * Makes an account row with no merchant, as written before accounts named
   * their merchant; no route produces one.
   */
  readonly forgetMerchant: (email: string) => void;
  /** For the two assertions that read one. */
  readonly rows: Record<string, Record<string, unknown>[]>;
  readonly theMerchant: string;
  readonly mails: Message[];
  /** For two people or two devices. */
  another(): Promise<Browser>;
  /**
   * The shape of a database that stopped answering, with a short deadline so
   * the tests do not wait ten seconds.
   */
  silenceGateway(): void;
}

let open: Running | null = null;

interface Starting {
  readonly base?: string;
  readonly gateway?: Record<string, string>;
  readonly dashboard?: Record<string, string>;
  /**
   * Stubbed for the tests about what the dashboard does with each shape of
   * answer; otherwise the real registration.
   */
  readonly registrar?: Registrar;
  /**
   * For the tests about a gateway that stopped answering; otherwise the
   * client's own ten seconds.
   */
  readonly answerWithinMs?: number;
  /**
   * A decorator, so everything a test is not about still goes to the real
   * gateway; it supplies answers the gateway will not give on command: a
   * refusal, or no answer at all.
   */
  readonly client?: (real: GatewayClient) => GatewayClient;
  /**
   * The same shape as the client above: a write that fails cannot be asked of
   * the store.
   */
  readonly identity?: (real: Identity) => Identity;
  /**
   * Taken by default. `"refused"` is the case a screen must not call a link
   * sent.
   */
  readonly mailTakes?: Handover;
  readonly wooShops?: WooShops;
}

const started = async (options: Starting = {}): Promise<Running> => {
  const harnessed = await harness({ PAY_TO_ADDRESS: PAY_TO, ...options.gateway });
  const gateway = await serve(harnessed);
  const basePath = options.base ?? "";
  const mails: Message[] = [];
  let silenced = false;
  // Once a test silences it, every call it is asked to make waits for good.
  const application = new Proxy(harnessed.gateway, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      return silenced && typeof value === "function"
        ? () => new Promise(() => undefined)
        : typeof value === "function"
          ? value.bind(target)
          : value;
    },
  });
  const merchant = theMerchant(harnessed);
  const { browser, url, identity, forgetMerchant, rows } = await visiting(
    application,
    merchant,
    basePath,
    mails,
    options,
  );

  open = {
    harnessed,
    gateway,
    browser,
    url,
    identity,
    forgetMerchant,
    rows,
    theMerchant: merchant,
    mails,
    another: async () => await attachedTo(url, basePath, () => mails.at(-1), rows),
    silenceGateway() {
      silenced = true;
    },
  };
  return open;
};

afterEach(async () => {
  await open?.browser.close();
  await open?.identity.close();
  await open?.gateway.close();
  await open?.harnessed.stop();
  open = null;
});

async function visiting(
  application: Gateway,
  merchant: string,
  basePath: string,
  mails: Message[],
  options: Starting,
): Promise<{
  browser: Browser;
  url: string;
  identity: Identity;
  forgetMerchant: (email: string) => void;
  rows: Record<string, Record<string, unknown>[]>;
}> {
  // The database address is one nothing connects to (the component keeps rows
  // in memory here), but it is still required.
  const config = loadConfig({
    DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
    AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
    PAYMENT_NETWORK: "eip155:84532",
    FACILITATOR_URL: "sandbox:scripted",
    ...(basePath === "" ? {} : { BASE_PATH: basePath }),
    ...(options.dashboard ?? {}),
  });
  const { identity, forgetMerchant, rows } = await withIdentity(
    config,
    async (message) => {
      mails.push(message);
      return options.mailTakes ?? "accepted";
    },
    merchant,
  );
  const app = buildApp(config, {
    gateway: application,
    identity: options.identity === undefined ? identity : options.identity(identity),
    ...(options.registrar === undefined ? {} : { registrar: options.registrar }),
    ...(options.wooShops === undefined ? {} : { wooShops: options.wooShops }),
    // Given the deadline it was asked for, unless a test shortens it.
    clientFor: (acting: Acting, answerWithinMs?: number) => {
      const real = gatewayFor(application, acting, options.answerWithinMs ?? answerWithinMs);
      return options.client === undefined ? real : options.client(real);
    },
  });
  // On the address it is called at rather than the wildcard, as the gateway's
  // own harness does.
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  const url = `http://127.0.0.1:${port}`;
  const browser = await attachedTo(url, basePath, () => mails.at(-1), rows);
  return {
    url,
    identity,
    forgetMerchant,
    rows,
    browser: {
      ...browser,
      // Closing one already closed is not an error: a test that takes its
      // dashboards down itself still meets the sweep afterwards.
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) =>
            error === undefined ||
            (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
              ? resolve()
              : reject(error),
          );
        }),
    },
  };
}

/**
 * Separate from `visiting` because some tests build their own dashboard, and
 * being a browser is the same for both.
 */
async function attachedTo(
  url: string,
  basePath: string,
  latestMail: () => Message | undefined = () => undefined,
  rows: Record<string, Record<string, unknown>[]> = {},
): Promise<Browser> {
  const jar = new Map<string, string>();
  let shownMark: string | undefined;

  const call = async (
    method: string,
    path: string,
    given?: Record<string, string>,
    sent: {
      readonly cookie?: string;
      readonly origin?: string;
      readonly extra?: Record<string, string>;
      readonly raw?: { readonly contentType: string; readonly body: string };
    } = {},
  ): Promise<Visit> => {
    const cookie = sent.cookie ?? [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const form =
      given === undefined || DRAWN_FOR in given || shownMark === undefined
        ? given
        : { ...given, [DRAWN_FOR]: shownMark };
    const answered = await fetch(`${url}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(cookie === "" ? {} : { cookie }),
        ...(sent.origin === undefined ? {} : { origin: sent.origin }),
        ...(sent.extra ?? {}),
        ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
        ...(sent.raw === undefined ? {} : { "content-type": sent.raw.contentType }),
      },
      ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }),
      ...(sent.raw === undefined ? {} : { body: sent.raw.body }),
    });

    for (const line of answered.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const at = pair.indexOf("=");
      if (at === -1) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (value === "") {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    }

    const html = await answered.text();
    shownMark = shownMarkIn(html) ?? shownMark;
    return {
      status: answered.status,
      headers: answered.headers,
      html,
      to: answered.headers.get("location"),
    };
  };

  const browser: Browser = {
    get: (path) => call("GET", path),
    post: (path, form) => call("POST", path, form ?? {}),
    postRaw: (path, contentType, body) =>
      call("POST", path, undefined, { raw: { contentType, body } }),
    async signIn(email = PERSON) {
      rewindLinkSends(rows);
      const requested = await call("POST", `${basePath}/sign-in`, { email });
      if (requested.status !== 202) return requested;
      const found = /(https?:\/\/\S+)/.exec(latestMail()?.body ?? "")?.[1];
      if (found === undefined) throw new Error("the sign-in message carried no action URL");
      const action = new URL(found);
      const token = action.searchParams.get("token") ?? "";
      const opened = await call("POST", action.pathname, { token });
      return opened.to === null || opened.to === LATEST_REPORT ? opened : call("GET", opened.to);
    },
    async makeMerchant() {
      // Pressed on the screen that offers it, as a person would.
      await call("GET", `${basePath}/merchant`);
      const made = await call("POST", `${basePath}/merchant`, {});
      return made.to === null ? made : call("GET", made.to);
    },
    sessionToken: () => jar.get(COOKIE) ?? jar.get(SECURE_COOKIE) ?? null,
    withRawCookie: (raw) => ({
      ...browser,
      get: (path) => call("GET", path, undefined, { cookie: raw }),
      post: (path, form) => call("POST", path, form ?? {}, { cookie: raw }),
    }),
    from: (origin) => ({
      ...browser,
      get: (path) => call("GET", path, undefined, { origin }),
      post: (path, form) => call("POST", path, form ?? {}, { origin }),
    }),
    sending: (extra) => ({
      ...browser,
      get: (path) => call("GET", path, undefined, { extra }),
      post: (path, form) => call("POST", path, form ?? {}, { extra }),
    }),
    close: async () => undefined,
  };

  return browser;
}

/**
 * `fetch` adds headers of its own, which count against the 16 KB of headers the
 * runtime reads, so a test about how many cookies one request can carry sends
 * only a request line, a Host and the cookies.
 */
const overASocket = (
  url: string,
  path: string,
  cookie: string,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(url);
    const socket = connect(Number(port), hostname, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n` +
          `Cookie: ${cookie}\r\nConnection: close\r\n\r\n`,
      );
    });
    let said = "";
    socket.on("data", (chunk: Buffer) => {
      said += chunk.toString();
    });
    socket.on("error", reject);
    socket.on("close", () => {
      resolve({
        status: Number(said.split(" ")[1] ?? 0),
        body: readable(said.split("\r\n\r\n").slice(1).join("\r\n\r\n")),
      });
    });
  });

const publish = async (gateway: Served, card: Card): Promise<string> => {
  const answered = await gateway.call("POST", "/v0/catalog/publish", {
    body: card,
    headers: { authorization: `Bearer ${KEY}` },
  });
  expect(answered.status).toBe(200);
  return (answered.body as { id: string }).id;
};

const purchasable = async (gateway: Served, itemId: string): Promise<boolean> =>
  (await gateway.call("POST", `/x402/${itemId}/purchase`, { body: { params: {} } })).status === 402;

/**
 * Through the store, because the route refuses to take a name away. It makes
 * the state a merchant is in the minute after registering.
 */
const unname = async (running: Running): Promise<void> => {
  await running.harnessed.store.setServiceName(
    running.harnessed.merchant.id,
    null,
    running.harnessed.now(),
  );
};

const listedAs = async (running: Running): Promise<string | null> =>
  (await running.harnessed.store.merchantById(running.harnessed.merchant.id))?.serviceName ?? null;

const sitedAt = async (running: Running): Promise<string | null> =>
  (await running.harnessed.store.merchantById(running.harnessed.merchant.id))?.sellerSite ?? null;

const paidInto = async (running: Running): Promise<string | null> =>
  (await running.harnessed.store.merchantById(running.harnessed.merchant.id))?.payoutWallet
    .address ?? null;

const waitingOf = async (running: Running): Promise<unknown> =>
  (
    (
      await running.gateway.call("GET", "/v0/payout-wallet", {
        headers: { authorization: `Bearer ${running.harnessed.merchant.key}` },
      })
    ).body as { pending: unknown }
  ).pending;

const sessionCookieIn = (answer: Visit, name: string): string | undefined =>
  answer.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));

/** Keyed in lower case. */
const attributesOf = (line: string): Map<string, string> =>
  new Map(
    line
      .split(";")
      .slice(1)
      .map((part) => {
        const at = part.indexOf("=");
        return at === -1
          ? [part.trim().toLowerCase(), ""]
          : [part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()];
      }),
  );

const actionIn = (message: Message | undefined): URL => {
  const found = /(https?:\/\/\S+)/.exec(message?.body ?? "")?.[1];
  if (found === undefined) throw new Error("the message carried no action URL");
  return new URL(found);
};

describe("the passwordless dashboard door", () => {
  it("sends a person with a live session on without asking for an address: to the cards, or to the name screen without a merchant", async () => {
    const running = await started();
    await running.browser.signIn();

    const withMerchant = await running.browser.get("/sign-in");
    running.forgetMerchant(PERSON);
    const withoutMerchant = await running.browser.get("/sign-in");

    expect(withMerchant.status).toBe(303);
    expect(withMerchant.to).toBe("/cards");
    expect(withoutMerchant.status).toBe(303);
    expect(withoutMerchant.to).toBe("/merchant");
  });

  it("tells somebody new that this same form is their way in", async () => {
    // There is no separate sign-up page, so the page says the form is for
    // newcomers too, and what follows the link.
    const { browser } = await started();

    const form = readable((await browser.get("/sign-in")).html);

    expect(form).toMatch(/new to agentify\?/i);
    expect(form).toMatch(/seller dashboard/i);
  });

  it("asks only for an address and answers known and unknown people identically", async () => {
    const { browser, rows, mails } = await started();

    const form = await browser.get("/sign-in");
    expect(form.html).toContain('name="email"');
    expect(form.html).not.toContain('name="password"');
    expect(form.html).not.toContain('name="invitation"');

    const known = await browser.post("/sign-in", { email: PERSON });
    const unknown = await browser.post("/sign-in", { email: "nobody@example.com" });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(readable(known.html)).toContain(PERSON);
    expect(readable(unknown.html)).toContain("nobody@example.com");
    expect(readable(known.html).replace(PERSON, "submitted@example.com")).toBe(
      readable(unknown.html).replace("nobody@example.com", "submitted@example.com"),
    );
    expect(known.headers.getSetCookie()).toStrictEqual([]);
    expect(unknown.headers.getSetCookie()).toStrictEqual([]);
    expect(rows.dashboard_sessions).toStrictEqual([]);
    expect(mails).toHaveLength(2);
    expect(known.html).toContain('method="post" action="/sign-in"');
    expect(known.html).toContain('method="get" action="/sign-in"');
    expect(known.html).toContain(`name="email" type="hidden" value="${PERSON}"`);
    // The resend carries the minute and is served pressable: the script greys
    // it out, and a browser running none keeps the button and is refused in
    // words.
    const resend = waitingButton(known.html);
    expect(resend.attributes.get("data-link-wait")).toBe(String(LINK_MIN_INTERVAL_MS / 1_000));
    expect(resend.attributes.has("disabled")).toBe(false);
  });

  it("greys the resend for the hour, not the minute, on the page for this hour's third link", async () => {
    const { browser, rows, mails } = await started();

    let page = await browser.post("/sign-in", { email: PERSON });
    for (let sent = 1; sent < 3; sent += 1) {
      rewindLinkSends(rows);
      page = await browser.post("/sign-in", { email: PERSON });
    }

    expect(page.status).toBe(202);
    expect(mails).toHaveLength(3);
    // The third link spends the hour; a page that greyed its resend for sixty
    // seconds would invite a press answered "try again in fifty-seven minutes".
    const oldest = new Date(rows.dashboard_link_sends?.[0]?.sentAt as Date).getTime();
    const owed = Math.ceil((oldest + LINK_RATE_WINDOW_MS - Date.now()) / 1_000);
    const said = Number(waitingButton(page.html).attributes.get("data-link-wait"));
    expect(said).toBeGreaterThan(LINK_MIN_INTERVAL_MS / 1_000);
    expect(Math.abs(said - owed)).toBeLessThanOrEqual(2);
  });

  it("keeps the known address on the page and names the wait after its hourly limit", async () => {
    const { browser, mails, rows } = await started();

    // The rows are moved back a minute between links: this test is about the
    // limit after three, not the minute before each.
    for (let sent = 0; sent < 3; sent += 1) {
      const answer = await browser.post("/sign-in", { email: PERSON });
      expect(answer.status).toBe(202);
      expect(answer.html).toContain(`name="email" type="hidden" value="${PERSON}"`);
      rewindLinkSends(rows);
    }

    const limited = await browser.post("/sign-in", { email: PERSON });
    expect(limited.status).toBe(202);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(readable(limited.html)).toContain("No new link was sent");
    expect(readable(limited.html)).toMatch(/Try again in \d+ minutes/);
    expect(readable(limited.html)).not.toContain("is on its way");
    // The resend stays, with the server's wait on it and nothing disabling it:
    // a button served disabled can never be pressed by a scriptless browser.
    expect(limited.html).toContain('method="post" action="/sign-in"');
    expect(limited.html).toContain('method="get" action="/sign-in"');
    const resend = waitingButton(limited.html);
    expect(resend.attributes.get("data-link-wait")).toBe(limited.headers.get("retry-after"));
    expect(resend.attributes.has("disabled")).toBe(false);
    expect(mails).toHaveLength(3);
  });

  it("says a link is already on its way and keeps the resend waiting inside the minute", async () => {
    const { browser, mails } = await started();
    const first = await browser.post("/sign-in", { email: PERSON });
    expect(first.status).toBe(202);

    const again = await browser.post("/sign-in", { email: PERSON });

    expect(again.status).toBe(202);
    const retryAfter = Number(again.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(LINK_MIN_INTERVAL_MS / 1_000);
    const said = readable(again.html);
    expect(said).toContain(PERSON);
    // The wait is under a minute, so the hourly sentence would be false, and
    // the address's hourly allowance is untouched.
    expect(said).not.toContain("three links an hour");
    expect(said).not.toMatch(/Try again in \d+ minutes/);
    // The server's seconds reach the button, which counts them down, served
    // pressable; the way out for a wrong address stays beside it.
    const resend = waitingButton(again.html);
    expect(resend.attributes.get("data-link-wait")).toBe(again.headers.get("retry-after"));
    expect(resend.attributes.has("disabled")).toBe(false);
    expect(again.html).toContain('method="post" action="/sign-in"');
    expect(again.html).toContain('method="get" action="/sign-in"');
    expect(mails).toHaveLength(1);
  });

  it("does not spend a query token on GET and opens it once on an explicit same-origin POST", async () => {
    const running = await started({ base: "/dashboard", dashboard: { COOKIE_SECURE: "true" } });
    const requested = await running.browser.post("/dashboard/sign-in", { email: PERSON });
    expect(requested.status).toBe(202);
    const action = actionIn(running.mails.at(-1));
    const token = action.searchParams.get("token") ?? "";

    const landing = await running.browser.get(`${action.pathname}${action.search}`);
    expect(landing.status).toBe(200);
    expect(landing.headers.get("cache-control")).toBe("private, no-store");
    expect(landing.headers.get("referrer-policy")).toBe("strict-origin");
    expect(landing.headers.getSetCookie()).toStrictEqual([]);
    expect(landing.html).not.toContain("<script");
    expect(landing.html).toContain(`value="${token}"`);
    // Naming the address stops a link for somebody else's address, sent to a
    // victim, from signing them in as that somebody unnoticed.
    expect(readable(landing.html)).toContain(PERSON);
    expect(running.rows.dashboard_sessions).toStrictEqual([]);

    const opened = await running.browser
      .from(running.url)
      .post("/dashboard/sign-in/open", { token });
    expect(opened.status).toBe(303);
    expect(opened.to).toBe("/dashboard/cards");
    expect(opened.headers.get("cache-control")).toBe("private, no-store");
    expect(opened.headers.get("referrer-policy")).toBe("strict-origin");
    expect(sessionCookieIn(opened, SECURE_COOKIE)).toBeDefined();

    // Pressed twice in a browser now signed in: the person's start, not a page
    // about the link.
    const replay = await running.browser
      .from(running.url)
      .post("/dashboard/sign-in/open", { token });
    expect(replay.status).toBe(303);
    expect(replay.to).toBe("/dashboard/cards");

    const switching = await running.browser.from(running.url).post("/dashboard/sign-out");
    expect(switching.status).toBe(303);
    expect(switching.to).toBe("/dashboard/sign-in");
    expect(running.rows.dashboard_sessions).toStrictEqual([]);
  });

  it("refuses a cross-origin POST without consuming the link", async () => {
    const running = await started();
    await running.browser.post("/sign-in", { email: PERSON });
    const action = actionIn(running.mails.at(-1));
    const token = action.searchParams.get("token") ?? "";

    const forged = await running.browser
      .from("https://evil.example")
      .post("/sign-in/open", { token });
    expect(forged.status).toBe(403);
    expect(running.rows.dashboard_sessions).toStrictEqual([]);

    const honest = await running.browser.from(running.url).post("/sign-in/open", { token });
    expect(honest.status).toBe(303);
  });

  it("says when the provider refused the message and leaves no identity state", async () => {
    const { browser, rows, identity } = await started({ mailTakes: "refused" });

    const answered = await browser.post("/sign-in", { email: "new@example.com" });

    expect(answered.status).toBe(503);
    // "Refused" covers a timeout too, and that message may have arrived, so the
    // page may not claim nothing was sent; only that nothing was written.
    expect(readable(answered.html)).toMatch(/could not confirm/i);
    expect(readable(answered.html)).not.toMatch(/no link was sent|nothing was sent/i);
    expect(readable(answered.html)).toMatch(/no account or session was created/i);
    expect(answered.headers.getSetCookie()).toStrictEqual([]);
    expect(await identity.byEmail("new@example.com")).toBeNull();
    expect(rows.dashboard_sessions).toStrictEqual([]);
    expect(rows.dashboard_verifications).toStrictEqual([]);
    expect(rows.dashboard_link_sends).toStrictEqual([]);
  });

  it("never makes a merchant by opening a link: a person without one starts at their latest report", async () => {
    // Under Lax a link from another site arrives signed in, so opening a link
    // must not make anything. A person with reports and no merchant starts at
    // the latest one.
    const registered: string[] = [];
    const registrar: Registrar = {
      register: async () => {
        registered.push("asked");
        return { ok: true, document: "mer_never" };
      },
    };
    const running = await started({ registrar });

    const opened = await running.browser.signIn(FRESH.email);

    expect(opened.status).toBe(303);
    expect(opened.to).toBe(LATEST_REPORT);
    expect(registered).toStrictEqual([]);
    const person = await running.identity.byEmail(FRESH.email);
    expect(person?.confirmed).toBe(true);
    expect(person?.merchant).toBeNull();
    // A plain navigation makes nothing either: it draws the one control and
    // names who is signed in, privately.
    const screen = await running.browser.get("/merchant");
    expect(screen.status).toBe(200);
    expect(screen.headers.get("cache-control")).toBe("private, no-store");
    expect(readable(screen.html)).toContain(FRESH.email);
    expect(screen.html).toContain('method="post" action="/merchant"');
    expect(registered).toStrictEqual([]);
  });

  it("makes the merchant on the explicit press, and only a same-origin one", async () => {
    // The press calls the gateway in-process, so no invitation is configured or
    // asked for.
    const running = await started();
    await running.browser.signIn(FRESH.email);

    const forged = await running.browser.from("https://evil.example").post("/merchant");
    expect(forged.status).toBe(403);
    expect((await running.identity.byEmail(FRESH.email))?.merchant).toBeNull();

    const inside = await running.browser.makeMerchant();

    expect(inside.status).toBe(200);
    expect(inside.html).toContain('name="seller_name"');
    const merchant = (await running.identity.byEmail(FRESH.email))?.merchant;
    expect(await running.harnessed.store.merchantById(merchant?.id ?? "")).not.toBeNull();
  });

  it("keeps the P1 session when registration fails and retries without another link", async () => {
    let available = false;
    const registrar: Registrar = {
      register: async () =>
        available
          ? { ok: true, document: "mer_after_retry" }
          : { ok: false, status: 0, why: "Agentify did not answer within ten seconds" },
    };
    const running = await started({ registrar });
    await running.browser.post("/sign-in", { email: FRESH.email });
    const action = actionIn(running.mails.at(-1));
    const token = action.searchParams.get("token") ?? "";
    const opened = await running.browser.from(running.url).post("/sign-in/open", { token });
    expect(opened.to).toBe(LATEST_REPORT);

    await running.browser.get("/merchant");
    const first = await running.browser.from(running.url).post("/merchant");
    expect(first.status).toBe(503);
    expect(running.rows.dashboard_sessions).toHaveLength(1);
    expect((await running.identity.byEmail(FRESH.email))?.merchant).toBeNull();
    expect(running.mails).toHaveLength(1);

    available = true;
    const retry = await running.browser.from(running.url).post("/merchant");
    expect(retry.status).toBe(303);
    expect(retry.to).toBe("/choose-name");
    expect(running.mails).toHaveLength(1);
    expect((await running.identity.byEmail(FRESH.email))?.merchant?.id).toBe("mer_after_retry");
  });

  it("stores only the closed settings destination and returns an existing merchant there", async () => {
    const running = await started();
    await running.browser.post("/sign-in", { email: PERSON, destination: "settings" });
    const action = actionIn(running.mails.at(-1));
    expect(action.searchParams.has("destination")).toBe(false);

    const opened = await running.browser.from(running.url).post("/sign-in/open", {
      token: action.searchParams.get("token") ?? "",
      destination: "https://evil.example",
    });
    expect(opened.status).toBe(303);
    expect(opened.to).toBe("/settings");
  });

  it("treats an arbitrary sign-in destination as the default", async () => {
    const running = await started();

    await running.browser.post("/sign-in", {
      email: PERSON,
      destination: "https://evil.example",
    });
    const action = actionIn(running.mails.at(-1));
    const opened = await running.browser.from(running.url).post("/sign-in/open", {
      token: action.searchParams.get("token") ?? "",
    });

    expect(opened.to).toBe("/cards");
  });

  it("sends a signed-in browser that opens a spent, expired or unknown link to its own start", async () => {
    // The browser decides, never the link: the answer is the same whoever the
    // link was for.
    const running = await started();
    await running.identity.make(OTHER, running.theMerchant);
    await running.browser.post("/sign-in", { email: OTHER });
    const theirs = actionIn(running.mails.at(-1)).searchParams.get("token") ?? "";
    const stranger = await running.another();
    await stranger.from(running.url).post("/sign-in/open", { token: theirs });
    await running.browser.signIn();
    const expired = (): string => {
      for (const row of running.rows.dashboard_verifications ?? []) {
        row.expiresAt = new Date(Date.now() - 1_000);
      }
      return "";
    };
    rewindLinkSends(running.rows);
    await running.browser.post("/sign-in", { email: PERSON });
    const soonExpired = actionIn(running.mails.at(-1)).searchParams.get("token") ?? "";
    expired();

    for (const token of [theirs, soonExpired, "A".repeat(32)]) {
      const pressed = await running.browser.from(running.url).post("/sign-in/open", { token });
      expect(pressed.status, token).toBe(303);
      expect(pressed.to, token).toBe("/cards");
      const landed = await running.browser.get(`/sign-in/open?token=${token}`);
      expect(landed.status, token).toBe(303);
      expect(landed.to, token).toBe("/cards");
    }

    running.forgetMerchant(PERSON);
    const withoutMerchant = await running.browser
      .from(running.url)
      .post("/sign-in/open", { token: theirs });
    expect(withoutMerchant.to).toBe(LATEST_REPORT);
  });

  it("refuses a spent and an unknown link the same way when nobody is signed in", async () => {
    const running = await started();
    await running.browser.post("/sign-in", { email: PERSON });
    const token = actionIn(running.mails.at(-1)).searchParams.get("token") ?? "";
    const first = await running.another();
    await first.from(running.url).post("/sign-in/open", { token });

    const spent = await running.browser.from(running.url).post("/sign-in/open", { token });
    const unknown = await running.browser
      .from(running.url)
      .post("/sign-in/open", { token: "B".repeat(32) });
    const landedSpent = await running.browser.get(`/sign-in/open?token=${token}`);

    expect(spent.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(landedSpent.status).toBe(401);
    expect(readable(spent.html)).toBe(readable(unknown.html));
    expect(readable(landedSpent.html)).toBe(readable(unknown.html));
    expect(readable(spent.html)).not.toContain(PERSON);
    expect(spent.headers.getSetCookie()).toStrictEqual([]);
  });

  it("sends the press on a report link to that report, whatever the browser posts beside it", async () => {
    // The destination was recorded with the token; nothing the browser sends is
    // read as one.
    const running = await started();
    const scan = "019b41a0-7c51-7d63-84bd-a5a20faef497";
    await running.identity.sendReportLink({
      operation: "send",
      email: FRESH.email,
      destination: { report: scan },
      request: "019b41a0-7c51-7d63-84bd-a5a20faef498",
    });
    const action = actionIn(running.mails.at(-1));
    const token = action.searchParams.get("token") ?? "";

    const landing = await running.browser.get(`${action.pathname}${action.search}`);
    expect(readable(landing.html)).toContain(FRESH.email);

    const opened = await running.browser.from(running.url).post(action.pathname, {
      token,
      destination: "https://evil.example",
    });

    expect(opened.status).toBe(303);
    expect(opened.to).toBe(`/report/${scan}`);
    expect((await running.identity.byEmail(FRESH.email))?.merchant).toBeNull();
  });

  it("does not retain the retired password, registration, or confirmation routes", async () => {
    const running = await started();
    await running.browser.signIn();

    for (const path of ["/register", "/password", "/password/forgot", "/confirm"]) {
      const answer = await running.browser.get(path);
      expect(answer.status, path).toBe(404);
    }
  });
});

describe("one session for the whole site", () => {
  it("sets one cookie for the whole origin over https: prefixed, Secure, HttpOnly and Lax", async () => {
    // A report and the dashboard are two applications on one origin sharing one
    // session, so a cookie scoped to the dashboard's path would leave a person
    // a stranger at the report; the prefix stops a sibling host planting or
    // replacing it.
    const running = await started({ base: "/dashboard", dashboard: { COOKIE_SECURE: "true" } });
    await running.browser.post("/dashboard/sign-in", { email: PERSON });
    const action = actionIn(running.mails.at(-1));

    const opened = await running.browser
      .from(running.url)
      .post("/dashboard/sign-in/open", { token: action.searchParams.get("token") ?? "" });

    const line = sessionCookieIn(opened, SECURE_COOKIE);
    expect(line).toBeDefined();
    const attributes = attributesOf(line ?? "");
    expect(attributes.get("path")).toBe("/");
    expect(attributes.get("samesite")?.toLowerCase()).toBe("lax");
    expect(attributes.has("httponly")).toBe(true);
    expect(attributes.has("secure")).toBe(true);
    expect(attributes.has("domain")).toBe(false);
    expect(Number(attributes.get("max-age"))).toBe(THIRTY_DAYS_SECONDS);
    // Nothing under the unprefixed name goes out on the https origin.
    expect(sessionCookieIn(opened, COOKIE)).toBeUndefined();
    // The same session at the root.
    expect((await running.browser.get("/dashboard/cards")).status).toBe(200);
  });

  it("sets the same cookie without the prefix or Secure on the plain-http local origin", async () => {
    // A Secure cookie is never sent back over plain http, so the laptop's
    // origin gets neither prefix nor Secure. Mounted under /dashboard so a
    // cookie scoped to the mount point would show: on https the prefix forces
    // the root path.
    const running = await started({ base: "/dashboard" });
    await running.browser.post("/dashboard/sign-in", { email: PERSON });
    const action = actionIn(running.mails.at(-1));

    const opened = await running.browser
      .from(running.url)
      .post("/dashboard/sign-in/open", { token: action.searchParams.get("token") ?? "" });

    const line = sessionCookieIn(opened, COOKIE);
    expect(line).toBeDefined();
    const attributes = attributesOf(line ?? "");
    expect(attributes.get("path")).toBe("/");
    expect(attributes.get("samesite")?.toLowerCase()).toBe("lax");
    expect(attributes.has("httponly")).toBe(true);
    expect(attributes.has("secure")).toBe(false);
    expect(sessionCookieIn(opened, SECURE_COOKIE)).toBeUndefined();
  });

  it("keeps a returning person signed in: a visit a day on moves the end to thirty days from it", async () => {
    // The row's end moves, and the browser gets the renewed cookie, or the
    // cookie would expire thirty days after sign-in however often its person
    // came back.
    const running = await started();
    await running.browser.signIn();
    const aDayAndAnHourAgo = Date.now() - 25 * 60 * 60 * 1_000;
    for (const session of sessionRows()) {
      session.expiresAt = new Date(aDayAndAnHourAgo + THIRTY_DAYS_SECONDS * 1_000);
    }

    const visited = await running.browser.get("/cards");

    expect(visited.status).toBe(200);
    const line = sessionCookieIn(visited, COOKIE);
    expect(line).toBeDefined();
    expect(Number(attributesOf(line ?? "").get("max-age"))).toBe(THIRTY_DAYS_SECONDS);
    const [row] = sessionRows();
    expect(new Date(row?.expiresAt as Date).getTime()).toBeGreaterThan(
      Date.now() + (THIRTY_DAYS_SECONDS - 60) * 1_000,
    );
  });

  it("writes nothing and hands out nothing on a second visit inside the same day", async () => {
    // Renewal is once a day: a cookie set on every answer would be a
    // sessions-table write on every click.
    const running = await started();
    await running.browser.signIn();
    const before = structuredClone(sessionRows());

    const visited = await running.browser.get("/cards");

    expect(visited.status).toBe(200);
    expect(sessionCookieIn(visited, COOKIE)).toBeUndefined();
    expect(sessionRows()).toStrictEqual(before);
  });

  it("clears the site-wide cookie on sign-out, with the attributes the prefix demands", async () => {
    // A prefixed cookie is replaced only by a Secure line for the whole origin,
    // and a path-scoped clear would miss a cookie set at the root.
    const running = await started({ base: "/dashboard", dashboard: { COOKIE_SECURE: "true" } });
    await running.browser.signIn();

    const out = await running.browser.from(running.url).post("/dashboard/sign-out");

    expect(out.status).toBe(303);
    const line = sessionCookieIn(out, SECURE_COOKIE);
    expect(line).toBeDefined();
    const attributes = attributesOf(line ?? "");
    expect(attributes.get("path")).toBe("/");
    expect(attributes.has("secure")).toBe(true);
    expect(new Date(attributes.get("expires") ?? "").getTime()).toBeLessThan(Date.now());
    expect(running.rows.dashboard_sessions).toStrictEqual([]);
  });
});

/**
 * Read rather than listed, so a rule held for every route holds for a route
 * added later.
 */
const routesOf = (running: Running): { method: string; path: string }[] => {
  const listed = buildApp(
    loadConfig({
      DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
      AUTH_SECRET: "x".repeat(44),
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "sandbox:scripted",
    }),
    { gateway: running.harnessed.gateway, identity: running.identity, wooShops: memoryWooShops() },
  );
  return (
    listed.router.stack as { route?: { path: string; methods: Record<string, boolean> } }[]
  ).flatMap(({ route }) =>
    route === undefined
      ? []
      : Object.keys(route.methods).map((method) => ({
          method,
          path: route.path.replaceAll(/:[a-z_]+/g, "x"),
        })),
  );
};

describe("the operator flag", () => {
  it("is moved by no request a browser can send to the dashboard", async () => {
    // Only the terminal's command grants the operator flag, so a signed-in
    // person sends every route a flag of its own (as a form, as JSON, in the
    // query) and is no operator afterwards. Most handlers stop early on missing
    // fields or an unknown identifier; what this holds is that none takes the
    // flag from a request, not that every line behind those refusals ran.
    const running = await started({ wooShops: memoryWooShops() });
    await running.browser.signIn();
    const routes = routesOf(running);
    expect(routes.filter(({ method }) => method === "post").length).toBeGreaterThan(10);

    // Signing out ends the session the rest are sent with, so it goes last.
    const lastly = (path: string) => (path.endsWith("/sign-out") ? 1 : 0);
    for (const { method, path } of routes.sort(
      (one, other) => lastly(one.path) - lastly(other.path),
    )) {
      if (method === "get") {
        await running.browser.get(`${path}?operator=true`);
        continue;
      }
      await running.browser.post(path, { operator: "true" });
      await running.browser.postRaw(path, "application/json", JSON.stringify({ operator: true }));
    }

    const accounts = await running.identity.list(new Date());
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts.filter(({ operator }) => operator)).toStrictEqual([]);
  });
});

describe("the gate", () => {
  it("lets a visitor with no session reach only the sign-in pages, the stylesheet, the health probe and the shop's callback and return", async () => {
    // Every route on this list answers a stranger without the sign-in redirect,
    // and any other route, an unknown one included, is behind the gate.
    const running = await started({ base: "/dashboard", wooShops: memoryWooShops() });
    // A cookie that no longer opens anything, so the gate answers with the
    // reason the session ended, which no route above the gate gives. The shop's
    // callback carries no cookie at all, which the gate answers as "not kept".
    const stranger = running.browser.withRawCookie(`${COOKIE}=made-up-identifier`);
    const gate = (answer: Visit): boolean =>
      answer.status === 303 && /reason=(session-ended|unsaved)/.test(answer.to ?? "");

    const above: readonly [string, () => Promise<Visit>][] = [
      ["the sign-in", () => stranger.get("/dashboard/sign-in")],
      ["asking for a link", () => stranger.post("/dashboard/sign-in", { email: "" })],
      ["the sign-out", () => stranger.post("/dashboard/sign-out")],
      [
        "the page a link lands on",
        () => stranger.get(`/dashboard/sign-in/open?token=${"C".repeat(32)}`),
      ],
      ["pressing it", () => stranger.post("/dashboard/sign-in/open", { token: "C".repeat(32) })],
      ["the stylesheet", () => stranger.get("/dashboard/agentify.css")],
      ["the health probe", () => stranger.get("/dashboard/healthz")],
      [
        "the shop's callback",
        () => running.browser.postRaw("/dashboard/woocommerce/callback", "application/json", "{}"),
      ],
      ["the shop's return", () => stranger.get("/dashboard/woocommerce/return")],
    ];
    for (const [name, visit] of above) {
      const answer = await visit();
      expect(gate(answer), name).toBe(false);
      expect(answer.status, name).toBeLessThan(500);
    }

    for (const path of [
      "/dashboard/",
      "/dashboard/cards",
      "/dashboard/merchant",
      "/dashboard/settings",
    ]) {
      expect(gate(await stranger.get(path)), path).toBe(true);
    }
    for (const path of ["/dashboard/merchant", "/dashboard/report-handoff", "/dashboard/keys"]) {
      expect(gate(await stranger.post(path)), path).toBe(true);
    }
  });
});

describe("choosing the name buyers read", () => {
  it("asks for the name on a screen of its own, with room to say what it is for", async () => {
    // Here the screen can say what the name does, show what one looks like and
    // promise it can be changed, which decides whether what arrives is a name
    // or "some stuff".
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    const screen = await running.browser.get("/choose-name");
    const text = readable(screen.html);

    expect(screen.status).toBe(200);
    expect(screen.html).toContain('name="seller_name"');
    // What it is for: buyers read it beside the products.
    expect(text).toMatch(/buyers/i);
    expect(text).toMatch(/name people already know/i);
    // The catalogue's rule, before anybody types.
    expect(text).toMatch(/32 characters/);
    // That it can be changed, and where.
    expect(text).toMatch(/change/i);
    expect(screen.html).toContain('href="/settings"');
    // A way past it, for somebody who has not decided.
    expect(screen.html).toContain('href="/cards"');
  });

  it("writes the name and takes the merchant on to their cards", async () => {
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    const chosen = await running.browser.post("/choose-name", { seller_name: "Bright Data Plans" });

    expect(chosen.status).toBe(303);
    expect(chosen.to).toBe("/cards");
    expect(await listedAs(running)).toBe("Bright Data Plans");
  });

  it("lets a merchant walk past it, and says on their cards what that costs", async () => {
    // Skipping is allowed, but not silently: a merchant whose code then
    // publishes a card meets a refusal, and the dashboard says so first.
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    const cards = await running.browser.get("/cards");
    const text = readable(cards.html);

    expect(cards.status).toBe(200);
    expect(text).toMatch(/cannot publish products until you choose the seller name/i);
    expect(cards.html).toContain('href="/settings"');
    expect(await listedAs(running)).toBeNull();
  });

  it("refuses a name the catalogue that lists it would not carry, and says the rule", async () => {
    // The rule is thirty-two ordinary keyboard characters with no space at
    // either end. Refused here, the person gets it in the screen's words, and
    // nothing is written.
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    for (const name of ["x".repeat(33), "Кириллица", "  "]) {
      const answered = await running.browser.post("/choose-name", { seller_name: name });
      expect(answered.status, name).toBe(400);
      expect(readable(answered.html), name).toMatch(/not saved|name is needed/i);
      expect(await listedAs(running), name).toBeNull();
    }
  });

  it("refuses a post with no name in it at all, and says the field is the one thing needed", async () => {
    // An empty field and a missing one (a post not from this page) are both no
    // name, and the screen says so rather than writing an empty one.
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    const answered = await running.browser.post("/choose-name");

    expect(answered.status).toBe(400);
    expect(readable(answered.html)).toMatch(/name is needed/i);
    // The way past stays, for somebody with nothing to type.
    expect(answered.html).toContain('href="/cards"');
    expect(await listedAs(running)).toBeNull();
  });

  it("takes the space off a name rather than refusing it for one", async () => {
    // A leading space is a typing accident, and a padded name would survive the
    // catalogue as a second spelling, so it is trimmed.
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    const chosen = await running.browser.post("/choose-name", {
      seller_name: "  Bright Data Plans  ",
    });

    expect(chosen.status).toBe(303);
    expect(await listedAs(running)).toBe("Bright Data Plans");
  });

  it("is behind the gate, like every other screen in the dashboard", async () => {
    const running = await started();

    const screen = await running.browser.get("/choose-name");
    const posted = await running.browser.post("/choose-name", { seller_name: "Anybody At All" });

    expect(screen.to).toBe("/sign-in");
    expect(posted.to).toBe(UNSAVED);
  });
});

describe("the settings screen", () => {
  it("is reachable from every screen a merchant works on", async () => {
    // A merchant has to be able to find it without being sent a link.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts", "/keys"]) {
      const screen = await browser.get(path);
      expect(screen.status, path).toBe(200);
      expect(screen.html, path).toContain('href="/settings"');
    }
  });

  it("shows the name this merchant is listed under", async () => {
    const { browser, harnessed } = await started();
    await browser.signIn();

    const screen = await browser.get("/settings");

    expect(screen.status).toBe(200);
    expect(screen.html).toContain(`value="${harnessed.merchant.name}"`);
  });

  it("changes the name, and the gateway has the new one afterwards", async () => {
    const running = await started();
    await running.browser.signIn();

    const saved = await running.browser.post("/settings", { seller_name: "Bright Data Plans" });

    expect(saved.status).toBe(303);
    expect(saved.to).toBe("/settings");
    expect(await listedAs(running)).toBe("Bright Data Plans");
    const after = await running.browser.get("/settings");
    expect(after.html).toContain('value="Bright Data Plans"');
  });

  it("refuses to take the name away, and says what to do instead", async () => {
    // Emptying the name would leave the cards on sale under nobody; stopping
    // selling is what does what the merchant wants, and the screen says so.
    const running = await started();
    await running.browser.signIn();

    for (const form of [{ seller_name: "" }, {}] as Record<string, string>[]) {
      const emptied = await running.browser.post("/settings", form);
      expect(emptied.status).toBe(400);
      expect(readable(emptied.html)).toMatch(/stop.*selling/i);
      expect(await listedAs(running)).toBe(running.harnessed.merchant.name);
    }
  });

  it("offers no control that removes the name", async () => {
    // The refusal is the rule; a button that provoked it would only ever
    // produce a refusal page.
    const { browser } = await started();
    await browser.signIn();

    const text = readable((await browser.get("/settings")).html);

    expect(text).toMatch(/cannot|never/i);
    expect(text).toMatch(/stop.*selling/i);
    // The rule, on the page rather than only in a refusal.
    expect(text).toMatch(/32 characters/);
  });

  it("takes the shop's site beside the name, and the gateway has it afterwards", async () => {
    // The site is set where the name is, and is where an agent with a question
    // the order cannot answer is sent.
    const running = await started();
    await running.browser.signIn();

    const before = await running.browser.get("/settings");
    expect(before.html).toContain('id="seller_site"');

    const saved = await running.browser.post("/settings/site", {
      seller_site: "https://brightdataplans.example",
    });

    expect(saved.status).toBe(303);
    expect(saved.to).toBe("/settings");
    expect(await sitedAt(running)).toBe("https://brightdataplans.example");
    // Giving a site does not rename anybody.
    expect(await listedAs(running)).toBe(running.harnessed.merchant.name);
    const after = await running.browser.get("/settings");
    expect(after.html).toContain('value="https://brightdataplans.example"');
  });

  it("refuses a site with anything after the host, says the form it takes, and keeps the one there was", async () => {
    const running = await started();
    await running.browser.signIn();
    await running.browser.post("/settings/site", {
      seller_site: "https://brightdataplans.example",
    });

    const answered = await running.browser.post("/settings/site", {
      seller_site: "https://brightdataplans.example/contact",
    });

    expect(answered.status).toBe(400);
    expect(readable(answered.html)).toMatch(/not saved/i);
    expect(readable(answered.html)).toContain("https://");
    // What was typed stays in the box to be corrected.
    expect(answered.html).toContain('value="https://brightdataplans.example/contact"');
    expect(await sitedAt(running)).toBe("https://brightdataplans.example");
  });

  it("refuses an emptied site box rather than reading it as taking the site away", async () => {
    const running = await started();
    await running.browser.signIn();
    await running.browser.post("/settings/site", {
      seller_site: "https://brightdataplans.example",
    });

    const emptied = await running.browser.post("/settings/site", { seller_site: "" });

    expect(emptied.status).toBe(400);
    expect(await sitedAt(running)).toBe("https://brightdataplans.example");
  });

  it("refuses a name outside the rule and leaves the one there was", async () => {
    const running = await started();
    await running.browser.signIn();

    const answered = await running.browser.post("/settings", { seller_name: "x".repeat(33) });

    expect(answered.status).toBe(400);
    // Nothing was written, which the merchant cannot see for themselves, and
    // the page still shows what they are listed under.
    expect(readable(answered.html)).toMatch(/not saved/i);
    expect(readable(answered.html)).toMatch(/printable ASCII/i);
    expect(answered.html).toContain(`value="${"x".repeat(33)}"`);
    expect(readable(answered.html)).toContain(running.harnessed.merchant.name);
    expect(await listedAs(running)).toBe(running.harnessed.merchant.name);
  });

  it("keeps the ways to connect a catalogue under Integrations, a tab of their own", async () => {
    // Integrations are not looked for halfway down the settings, under the name
    // and the wallet.
    const { browser } = await started();
    await browser.signIn();

    const cards = await browser.get("/cards");
    expect(cards.html).toContain('href="/integrations"');

    const integrations = await browser.get("/integrations");
    expect(integrations.status).toBe(200);
    const current = /aria-current="page">([\s\S]*?)<\/span>/.exec(integrations.html)?.[1] ?? "";
    expect(readable(current)).toContain("Integrations");
    expect(integrations.html).toContain('href="/docs/quickstart"');
    expect(integrations.html).toContain('href="/keys?new=key"');
    // No shop store is configured here, so no WooCommerce way is offered.
    expect(readable(integrations.html)).not.toMatch(/WooCommerce/);

    const settings = await browser.get("/settings");
    expect(settings.html).not.toContain('href="/docs/quickstart"');
    expect(settings.html).not.toContain('href="/keys?new=key"');
  });

  it("opens the keys screen on the new-key form when asked from the integrations", async () => {
    // "Create an API key" would otherwise land at the top of the key list.
    const { browser } = await started();
    await browser.signIn();

    const integrations = await browser.get("/integrations");
    const href = /href="([^"]*)"[^>]*>Create an API key</.exec(integrations.html)?.[1];
    expect(href).toBe("/keys?new=key");

    const keys = await browser.get("/keys?new=key");
    expect(keys.html).toMatch(/<input id="label"[^>]*autofocus/);
    expect((await browser.get("/keys")).html).not.toMatch(/<input id="label"[^>]*autofocus/);
  });

  it("leads the wallet form's address, opened again, to the settings it lives on", async () => {
    const { browser } = await started();
    await browser.signIn();

    const answered = await browser.get("/settings/payout-wallet");

    expect(answered.status).toBe(303);
    expect(answered.to).toBe("/settings");
  });

  it("answers an emptied box with the control that does what they meant", async () => {
    // Both sentences refuse; the question is which one the merchant reads. Told
    // the rule, somebody tries a shorter name; told about the selling switch,
    // they find the control that leaves their cards where they can put them
    // back.
    const running = await started();
    await running.browser.signIn();

    const answered = await running.browser.post("/settings", { seller_name: "   " });

    expect(answered.status).toBe(400);
    expect(readable(answered.html)).toMatch(/to stop selling, use pause all sales/i);
    // The rule's sentence would refuse too, but would not answer what they
    // meant.
    expect(readable(answered.html)).not.toMatch(/not a name the catalogue will carry/i);
    expect(await listedAs(running)).toBe(running.harnessed.merchant.name);
  });

  it("says the gateway would not answer rather than drawing a page with no name on it", async () => {
    const running = await started({ answerWithinMs: 100 });
    await running.browser.signIn();
    running.silenceGateway();

    const screen = await running.browser.get("/settings");

    expect(screen.status).toBe(504);
    expect(readable(screen.html)).toMatch(/did not answer/i);
  });
});

describe("the account on the settings screen", () => {
  it("names the email link as the only way back in and offers no password control", async () => {
    const { browser } = await started();
    await browser.signIn();

    const screen = await browser.get("/settings");

    expect(readable(screen.html)).toMatch(/one-time link/i);
    expect(screen.html).not.toContain('type="password"');
    expect(screen.html).not.toContain('action="/password"');
  });
});

describe("the address a merchant's money arrives at", () => {
  /**
   * Of the right shape and obviously nobody's. Two spellings: the lower case a
   * block explorer prints, and the checksummed mixed case a wallet shows,
   * computed rather than typed, because a hand-written checksum can be wrong
   * and would let these tests pass against a gateway that stopped checking.
   */
  const LOWER = "0x0123456789abcdef0123456789abcdef01234567";
  const AS_A_WALLET_SHOWS_IT = checksummedAddressOf(LOWER);

  it("is asked for on the settings screen", async () => {
    // A merchant with nowhere to be paid has to find the box without being sent
    // a link.
    const { browser } = await started();
    await browser.signIn();

    const screen = await browser.get("/settings");

    expect(screen.status).toBe(200);
    expect(screen.html).toContain('name="payout_wallet"');
    expect(readable(screen.html)).toMatch(/payout wallet/i);
  });

  it("is saved, and the whole of it is on the page afterwards", async () => {
    const running = await started();
    await running.browser.signIn();

    const saved = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: AS_A_WALLET_SHOWS_IT,
    });

    expect(saved.status).toBe(303);
    expect(saved.to).toBe("/settings");
    expect(await paidInto(running)).toBe(AS_A_WALLET_SHOWS_IT);
    // Read back whole, never shortened: shortening is where a wrong address and
    // the right one look the same.
    const after = await running.browser.get("/settings");
    expect(after.html.replaceAll(/<[^>]*>/g, "")).toContain(AS_A_WALLET_SHOWS_IT);
  });

  it("shows an address pasted in lower case the way the merchant's wallet shows it", async () => {
    // The gateway answers in the wallet's spelling, the one a person recognises
    // without comparing character by character, so a merchant who pasted lower
    // case reads their own wallet's spelling back.
    const running = await started();
    await running.browser.signIn();

    const saved = await running.browser.post("/settings/payout-wallet", { payout_wallet: LOWER });

    expect(saved.status).toBe(303);
    expect(await paidInto(running)).toBe(AS_A_WALLET_SHOWS_IT);
    expect((await running.browser.get("/settings")).html.replaceAll(/<[^>]*>/g, "")).toContain(
      AS_A_WALLET_SHOWS_IT,
    );
  });

  it("refuses a spelling whose capitals disagree with the rest and says which it is", async () => {
    // Capitals that do not check out mean a wrong character, and a wrong
    // address is somebody else's valid one; "that is not an address" would be
    // untrue here.
    const mangled = `0x${AS_A_WALLET_SHOWS_IT.slice(2).toUpperCase()}`;
    expect(mangled, "the fixture has capitals a wallet would not print").not.toBe(
      AS_A_WALLET_SHOWS_IT,
    );
    const running = await started();
    await running.browser.signIn();
    const before = await paidInto(running);

    const answered = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: mangled,
    });

    expect(answered.status).toBe(400);
    // The seeded merchant is already paid somewhere, and a refusal must leave
    // that alone.
    expect(await paidInto(running)).toBe(before);
    const text = readable(answered.html);
    expect(text).toMatch(/capital letters/i);
    expect(text).toMatch(/not saved/i);
    expect(answered.html).toContain(`value="${mangled}"`);
  });

  it("takes the space off what was pasted rather than refusing it", async () => {
    // A wallet often hands an address over with a trailing newline; refusing it
    // would refuse a merchant who did the right thing.
    const running = await started();
    await running.browser.signIn();

    const saved = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: `  ${AS_A_WALLET_SHOWS_IT}\n`,
    });

    expect(saved.status).toBe(303);
    expect(await paidInto(running)).toBe(AS_A_WALLET_SHOWS_IT);
  });

  it("refuses an address of the wrong shape and sends nothing", async () => {
    const running = await started();
    await running.browser.signIn();
    await running.browser.post("/settings/payout-wallet", {
      payout_wallet: AS_A_WALLET_SHOWS_IT,
    });

    const answered = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: `${AS_A_WALLET_SHOWS_IT}0`,
    });

    expect(answered.status).toBe(400);
    // What was refused, that nothing was written, and where the money still
    // goes.
    expect(readable(answered.html)).toMatch(/not saved/i);
    expect(answered.html.replaceAll(/<[^>]*>/g, "")).toContain(AS_A_WALLET_SHOWS_IT);
    expect(await paidInto(running)).toBe(AS_A_WALLET_SHOWS_IT);
  });

  it("refuses an empty box and says what to paste into it", async () => {
    const running = await started();
    await running.browser.signIn();
    const before = await paidInto(running);

    for (const form of [{ payout_wallet: "" }, {}] as Record<string, string>[]) {
      const answered = await running.browser.post("/settings/payout-wallet", form);
      expect(answered.status).toBe(400);
      expect(readable(answered.html)).toMatch(/address is needed/i);
      // An empty box is how a merchant would try to stop being paid here, and
      // it cannot do that: the money goes where it went.
      expect(await paidInto(running)).toBe(before);
    }
  });
});

describe("a merchant who has chosen no name", () => {
  it("is told on every screen they work on that nothing of theirs can go on sale", async () => {
    const running = await started();
    await publish(running.gateway, roomCard);
    await unname(running);
    await running.browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts"]) {
      const screen = await running.browser.get(path);
      const text = readable(screen.html);
      expect(screen.status, path).toBe(200);
      expect(text, path).toMatch(/cannot publish products until you choose the seller name/i);
    }
    // The page it points to is the one that fixes it.
    const settings = await running.browser.get("/settings");
    expect(settings.status).toBe(200);
    expect(settings.html).toContain('name="seller_name"');
  });

  it("is told nothing of the sort once the name is chosen", async () => {
    // A banner that never leaves is one nobody reads.
    const running = await started();
    await publish(running.gateway, roomCard);
    await running.browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts"]) {
      const text = readable((await running.browser.get(path)).html);
      expect(text, path).not.toMatch(/cannot publish products until you choose the seller name/i);
    }
  });

  it("reads the refusal their own code meets in the dashboard's words, not the gateway's", async () => {
    // The refusal a merchant's code gets names an API route; a person in the
    // dashboard cannot make that call, so the screen names what is missing and
    // links the page that sets it.
    const running = await started();
    await unname(running);
    const refused = await running.gateway.call("POST", "/v0/catalog/publish", {
      body: roomCard,
      headers: { authorization: `Bearer ${KEY}` },
    });
    const finding = (refused.body as { error: { problems: { code: string; message: string }[] } })
      .error.problems[0];
    await running.browser.signIn();

    const cards = await running.browser.get("/cards");
    const text = readable(cards.html);

    // The gateway really refused, for this reason.
    expect(refused.status).toBe(422);
    expect(finding?.code).toBe("no_seller_name");
    expect(finding?.message).toContain("POST /v0/seller-name");
    // The dashboard says the same without sending anybody to a route.
    expect(text).toMatch(/cannot publish products until you choose the seller name/i);
    expect(cards.html).toContain('href="/settings"');
    expect(text).not.toContain("POST /v0/seller-name");
  });
});

describe("the way out to the documentation", () => {
  it("is on every screen a merchant works on, and leaves the dashboard's mount point", async () => {
    // The documentation is beside the dashboard on one origin, not under it, so
    // a link that kept the mount point would lead to /dashboard/docs/, which
    // nothing answers.
    const { browser, gateway } = await started({ base: "/dashboard" });
    await publish(gateway, roomCard);
    await browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts", "/keys", "/settings"]) {
      const screen = await browser.get(`/dashboard${path}`);
      expect(screen.status, path).toBe(200);

      // Found by where it goes and read for its words: an anchor with nothing
      // in it would satisfy a check for the address alone.
      const out = /<a[^>]+href="\/docs\/"[^>]*>([^<]+)<\/a>/.exec(screen.html);
      expect(out?.[1]?.trim(), `${path} has no readable link to the documentation`).toBeTruthy();
    }
  });
});

describe("the cards screen", () => {
  it("gives each card the whole address an agent buys it at, and it is one that works", async () => {
    // The whole address, carrying our catalog identifier rather than the
    // merchant's own: a merchant who pasted theirs into it would get a 404 from
    // a working gateway.
    const running = await started({ dashboard: { PUBLIC_BASE_URL: "https://shop.example.com" } });
    const itemId = await publish(running.gateway, roomCard);
    await running.browser.signIn();

    const screen = await running.browser.get("/cards");
    const shown = /https:\/\/shop\.example\.com(\/x402\/\S+?\/purchase)/.exec(
      readable(screen.html),
    );

    expect(shown?.[1], "the cards screen names the address").toBe(`/x402/${itemId}/purchase`);
    // An agent asking at that path gets the payment challenge, not a 404.
    expect(await purchasable(running.gateway, itemId)).toBe(true);
    // Text, not a link: asking without paying is answered in a header with no
    // page, so a click would show a blank window.
    expect(screen.html).not.toContain('href="https://shop.example.com/x402/');
  });

  it("shows each card with its key, price, delivery and state", async () => {
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await publish(gateway, esimCard);

    const text = readable((await browser.signIn()).html);

    expect(text).toContain("A room for the night");
    expect(text).toContain("SKU 100/1");
    expect(text).toContain("80.00 USD");
    expect(text).toContain("immediate");
    expect(text).toContain("eSIM Europe, 5 GB for 30 days");
    expect(text).toContain("8.00 USD");
    expect(text).toContain("later");
    expect(text).toContain("Delivery within 4 hours");
    expect(text).toContain("sales enabled");
  });

  it("shows every promise a card makes, not the first one it finds", async () => {
    // Showing only the price check would leave a row that never mentions the
    // deadline the merchant answers for.
    const { browser, gateway } = await started();
    await publish(gateway, {
      ...esimCard,
      merchant_item_id: "esim-live-priced",
      price_check: "handler",
      fulfill_deadline_seconds: 3_600,
    });

    const text = readable((await browser.signIn()).html);

    expect(text).toContain("Price asked at purchase");
    expect(text).toContain("delivery within 1 hour");
  });

  it("says so plainly when a merchant has published nothing", async () => {
    const { browser } = await started();

    const screen = await browser.signIn();
    const text = readable(screen.html);

    expect(text).toContain("haven't published any cards yet");
    expect(screen.html).toContain('href="/docs/quickstart"');
  });

  it("puts a merchant's own text on the page as text, whatever is in it", async () => {
    // A card title is text somebody else wrote: the contract refuses markup but
    // not the characters it is made of, so they must arrive as characters. The
    // merchant's own key is held to no such rule, so it carries a tag.
    const { browser, gateway } = await started();
    await publish(gateway, {
      ...roomCard,
      merchant_item_id: "a&b<c>",
      title: 'Tom & Jerry <"the box set">',
    });

    const page = (await browser.signIn()).html;

    // Not one character of the title reaches the page as markup...
    expect(page).not.toContain("Jerry <");
    expect(page).not.toContain("a&b");
    expect(page).toContain("Tom &amp; Jerry &lt;&quot;the box set&quot;&gt;");
    // ...and the merchant still reads their product's name unchanged.
    expect(readable(page)).toContain('Tom & Jerry <"the box set">');
    expect(readable(page)).toContain("a&b<c>");
  });

  it("pauses one card, and that card stops selling", async () => {
    // The state on the page and what an agent's purchase meets are the same
    // fact.
    const { browser, gateway } = await started();
    const room = await publish(gateway, roomCard);
    const esim = await publish(gateway, esimCard);
    await browser.signIn();

    const paused = await browser.post(`/cards/${encodeURIComponent(room)}/pause`);
    const text = readable((await browser.get("/cards")).html);

    expect(paused.to).toBe("/cards");
    expect(text).toContain("paused");
    expect(text).toContain("Resume");
    expect(await purchasable(gateway, room)).toBe(false);
    // The negative control: the switch is per card, so the other one still
    // sells.
    expect(await purchasable(gateway, esim)).toBe(true);
    expect((await gateway.call("GET", "/x402/catalog")).body).toMatchObject({
      items: [{ title: "eSIM Europe, 5 GB for 30 days" }],
    });
  });

  it("puts a paused card back on sale", async () => {
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();
    await browser.post(`/cards/${encodeURIComponent(itemId)}/pause`);

    await browser.post(`/cards/${encodeURIComponent(itemId)}/resume`);

    expect(await purchasable(gateway, itemId)).toBe(true);
    expect(readable((await browser.get("/cards")).html)).toContain("Pause");
  });

  it("stops all selling from one control, and starts it again", async () => {
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();

    await browser.post("/selling/pause");
    const stopped = readable((await browser.get("/cards")).html);

    expect(stopped).toContain("All selling is stopped");
    expect(stopped).toContain("Resume all sales");
    expect(await purchasable(gateway, itemId)).toBe(false);

    await browser.post("/selling/resume");

    expect(await purchasable(gateway, itemId)).toBe(true);
    expect(readable((await browser.get("/cards")).html)).toContain("Pause all sales");
  });

  it("does not promise a merchant that the orders they accepted get fulfilled", async () => {
    // On the SDK path the merchant's own code fulfils, and an accepted order
    // nobody delivers ends owing a refund; told a pause leaves orders
    // "fulfilled", a merchant might switch that code off.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    expect(readable((await browser.get("/cards")).html)).not.toMatch(/fulfil/i);
    await browser.post("/selling/pause");
    expect(readable((await browser.get("/cards")).html)).not.toMatch(/fulfil/i);
  });

  it("tells a merchant which switch is holding a card off sale", async () => {
    // With everything stopped, an unpaused card reads paused and resuming it
    // changes nothing, so the screen says which switch holds it.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    await browser.post("/selling/pause");
    const html = (await browser.get("/cards")).html;

    expect(readable(html)).toContain("All selling is stopped");
    expect(html).not.toContain(">Resume<");
  });

  it("leaves a card paused when it is published again", async () => {
    // A merchant editing a price is not asking for a paused product to go back
    // on sale.
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();
    await browser.post(`/cards/${encodeURIComponent(itemId)}/pause`);

    await publish(gateway, { ...roomCard, price: { amount: "90.00", currency: "USD" } });
    const text = readable((await browser.get("/cards")).html);

    expect(text).toContain("90.00 USD");
    expect(text).toContain("paused");
    expect(await purchasable(gateway, itemId)).toBe(false);
  });
});

describe("a card held off sale by what its merchant lacks", () => {
  // The control beside a card names what holds it off sale in the gateway's
  // terms. A card nobody paused, of a merchant who is selling, reads paused
  // only because the merchant lacks something the gateway asks of every
  // merchant; "All selling is stopped" there would send them looking for a
  // switch nobody pressed. Settings are named and linked; the operator's
  // approval is said to be still to come exactly where it is asked for.
  //
  // Each merchant is registered by the dashboard's press, never approved, and
  // its card written straight into the gateway's store, since publishing would
  // be refused for the very reason under test.
  const CHANNELS = {
    sandbox: { PAYMENT_NETWORK: "eip155:84532", FACILITATOR_URL: "sandbox:scripted" },
    test: { PAYMENT_NETWORK: "eip155:84532", FACILITATOR_URL: "https://x402.org/facilitator" },
    live: {
      PAYMENT_NETWORK: "eip155:8453",
      FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
    },
  } as const;
  type Channel = keyof typeof CHANNELS;
  const LIVE_GATEWAY_ONLY = {
    CDP_API_KEY_ID: "key-id",
    CDP_API_KEY_SECRET: "key-secret",
  };
  const A_WALLET = "0x0123456789abcdef0123456789abcdef01234567";

  /** About the merchant, for a card with nothing wrong with it. */
  const theDoorSays = async (gateway: Served, key: string): Promise<readonly string[]> => {
    const answered = await gateway.call("POST", "/v0/catalog/publish", {
      body: roomCard,
      headers: { authorization: `Bearer ${key}` },
    });
    if (answered.status === 200) {
      return [];
    }
    const { problems } = (answered.body as { error: { problems: { code: string }[] } }).error;
    const aboutTheMerchant: ReadonlySet<string> = new Set(Object.values(MERCHANT_FINDINGS));
    return problems.map((finding) => finding.code).filter((code) => aboutTheMerchant.has(code));
  };

  /** In the gateway's words for the same things. */
  const named = (control: string): readonly string[] => [
    ...(/\bname\b/i.test(control) ? [MERCHANT_FINDINGS.NO_SELLER_NAME] : []),
    ...(/wallet/i.test(control) ? [MERCHANT_FINDINGS.NO_PAYOUT_WALLET] : []),
  ];

  for (const channel of Object.keys(CHANNELS) as Channel[]) {
    for (const [hasName, hasWallet] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      const who = `${hasName ? "a" : "no"} seller name and ${hasWallet ? "a" : "no"} wallet`;
      it(`on ${channel}, for a merchant with ${who}`, async () => {
        const running = await started({
          gateway: {
            ...CHANNELS[channel],
            ...(channel === "live" ? LIVE_GATEWAY_ONLY : {}),
          },
          dashboard: CHANNELS[channel],
        });
        await running.browser.signIn(FRESH.email);
        expect((await running.browser.makeMerchant()).status).toBe(200);
        const merchant = (await running.identity.byEmail(FRESH.email))?.merchant;
        if (merchant == null) throw new Error("the press made no merchant");
        // For the calls the merchant's code makes.
        const key = await running.harnessed.addKey(merchant.id);
        const asTheMerchant = { authorization: `Bearer ${key}` };
        if (hasName) {
          const listed = await running.gateway.call("POST", "/v0/seller-name", {
            body: { seller_name: "Their own shop" },
            headers: asTheMerchant,
          });
          expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        }
        if (hasWallet) {
          // Set in Settings by the signed-in person, since no key of the
          // merchant's code may set one.
          const saved = await running.browser.post("/settings/payout-wallet", {
            payout_wallet: A_WALLET,
          });
          expect(saved.status, saved.html).toBe(303);
        }
        const door = await theDoorSays(running.gateway, key);
        if (hasWallet) {
          // The fixture took: a wallet saved is a wallet the gateway has.
          expect(door).not.toContain(MERCHANT_FINDINGS.NO_PAYOUT_WALLET);
        }
        await running.harnessed.store.publishCard(merchant.id, roomCard, running.harnessed.now());

        const screen = await running.browser.get("/cards");
        const cell = /<td class="control"[^>]*>([\s\S]*?)<\/td>/.exec(screen.html)?.[1] ?? "";
        const control = readable(cell);

        expect(screen.status).toBe(200);
        if (door.length === 0) {
          // Nothing stands in the way, so the control is the merchant's own
          // switch.
          expect(control).toBe("Pause");
          return;
        }
        expect(control).not.toMatch(/all selling is stopped/i);
        const settable = door.filter((code) => code !== MERCHANT_FINDINGS.NO_OPERATOR_APPROVAL);
        expect(named(control), control).toStrictEqual(settable);
        expect(cell.includes('href="/settings"'), cell).toBe(settable.length > 0);
        const approvalAsked = door.includes(MERCHANT_FINDINGS.NO_OPERATOR_APPROVAL);
        expect(/approv/i.test(control), control).toBe(approvalAsked);
        if (approvalAsked) {
          expect(control).toMatch(/not approved your merchant/i);
        }
      });
    }
  }

  it("on the test channel, says nothing on Settings about an approval nobody needs there", async () => {
    // Off live the gateway's approval answer is false for everybody, since
    // nobody is approved there; shown, it would tell every test merchant to
    // wait for something that never comes.
    const running = await started({ gateway: CHANNELS.test, dashboard: CHANNELS.test });
    await running.browser.signIn(FRESH.email);
    expect((await running.browser.makeMerchant()).status).toBe(200);

    const settings = readable((await running.browser.get("/settings")).html);

    expect(settings).not.toMatch(/approv/i);
  });

  it("on live, for a merchant Agentify has approved, says so and sells the card", async () => {
    const running = await started({
      gateway: { ...CHANNELS.live, ...LIVE_GATEWAY_ONLY },
      dashboard: CHANNELS.live,
    });
    await running.browser.signIn(FRESH.email);
    expect((await running.browser.makeMerchant()).status).toBe(200);
    const merchant = (await running.identity.byEmail(FRESH.email))?.merchant;
    if (merchant == null) throw new Error("the press made no merchant");
    const key = await running.harnessed.addKey(merchant.id);
    const listed = await running.gateway.call("POST", "/v0/seller-name", {
      body: { seller_name: "Their own shop" },
      headers: { authorization: `Bearer ${key}` },
    });
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const saved = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: A_WALLET,
    });
    expect(saved.status, saved.html).toBe(303);
    await running.harnessed.store.grantLiveApproval(merchant.id, running.harnessed.now());
    expect(await theDoorSays(running.gateway, key)).toStrictEqual([]);

    const settings = readable((await running.browser.get("/settings")).html);
    const screen = await running.browser.get("/cards");
    const cell = /<td class="control"[^>]*>([\s\S]*?)<\/td>/.exec(screen.html)?.[1] ?? "";

    expect(settings).toMatch(/approved your merchant/);
    expect(settings).not.toMatch(/not approved your merchant/);
    expect(readable(cell)).toBe("Pause");
  });
});

describe("a merchant who has left", () => {
  // Nothing sets this state through a route, so it is reached through the
  // store, and the page is what is asserted.
  it("is not offered a button that puts them back on sale", async () => {
    const { browser, gateway, harnessed } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    await harnessed.store.setSelling(harnessed.merchant.id, "departed");

    const page = (await browser.get("/cards")).html;
    const text = readable(page);

    expect(text).toContain("left");
    // No selling control at all: "stop all selling" for a merchant who has left
    // is the same confusion under the other label.
    expect(page).not.toContain("/selling/resume");
    expect(page).not.toContain("/selling/pause");
    expect(text).not.toContain("Resume all sales");
    expect(text).not.toContain("Pause all sales");
    // A departure does not let accepted orders play out; a pause does.
    expect(text).not.toContain("play out as usual");
    expect(text).toContain("closed with you");
  });

  it("is told what the gateway said, not that the gateway is down", async () => {
    // The gateway answers 409 with a reason; shown as "did not answer", it
    // would send a merchant to check a service that is running.
    const { browser, gateway, harnessed } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    await harnessed.store.setSelling(harnessed.merchant.id, "departed");

    const refused = await browser.post("/selling/resume");

    expect(refused.status).toBe(409);
    const text = readable(refused.html);
    expect(text).toMatch(/this merchant has left/i);
    expect(text).not.toContain("did not answer");
  });
});

describe("the orders screen", () => {
  it("shows a finished order with its state in the merchant's words", async () => {
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, roomCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await browser.signIn();

    const text = readable((await browser.get("/orders")).html);

    expect(text).toContain("delivered");
    expect(text).toContain("A room for the night");
    expect(text).toContain("80.00 USD");
    // The wire's own words must not reach a person.
    expect(text).not.toContain("in_progress");
    expect(text).not.toContain("merchant_item_id");
  });

  it("tells the open orders from all of them", async () => {
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, roomCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await browser.signIn();

    const all = readable((await browser.get("/orders")).html);
    const openOnly = readable((await browser.get("/orders?open=true")).html);

    expect(all).toContain("A room for the night");
    // The sale is over, so it is not in the open list, and the empty list says
    // so rather than looking like a failed load.
    expect(openOnly).toContain("Nothing is open");
  });

  it("does not call every order finished while a buyer's price is still unpaid", async () => {
    // A price a buyer asked for and has not paid is an order under way, and it
    // is left off the open list on purpose; the empty list must not then say
    // that everything is finished, while All shows that order in progress.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, roomCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await browser.signIn();

    const all = readable((await browser.get("/orders")).html);
    const openOnly = readable((await browser.get("/orders?open=true")).html);

    expect(all).toContain("in progress");
    expect(openOnly).toContain("Nothing is open");
    expect(openOnly).not.toMatch(/finished/i);
  });

  it("does not tell a merchant nothing is owed while an order is still running", async () => {
    // An order under way may already have taken the buyer's money against goods
    // not yet sent, so the sentence is scoped to the two endings it counts.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, esimCard);
    await buyOverHttp(harnessed, gateway, itemId, { onOrder: () => ({ accepted: {} }) });
    await browser.signIn();

    const text = readable((await browser.get("/orders?open=true")).html);

    expect(text).toContain("in progress");
    expect(text).not.toContain("owed money or goods");
    expect(text).toContain("No refunds are due");
  });

  it("says which orders it cannot show at all", async () => {
    // A purchase that closed before any price was named cannot be on this list,
    // and an absence never mentioned is a truncation, so the page says it.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    const text = readable((await browser.get("/orders")).html);

    expect(text).toContain("closed before they had a price");
    expect(text).toContain("No money was charged for them");
  });

  it("says there are no orders rather than showing an empty table", async () => {
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    expect(readable((await browser.get("/orders")).html)).toContain("No orders yet");
  });

  it("calls out an order that owes a refund, and says what the merchant does about it", async () => {
    // The one open state that costs the merchant money must be shown, not left
    // to be noticed.
    const { browser, gateway, harnessed } = await started({
      gateway: { DEFAULT_ASYNC_FULFILLMENT_MS: "40" },
    });
    const itemId = await publish(gateway, {
      ...esimCard,
      fulfill_deadline_seconds: undefined,
    });
    // The money moves at purchase here; the merchant takes the order and lets
    // the delivery window run out.
    await buyOverHttp(harnessed, gateway, itemId, { onOrder: () => ({ accepted: {} }) });
    await vi.waitFor(
      async () => {
        const listed = (
          await gateway.call("GET", "/v0/orders?open=true", {
            headers: { authorization: `Bearer ${KEY}` },
          })
        ).body as { orders: { status: string }[] };
        expect(listed.orders.map((order) => order.status)).toContain("refund_due");
      },
      { timeout: 2_000, interval: 5 },
    );

    await browser.signIn();
    const text = readable((await browser.get("/orders?open=true")).html);

    expect(text).toContain("refund due");
    expect(text).toContain("1 order needs you");
    expect(text).toContain("You return it from your own wallet");
    // `refund_due` is what a program branches on; a merchant reads a sentence.
    expect(text).not.toContain("refund_due");
  });

  it("says why a refund is owed as it happened, and not always that a window ran out", async () => {
    // A refund falls due when the merchant refuses an order already paid for,
    // and the callout used to say the delivery window had run out whatever the
    // cause: a merchant reconciling it looked
    // for a deadline that never passed.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, esimCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ refused: { code: "out_of_stock", message: "no eSIMs left" } }),
    });

    await browser.signIn();
    const text = readable((await browser.get("/orders?open=true")).html);

    expect(text).toContain("1 order needs you");
    expect(text).toMatch(/your integration refused/i);
    expect(text).not.toMatch(/window ran out/i);
  });

  it("says held goods need a fresh payment on the same purchase", async () => {
    const { browser, gateway, harnessed } = await started();
    harnessed.facilitator.willSettle({ settled: false, reason: "the transfer reverted" });
    const itemId = await publish(gateway, roomCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await browser.signIn();

    const text = readable((await browser.get("/orders?open=true")).html);

    expect(text).toContain("product was not released to the buyer");
    // Still open, with nothing owed and nothing for the merchant to do. What
    // can still happen is the portal's to explain, and the page links there. It
    // must never suggest the buyer start again, which would deliver twice.
    expect(text).toContain("The order stays open");
    expect(text).not.toContain("repeat purchase");
  });
});

describe("the receipts screen", () => {
  it("shows a receipt with its amount, its outcome and both moments", async () => {
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, roomCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await browser.signIn();

    const text = readable((await browser.get("/receipts")).html);

    expect(text).toContain("A room for the night");
    expect(text).toContain("80.00 USD");
    expect(text).toContain("delivered");
    // "Price set", not "Bought": it is when the price was fixed, and where the
    // price is checked at purchase the buyer pays later.
    expect(text).toContain("Price set");
    expect(text).toContain("Price as of");
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    // When the money moved, the column a merchant matches wallet transfers
    // against. Counted rather than named, because a header with no cell under
    // it would satisfy a check for the word.
    expect(text).toContain("Paid");
    const row = text.slice(text.indexOf("rcp_"));
    expect(row.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/g)).toHaveLength(3);
    // The summary counts what it can stand behind.
    expect(text).toContain("Delivered or shipped 1 of 1 receipt");
  });

  it("links each receipt to its transfer on the chain the money moved on", async () => {
    // A merchant matching a receipt to their wallet had only its time to go
    // by.
    const transfer = `0x${"5e".repeat(32)}`;
    const { browser, gateway, harnessed } = await started({
      dashboard: { FACILITATOR_URL: "https://x402.org/facilitator" },
    });
    harnessed.facilitator.willSettle({ settled: true, transaction: transfer });
    const itemId = await publish(gateway, roomCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await browser.signIn();

    const html = (await browser.get("/receipts")).html;

    expect(html).toContain(`href="https://sepolia.basescan.org/tx/${transfer}"`);
  });

  it("marks money that was never real as what it is", async () => {
    // While every order is a test, this is every row; a ledger of payments that
    // never happened, laid out as one, is the worst thing this page could be.
    const { browser, gateway, harnessed } = await started({
      dashboard: { FACILITATOR_URL: "https://x402.org/facilitator" },
    });
    const itemId = await publish(gateway, roomCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await browser.signIn();

    const receipts = readable((await browser.get("/receipts")).html);
    const orders = readable((await browser.get("/orders")).html);

    expect(receipts).toContain("Every receipt here is a test purchase");
    expect(receipts).toContain("test funds settled on Base Sepolia");
    expect(receipts).toContain("no real money moved");
    expect(orders).toContain("Every order here is a test purchase");
    // The mark is on each sum as well: the sentence above stops applying the
    // moment one real payment lands beside the tests.
    expect(receipts).toContain("80.00 USD test");
    expect(orders).toContain("80.00 USD test");
    // Never calls the summary a record of takings.
    expect(receipts).not.toContain("paid in USD");
  });

  it("counts nothing it cannot count, and says what is missing instead", async () => {
    // A receipt is written only when goods are released, so a paid, undelivered
    // purchase has none, and a tile counting those would read zero forever: a
    // positive claim of none on the screen a merchant reads for money owed. The
    // page says so and names where those orders are.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    const text = readable((await browser.get("/receipts")).html);

    expect(text).not.toContain("Refund due");
    expect(text).not.toContain("In progress");
    expect(text).not.toContain("nothing outstanding");
    // The sentence itself, not only the explanation: the line a merchant
    // actually reads must not say this is all the money.
    expect(text).toContain("This page does not show all of your money");
    expect(text).toContain("Payments for products not yet delivered");
    expect(text).toContain("refunds you owe are on Orders");
  });

  it("does not claim a receipt appears when the money moves", async () => {
    // In the asynchronous mode the payment executes at purchase and the receipt
    // is written only when the goods go out.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, esimCard);
    await buyOverHttp(harnessed, gateway, itemId, { onOrder: () => ({ accepted: {} }) });
    await browser.signIn();

    const text = readable((await browser.get("/receipts")).html);

    // The money moved at purchase and there is no receipt for it.
    expect((await gateway.call("GET", "/v0/receipts", { headers: asMerchant })).body).toStrictEqual(
      {
        receipts: [],
      },
    );
    expect(text).not.toContain("the moment a payment goes through");
    expect(text).toContain("released");
    // The orders screen shows it, where the receipts page says to look.
    expect(readable((await browser.get("/orders?open=true")).html)).toContain("8.00 USD");
  });

  it("says nothing has been sold rather than showing a summary of nothing", async () => {
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    const text = readable((await browser.get("/receipts")).html);

    expect(text).toContain("No receipts yet");
    expect(text).toContain("nothing sold yet");
  });

  it("does not add money up", async () => {
    // Amounts are exact decimal strings so nothing turns them into a float; a
    // total computed here would be the one number that had.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, roomCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await browser.signIn();

    const text = readable((await browser.get("/receipts")).html);

    expect(text).not.toMatch(/total/i);
    // The currencies present are a fact. "Priced" rather than "paid", because
    // none of it was real money.
    expect(text).toContain("priced in USD");
  });
});

describe("the keys screen", () => {
  /** A key something is calling with: the ordinary row. */
  const NIGHTLY: MerchantKey = {
    id: "key_the_nightly_job",
    label: "the nightly job",
    created_at: "2026-08-20T09:00:00.000Z",
    last_used_at: "2026-08-27T02:15:00.000Z",
    disabled_at: null,
  };
  /** No call recorded, which is two situations at once. */
  const ANOTHER: MerchantKey = {
    id: "key_the_workers_use",
    label: "the worker on the small box",
    created_at: "2026-08-24T11:30:00.000Z",
    last_used_at: null,
    disabled_at: null,
  };
  const REVOKED: MerchantKey = {
    id: "key_the_laptop_had",
    label: "the laptop that went missing",
    created_at: "2026-07-01T08:00:00.000Z",
    last_used_at: null,
    disabled_at: "2026-08-26T17:45:00.000Z",
  };
  const SECRET = "the-secret-shown-once-and-never-again";

  /**
   * The three key routes answered by the test, the rest by the real gateway.
   */
  const withKeys = (
    listed: readonly MerchantKey[] = [NIGHTLY, ANOTHER, REVOKED],
  ): {
    readonly disabled: string[];
    readonly issued: string[];
    readonly client: (real: GatewayClient) => GatewayClient;
  } => {
    const disabled: string[] = [];
    const issued: string[] = [];
    const keys: readonly MerchantKey[] = [...listed];
    return {
      disabled,
      issued,
      client: (real) => ({
        ...real,
        keys: async () => ({ ok: true, document: keys }),
        issueKey: async (label) => {
          issued.push(label);
          return {
            ok: true,
            document: {
              key: {
                id: "key_the_new_one",
                label,
                created_at: NOW,
                last_used_at: null,
                disabled_at: null,
              },
              secret: SECRET,
            },
          };
        },
        disableKey: async (keyId) => {
          disabled.push(keyId);
          return { ok: true, document: { ...ANOTHER, disabled_at: NOW } };
        },
      }),
    };
  };
  const NOW = "2026-08-28T12:00:00.000Z";

  it("lists the keys this merchant has, the working ones and the revoked ones", async () => {
    // A key is revocable on its own; a list that dropped revoked keys would
    // answer "which key did I turn off last week" with silence.
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const text = readable((await browser.get("/keys")).html);

    expect(text).toContain("the nightly job");
    expect(text).toContain("the worker on the small box");
    expect(text).toContain("the laptop that went missing");
    expect(text).toMatch(/revoked/i);
    expect(text).toContain("2026-08-26");
  });

  it("offers the control against every key on the list that still works", async () => {
    // The dashboard calls with none of these keys, so every row is the
    // merchant's own and must be revocable here, the only page that revokes
    // keys.
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const page = (await browser.get("/keys")).html;

    expect(page).toContain(`/keys/${NIGHTLY.id}/disable`);
    expect(page).toContain(`/keys/${ANOTHER.id}/disable`);
  });

  it("revokes the key the merchant's own code is calling with, and the dashboard goes on working", async () => {
    // The key a merchant's code is using is the one they most need to revoke
    // when it leaks, and nothing the dashboard does rests on it.
    const running = await started();
    await running.browser.signIn();
    await running.browser.get("/keys");

    const revoked = await running.browser.post(`/keys/${running.harnessed.merchant.keyId}/disable`);

    expect(revoked.status).toBe(303);
    expect((await running.gateway.call("GET", "/v0/cards", { headers: asMerchant })).status).toBe(
      401,
    );
    expect((await running.browser.get("/keys")).status).toBe(200);
  });

  it("offers no control at all against a key that is already revoked", async () => {
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const page = (await browser.get("/keys")).html;

    expect(page).not.toContain(`/keys/${REVOKED.id}/disable`);
  });

  /**
   * Read through the header rather than by counting cells, so an added column
   * does not move what is read.
   */
  const inColumn = (html: string, keyId: string, header: RegExp): string => {
    const heading = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
    const headers = [...heading.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((cell) =>
      readable(cell[1] ?? ""),
    );
    const at = headers.findIndex((word) => header.test(word));
    if (at < 0) {
      throw new Error(`no column of this table is headed ${header}: ${headers.join(", ")}`);
    }
    const row = (html.match(/<tr[\s\S]*?<\/tr>/g) ?? []).find((one) => one.includes(keyId));
    if (row === undefined) {
      throw new Error(`no row of this table is the key ${keyId}`);
    }
    return readable([...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)][at]?.[1] ?? "");
  };

  it("says when each key was last called, and stops there when it cannot", async () => {
    // The column a merchant opens the screen for: which key is safe to revoke.
    // A blank covers both a key never used and one older than the recording,
    // and the wire does not tell them apart, so the words claim only a missing
    // record, never "never".
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const page = (await browser.get("/keys")).html;
    const called = inColumn(page, NIGHTLY.id, /last/i);
    const quiet = inColumn(page, ANOTHER.id, /last/i);

    expect(called).toBe("2026-08-27 02:15:00 UTC");
    expect(quiet).not.toBe("");
    expect(quiet).toMatch(/record/i);
    expect(quiet).not.toMatch(/never/i);
    // Not the creation date in this column's place: a merchant would read it as
    // a call.
    expect(quiet).not.toBe(inColumn(page, ANOTHER.id, /created/i));
  });

  it("says under the table that an empty last call is two situations", async () => {
    // A merchant reading "No calls recorded" beside an old key must be able to
    // learn that recording began recently and that old keys show the same
    // either way, or the honest phrase reads as the confident one.
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const text = readable((await browser.get("/keys")).html);

    expect(text).toMatch(/began recording|started recording/i);
    expect(text).toMatch(/cannot tell you which|which it is/i);
  });

  it("issues a key, shows its secret once, and says that is the only time", async () => {
    // Nothing keeps a readable copy, so a merchant who does not copy it must
    // issue another; saying so makes that a nuisance rather than a surprise.
    const keys = withKeys();
    const { browser } = await started({ client: keys.client });
    await browser.signIn();

    const issued = await browser.post("/keys", { label: "the second worker" });

    expect(keys.issued).toStrictEqual(["the second worker"]);
    expect(issued.status).toBe(200);
    expect(issued.html).toContain(SECRET);
    expect(readable(issued.html)).toMatch(/only time|once/i);
    expect(readable(issued.html)).toContain("Copy key");

    const reloaded = await browser.get("/keys/new");
    expect(reloaded.status).toBe(303);
    expect(reloaded.to).toBe("/keys");
    expect(keys.issued).toStrictEqual(["the second worker"]);
    // Gone from every later page: the list is drawn from documents that carry
    // no secret.
    expect((await browser.get("/keys")).html).not.toContain(SECRET);
  });

  it("revokes a key only on a second, deliberate press", async () => {
    // A revoked key does not come back, so a stray tap must not end one. The
    // first press opens the question, and only its answer posts.
    const keys = withKeys();
    const { browser } = await started({ client: keys.client });
    await browser.signIn();

    const page = (await browser.get("/keys")).html;
    const action = `action="/keys/${NIGHTLY.id}/disable"`;
    const question =
      /<details class="confirm-revoke">[\s\S]*?<\/details>/g.exec(
        page.slice(page.indexOf(NIGHTLY.label)),
      )?.[0] ?? "";
    expect(question).toMatch(/<summary[^>]*>Revoke<\/summary>/);
    expect(question).toContain(action);
    expect(question).toContain("Yes, revoke");
    expect(page.split(action)).toHaveLength(2);

    await browser.post(`/keys/${NIGHTLY.id}/disable`);
    expect(keys.disabled).toStrictEqual([NIGHTLY.id]);
  });

  it("refuses to issue a key with no name, without asking the gateway", async () => {
    // A key with no name cannot be told apart from another on the screen meant
    // for that.
    const keys = withKeys();
    const { browser } = await started({ client: keys.client });
    await browser.signIn();

    const refused = await browser.post("/keys", { label: "   " });

    expect(refused.status).toBe(400);
    expect(readable(refused.html)).toMatch(/name/i);
    expect(keys.issued).toStrictEqual([]);
  });

  it("disables one key and comes back to the list", async () => {
    // A redirect, so a reload does not press it again.
    const keys = withKeys();
    const { browser } = await started({ client: keys.client });
    await browser.signIn();

    const off = await browser.post(`/keys/${ANOTHER.id}/disable`);

    expect(keys.disabled).toStrictEqual([ANOTHER.id]);
    expect(off.status).toBe(303);
    expect(off.to).toBe("/keys");
  });

  it("writes down who issued a key and who revoked one, and neither secret", async () => {
    // Every change names the person who made it; the secret never travels with
    // the sentence.
    const said: string[] = [];
    const collect = (...parts: unknown[]) => said.push(parts.map(String).join(" "));
    const log = vi.spyOn(console, "log").mockImplementation(collect);
    try {
      const { browser } = await started({ client: withKeys().client });
      await browser.signIn();

      await browser.post("/keys", { label: "the second worker" });
      await browser.post(`/keys/${ANOTHER.id}/disable`);

      const written = said.join("\n");
      expect(written).toMatch(/issued a key/i);
      expect(written).toMatch(/revoked the key|disabled the key/i);
      for (const line of written.split("\n").filter((one) => /key/.test(one))) {
        expect(line, line).toContain(PERSON);
      }
      expect(written).not.toContain(SECRET);
      expect(written).not.toContain(KEY);
    } finally {
      log.mockRestore();
    }
  });

  it("does not let the name of a key write a line of its own in the log", async () => {
    // A key's name is one line (the contract refuses a line break, and the
    // dashboard checks before logging or sending), so a name with a newline and
    // a forged sentence is refused. A character that changes how the line is
    // drawn, such as a right-to-left override, is shown rather than obeyed.
    const said: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...parts) => said.push(parts.map(String).join(" ")));
    try {
      const keys = withKeys();
      const { browser } = await started({ client: keys.client });
      await browser.signIn();

      const refused = await browser.post("/keys", {
        label: "a worker\n[dashboard] someone.else@example.com stopped all selling",
      });
      expect(refused.status).toBe(400);
      expect(said.join("\n")).not.toContain("issued a key");

      await browser.post("/keys", { label: "a worker\u202E gnilles lla deppots" });

      const written = said.join("\n");
      expect(written).toContain("issued a key");
      for (const line of written.split("\n")) {
        expect(line, line).toContain(PERSON);
      }
      expect(written).toContain("\\u{202e}");
      expect(written).not.toContain("\u202E");
    } finally {
      log.mockRestore();
    }
  });

  it("says what the gateway said when it refuses to disable a key", async () => {
    // The rules live in the route; the screen's control is a courtesy, not the
    // guard. A merchant reaching the address by hand is told what the gateway
    // answered, against the real gateway, so the sentence is the gateway's own.
    const { browser } = await started();
    await browser.signIn();

    const refused = await browser.post("/keys/key_nobody_has/disable");

    expect(refused.status).toBe(404);
    expect(readable(refused.html)).toMatch(/there is no such key/i);
  });

  it("shows the gateway's refusal as a sentence, beginning with a capital", async () => {
    // The gateway writes refusals in lower case for a program's log; a person
    // reads a sentence.
    const { browser } = await started();
    await browser.signIn();

    const refused = await browser.post("/keys/key_nobody_has/disable");
    const said = /<h1>Something went wrong<\/h1>\s*<p>([^<]*)<\/p>/.exec(refused.html)?.[1] ?? "";

    expect(said).toMatch(/^[A-Z]/);
    expect(said.toLowerCase()).toContain("there is no such key");
  });

  it("draws a working screen for a merchant who has issued no keys of their own", async () => {
    // The first screen of every new merchant: the dashboard holds no key, so an
    // empty list is ordinary, and a page calling it impossible would lie to
    // every new merchant. Against the real gateway, whose answer it is.
    const { browser } = await started();
    await browser.signIn(FRESH.email);
    await browser.makeMerchant();

    const seen = await browser.get("/keys");
    const text = readable(seen.html);

    expect(seen.status).toBe(200);
    expect(text).not.toMatch(/cannot happen/i);
    // The one control that gets a merchant out of this state is on it.
    expect(seen.html).toContain('action="/keys"');
    // It does not count absent rows as though some worked.
    expect(text).not.toMatch(/\b0 of the 0\b/);
  });
});

describe("what every screen says about the address", () => {
  it("carries the signed-in address and a sign-out in the header bar of every working screen", async () => {
    // The header carries the signed-in address and a sign-out, as the scanner's
    // does, so the site reads as one product with one session.
    const { browser } = await started();
    await browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts", "/keys", "/settings"]) {
      const answered = await browser.get(path);
      // A page showing a person's address is never stored by a shared cache.
      expect(answered.headers.get("cache-control"), path).toBe("private, no-store");
      const bar = /<header class="top">([\s\S]*?)<\/header>/.exec(answered.html)?.[1] ?? "";
      expect(readable(bar), path).toContain(PERSON);
      expect(bar, path).toContain('method="post" action="/sign-out"');
    }
  });

  it("links the signed-in address to settings without a confirmation control", async () => {
    const { browser } = await started();
    await browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts", "/keys", "/settings"]) {
      const answered = await browser.get(path);
      const link = /<a class="who" href="\/settings"[^>]*>([^<]*)<\/a>/.exec(answered.html);
      expect(link?.[1], path).toBe(PERSON);
      expect(answered.html, path).not.toContain('action="/confirm"');
    }
  });
});

describe("when something goes wrong that the merchant has to get out of", () => {
  /**
   * The real gateway cannot be made to refuse every call or answer in a shape
   * its own contract refuses. The page the merchant lands on is the subject;
   * the seam is scaffolding.
   */
  const dashboardAnswering = async (
    reply: () => Promise<Answer<never>>,
  ): Promise<{ browser: Browser; close: () => Promise<void> }> => {
    const answer = async () => await reply();
    const { browser } = await started({
      client: () =>
        ({
          cards: answer,
          pauseCard: answer,
          setSelling: answer,
          orders: answer,
          receipts: answer,
          sellerName: answer,
          setSellerName: answer,
          seller: answer,
          setSellerSite: answer,
          payoutWallet: answer,
          integration: answer,
          refundsOwed: answer,
        }) as never,
    });
    return { browser, close: async () => undefined };
  };

  it("opens Integrations while the gateway refuses everything, since nothing on it comes from there", async () => {
    // The page is the way to connect a catalogue, and its guide and key are
    // what a merchant reaches for when an integration fails.
    const { browser, close } = await dashboardAnswering(async () => ({
      ok: false,
      status: 503,
      why: "the gateway is refusing every call",
    }));
    try {
      await browser.signIn();

      const answered = await browser.get("/integrations");

      expect(answered.status).toBe(200);
      expect(answered.html).toContain('href="/docs/quickstart"');
    } finally {
      await close();
    }
  });

  it("does not tell a merchant nothing was changed when it cannot know that", async () => {
    // A call that did its work and answered in a shape the contract does not
    // recognise lands on the error page; the pause has happened, and a page
    // saying otherwise would send the merchant to press it again.
    const { browser, close } = await dashboardAnswering(async () => {
      throw new Error("the answer was not a document this contract knows");
    });
    try {
      await browser.signIn();

      // Pressed on a page drawn before the gateway went wrong; every page drawn
      // now is the error page, with nothing to press.
      const answered = await browser.post("/selling/pause", { [DRAWN_FOR]: PERSON });

      expect(answered.status).toBe(500);
      const text = readable(answered.html);
      expect(text).toContain("Something in the dashboard is broken");
      expect(text).not.toContain("Nothing was changed");
    } finally {
      await close();
    }
  });

  it("says there is no such page inside the dashboard, with its menu and a way back", async () => {
    // Only to somebody signed in; a stranger is sent to the sign-in from every
    // address, one that does not exist included, and learns nothing about which
    // exist (held under "the gate").
    const { browser } = await started();
    await browser.signIn();

    const answered = await browser.get("/nowhere");

    expect(answered.status).toBe(404);
    expect(readable(answered.html)).toContain("There is no such page");
    expect(answered.html).toMatch(/<a [^>]*href="\/cards"[^>]*>Back to the dashboard<\/a>/);
    const bar = /<header class="top">([\s\S]*?)<\/header>/.exec(answered.html)?.[1] ?? "";
    expect(readable(bar)).toContain(PERSON);
    expect(bar).toContain('method="post" action="/sign-out"');
  });

  it("treats a cookie it cannot read as nobody being signed in", async () => {
    // An invalid percent-encoded cookie value must not throw onto the error
    // page, whose only control leads to a page that throws again, with an
    // HttpOnly cookie nothing there can clear.
    const { browser } = await started();

    for (const raw of [
      `${COOKIE}=%zz`,
      `${COOKIE}=`,
      "=nonsense",
      `${COOKIE}=made-up-identifier`,
    ]) {
      const answered = await browser.withRawCookie(raw).get("/cards");
      expect(answered.status, raw).toBe(303);
      expect(answered.to, raw).toBe(raw.startsWith(`${COOKIE}=`) ? SESSION_ENDED : "/sign-in");
    }
  });

  it("cannot be signed out by a second cookie somebody planted", async () => {
    // A sibling subdomain can set a cookie of this name on a broader path, so
    // the browser sends two, and the dashboard can clear only its own. Refusing
    // on the mere presence of a second would lock the merchant out for good:
    // anybody able to set a cookie could take away the control that stops their
    // selling.
    const { browser } = await started();
    await browser.signIn();
    const mine = browser.sessionToken() ?? "";
    expect(mine).not.toBe("");

    for (const raw of [
      `${COOKIE}=${mine}; ${COOKIE}=somebody-elses`,
      `${COOKIE}=somebody-elses; ${COOKIE}=${mine}`,
      `${COOKIE}=a; ${COOKIE}=b; ${COOKIE}=${mine}`,
    ]) {
      const answered = await browser.withRawCookie(raw).get("/cards");
      expect(answered.status, raw).toBe(200);
      expect(readable(answered.html), raw).toContain(PERSON);
    }
  });

  it("still signs its merchant in under every cookie of this name a request can carry", async () => {
    // There must be no cap on how many values under this name are considered:
    // cookies of one name arrive longest-path then oldest first, so planted
    // ones could push the merchant's own past a cap. A cap below what a request
    // can carry would pass a smaller test, so this one is built to the
    // runtime's ceiling: Node reads 16 KB of headers, one cookie here is 99
    // bytes plus a two-byte separator, and a request with only a request line
    // and Host carries 161 of them. That is why it goes over a raw socket
    // rather than `fetch`, whose own headers would buy fewer.
    //
    // Each value is looked up one at a time, but a value not signed with this
    // dashboard's secret is refused before the store is read, so planted junk
    // costs comparisons, not queries; `identity.db-test.ts` measures that on a
    // real database.
    const { browser, url } = await started();
    await browser.signIn();
    const mine = browser.sessionToken() ?? "";
    const carrying = (count: number): string =>
      [
        ...Array.from(
          { length: count - 1 },
          (_, at) => `${`${at}`.padStart(32, "a")}.${"b".repeat(43)}`,
        ),
        mine,
      ]
        .map((value) => `${COOKIE}=${value}`)
        .join("; ");
    const most = await overASocket(url, "/cards", carrying(161));

    // The merchant is still the person asking, with 160 planted cookies in
    // front.
    expect(most.status).toBe(200);
    expect(most.body).toContain(PERSON);

    // One more and the runtime refuses to read the headers at all.
    const tooMany = await overASocket(url, "/cards", carrying(162));

    expect(tooMany.status).toBe(431);
  });

  it("is one person's dashboard when both live cookies are that person's", async () => {
    // After a change of mount point a browser holds both cookies, both this
    // person's and both alive; refusing that would end a session the merchant
    // is in for a reason of ours.
    const { browser, another } = await started();
    await browser.signIn();
    const mine = browser.sessionToken() ?? "";
    const telephone = await another();
    await telephone.signIn();
    const also = telephone.sessionToken() ?? "";

    expect(mine).not.toBe(also);
    const answered = await browser
      .withRawCookie(`${COOKIE}=${mine}; ${COOKIE}=${also}`)
      .get("/cards");

    expect(answered.status).toBe(200);
    expect(readable(answered.html)).toContain(PERSON);
    // Neither session was ended: both still work on their own.
    expect((await browser.withRawCookie(`${COOKIE}=${mine}`).get("/cards")).status).toBe(200);
    expect((await browser.withRawCookie(`${COOKIE}=${also}`).get("/cards")).status).toBe(200);
  });

  it("ends both sessions rather than choosing when they belong to two people", async () => {
    // Working inside a session somebody else opened would put the wrong person
    // on the record of who stopped the selling, so nobody is signed in. The
    // sessions are also ended: the dashboard cannot remove a cookie set for a
    // broader domain or path, so a rule that only refused would meet the
    // planted session on every sign-in and lock the merchant out. Ended, the
    // planted value stops being a session.
    const { browser, another, identity, theMerchant: merchant } = await started();
    await identity.make(OTHER, merchant);
    await browser.signIn();
    const mine = browser.sessionToken() ?? "";
    const somebody = await another();
    await somebody.signIn(OTHER);
    const theirs = somebody.sessionToken() ?? "";

    expect(mine).not.toBe(theirs);
    const answered = await browser
      .withRawCookie(`${COOKIE}=${mine}; ${COOKIE}=${theirs}`)
      .get("/cards");

    expect(answered.status).toBe(303);
    expect(answered.to).toBe(SESSION_ENDED);
    // Neither is a session any more, so the plant is spent.
    expect((await browser.withRawCookie(`${COOKIE}=${mine}`).get("/cards")).to).toBe(SESSION_ENDED);
    expect((await browser.withRawCookie(`${COOKIE}=${theirs}`).get("/cards")).to).toBe(
      SESSION_ENDED,
    );
    // The dead cookie is still in the browser and no longer decides anything.
    const back = await browser.signIn();
    expect(back.status).toBe(200);
    const carrying = await browser
      .withRawCookie(`${COOKIE}=${theirs}; ${COOKIE}=${browser.sessionToken() ?? ""}`)
      .get("/cards");
    expect(carrying.status).toBe(200);
    expect(readable(carrying.html)).toContain(PERSON);
  });

  it("turns away a form post that came from another site", async () => {
    // This form's session can stop all selling. `SameSite=Lax` is the main
    // lock; this is the second, because SameSite is scoped to the registrable
    // domain and a sibling subdomain is "same site".
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();

    const forged = await browser.from("https://evil.example.com").post("/selling/pause");

    expect(forged.status).toBe(403);
    expect(await purchasable(gateway, itemId)).toBe(true);
  });

  it("lets a merchant in whatever the terminator in front of it says about the scheme", async () => {
    // Taking the expected scheme from `X-Forwarded-Proto` let whatever is in
    // front decide whether a merchant could sign in: when that header disagreed
    // with the browser, every form post, sign-in included, was refused. The
    // sign-in is driven here because it must work before any other post can;
    // each case is a shape the header can arrive in, and none may keep a
    // merchant out.
    const { browser, url } = await started();
    const asHttps = `https://${new URL(url).host}`;
    const credentials = { email: PERSON };

    const behindTls = await browser
      .sending({ origin: asHttps, "x-forwarded-proto": "https" })
      .post("/sign-in", credentials);
    expect(behindTls.status).toBe(202);

    // An https origin with nothing in the request saying so: a terminator that
    // sets no forwarded header.
    const nothingForwarded = await browser
      .sending({ origin: asHttps })
      .post("/sign-in", credentials);
    expect(nothingForwarded.status).toBe(202);

    // On its own with no terminator, as in development and in every test here.
    const onItsOwn = await browser
      .sending({ origin: `http://${new URL(url).host}` })
      .post("/sign-in", credentials);
    expect(onItsOwn.status).toBe(202);

    // A chain that terminates TLS early and disagrees with itself end to end.
    const throughAChain = await browser
      .sending({ origin: asHttps, "x-forwarded-proto": "https, http" })
      .post("/sign-in", credentials);
    expect(throughAChain.status).toBe(202);

    // The scheme disagreeing outright is let through: a page on the http origin
    // of the same host carries no session, because the cookie is Secure
    // wherever the dashboard is on https.
    const overHttp = await browser
      .sending({ origin: `http://${new URL(url).host}`, "x-forwarded-proto": "https" })
      .post("/sign-in", credentials);
    expect(overHttp.status).toBe(202);
  });

  it("still refuses a form from another host, whatever it claims about the scheme", async () => {
    // The negative control: comparing only the host must not admit everybody,
    // and a sibling subdomain is "same site" to SameSite.
    const { browser, url } = await started();
    const credentials = { email: PERSON };

    for (const origin of [
      "https://evil.example.com",
      // A sibling subdomain, which SameSite would let through.
      `https://elsewhere.${new URL(url).hostname}`,
      // The host as a prefix of a longer one, which a `startsWith` comparison
      // would wave through.
      `https://${new URL(url).hostname}.evil.example.com`,
      // An opaque origin, as a sandboxed document sends.
      "null",
    ]) {
      const forged = await browser.sending({ origin }).post("/sign-in", credentials);
      expect(forged.status, origin).toBe(403);
      expect(readable(forged.html), origin).toContain("did not come from the dashboard");
    }
  });

  it("writes down what it compared, because the other person it refuses is honest", async () => {
    // The page tells somebody guessing nothing; the log lets an honest merchant
    // who was refused be told apart from them.
    const said: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => said.push(parts.map(String).join(" ")));
    try {
      const { browser, url } = await started();

      await browser
        .sending({ origin: "https://evil.example.com" })
        .post("/sign-in", { email: PERSON });

      const line = said.find((one) => one.includes("form post was refused")) ?? "";
      // Both halves of the comparison; either alone leaves the reader guessing
      // which was wrong.
      expect(line).toContain("evil.example.com");
      expect(line).toContain(new URL(url).host);
    } finally {
      log.mockRestore();
    }
  });
});

describe("when the gateway will not answer", () => {
  it("says the gateway did not answer rather than showing an empty catalog", async () => {
    // "Nothing answered" and "you have no cards" are different news, and only
    // one means the merchant should act; and what was asked may still have been
    // done.
    const { browser, gateway, silenceGateway } = await started({ answerWithinMs: 100 });
    await publish(gateway, roomCard);
    await browser.signIn();
    silenceGateway();

    const answered = await browser.get("/cards");

    expect(answered.status).toBe(504);
    const text = readable(answered.html);
    expect(text).toContain("Agentify did not answer");
    expect(text).toMatch(/may or may not have been done/);
  });
});

describe("the page that says a call to the gateway failed", () => {
  it("tries the page the merchant was on again, not another one", async () => {
    // A merchant reading Receipts who presses "Try again" wants Receipts
    // again; sent to Cards, they lose their place and press their way back.
    const { browser, silenceGateway } = await started({ answerWithinMs: 100 });
    await browser.signIn();
    silenceGateway();

    const failed = await browser.get("/receipts");
    const again =
      /<(?:a|form)\b[^>]*\b(?:href|action)="([^"]*)"[^>]*>(?:(?!<\/(?:a|form)>)[\s\S])*?Try again/.exec(
        failed.html,
      )?.[1];

    expect(failed.status).toBe(504);
    expect(again).toMatch(/\/receipts$/);
  });
});

describe("a session that is ended while somebody is looking at a page", () => {
  it("stops the open tab from doing anything, and does not do what it asked", async () => {
    // A session is a row so one can be ended on its own, without rotating the
    // merchant's key and stopping their code with it.
    const { browser, gateway, identity } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();
    expect((await browser.get("/cards")).status).toBe(200);

    await identity.endEverySessionFor(PERSON);

    const refused = await browser.post("/selling/pause");
    expect(refused.status).toBe(303);
    expect(refused.to).toBe(SESSION_ENDED_UNSAVED);
    const recovery = await browser.get(refused.to ?? "");
    expect(readable(recovery.html)).toContain("not saved");
    // The negative control is the fact: the switch the tab pressed did not
    // move.
    expect(await purchasable(gateway, itemId)).toBe(true);
    expect((await browser.get("/cards")).to).toBe("/sign-in");
  });

  it("tells a tab whose person signed out in another one that what it pressed was not saved", async () => {
    // Signing out clears the cookie in every tab, so the gate sees no trace of
    // the session the open tab was drawn in; landed on a bare sign-in, a
    // merchant who pressed "Pause all sales" would think it done while agents
    // went on buying.
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();
    expect((await browser.get("/cards")).status).toBe(200);

    await browser.post("/sign-out");
    const refused = await browser.post("/selling/pause");

    expect(refused.status).toBe(303);
    expect(refused.to).toBe(UNSAVED);
    const recovery = (await browser.get(refused.to ?? "")).html;
    // Something the person did was not kept, so it is a refusal, in the line
    // the form keeps for one.
    const refusal = readable(/<p class="problem">[\s\S]*?<\/p>/.exec(recovery)?.[0] ?? "");
    expect(refusal).toContain("not saved");
    // The gate cannot tell a sign-out from an expired session, so it names
    // neither.
    expect(readable(recovery)).not.toContain("Your session ended");
    expect(await purchasable(gateway, itemId)).toBe(true);
  });

  it("leaves the person's other session alone", async () => {
    // One session at a time; ending all of them at once is what rotating the
    // key would do.
    const { browser, gateway, another, identity } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    const telephone = await another();
    await telephone.signIn();

    await identity.signOut(`${COOKIE}=${browser.sessionToken() ?? ""}`);

    expect((await browser.get("/cards")).to).toBe(SESSION_ENDED);
    expect((await telephone.get("/cards")).status).toBe(200);
  });

  it("refuses a session whose time is up, without anybody ending it", async () => {
    // The cookie still carries a good signature; the row has expired, and the
    // row decides.
    const { browser } = await started();
    await browser.signIn();
    expect((await browser.get("/cards")).status).toBe(200);

    for (const session of sessionRows()) {
      session.expiresAt = new Date(Date.now() - 60_000);
    }

    const answered = await browser.get("/cards");

    expect(answered.status).toBe(303);
    expect(answered.to).toBe(SESSION_ENDED);
    const recovery = await browser.get(answered.to ?? "");
    const message = readable(recovery.html);
    expect(message).toContain("Your session ended");
    expect(message).not.toContain("not saved");
    expect(message).not.toContain("submitted a change");
  });

  it("is a fresh session every time, so signing in twice does not reuse one identifier", async () => {
    const { browser, another } = await started();
    await browser.signIn();
    const first = browser.sessionToken();
    const telephone = await another();
    await telephone.signIn();

    expect(first).not.toBeNull();
    expect(telephone.sessionToken()).not.toBe(first);
  });
});

/**
 * Read the way a browser reads the page, whatever the tag's case or attribute
 * order.
 */
const postingFormsIn = (html: string): { action: string; fields: Record<string, string> }[] =>
  [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].flatMap(
    ([, attributes = "", inside = ""]) => {
      if (!/\bmethod\s*=\s*["']?post\b/i.test(attributes)) return [];
      const action = /\baction\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1] ?? "";
      const fields = Object.fromEntries(
        [...inside.matchAll(/<input\b[^>]*>/gi)].flatMap(([input]) => {
          if (!/\btype\s*=\s*["']?hidden\b/i.test(input)) return [];
          const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(input)?.[1];
          const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(input)?.[1] ?? "";
          return name === undefined ? [] : [[name, value]];
        }),
      );
      return [{ action, fields }];
    },
  );

/** What it sends besides what a person types. */
const hiddenIn = (html: string, action: string): Record<string, string> => {
  const form = postingFormsIn(html).find((drawn) => drawn.action === action);
  if (form === undefined) throw new Error(`the page draws no form sent to ${action}`);
  return form.fields;
};

describe("a page left open while another address signs in", () => {
  it("does nothing when pressed, and the same press from a page of the address now signed in does", async () => {
    // A tab drawn for one address can still be open when another signs in, and
    // the browser sends the new cookie with the old form.
    const running = await started();
    const itemId = await publish(running.gateway, roomCard);
    await running.identity.make(OTHER, running.theMerchant);
    await running.browser.signIn();
    const leftOpen = hiddenIn((await running.browser.get("/cards")).html, "/selling/pause");

    await running.browser.post("/sign-out");
    await running.browser.signIn(OTHER);
    const refused = await running.browser.post("/selling/pause", leftOpen);

    expect(refused.status).toBe(409);
    const said = readable(refused.html);
    expect(said).toContain("Nothing was changed");
    // It names who is signed in now, never what the form claimed, and leads to
    // where that person starts.
    expect(said).toContain(OTHER);
    expect(said).not.toContain(PERSON);
    expect(refused.html).toContain('href="/cards"');
    expect(await purchasable(running.gateway, itemId)).toBe(true);

    const drawnNow = hiddenIn((await running.browser.get("/cards")).html, "/selling/pause");
    expect((await running.browser.post("/selling/pause", drawnNow)).status).toBe(303);
    expect(await purchasable(running.gateway, itemId)).toBe(false);
  });

  it("is refused at every address behind the gate, read off the router, as is a form that says nothing", async () => {
    // Held in the gate, so a route added later is held too. A form with no mark
    // at all is refused as well, as a form the marking missed would be.
    const running = await started({ wooShops: memoryWooShops() });
    await publish(running.gateway, roomCard);
    await running.identity.make(OTHER, running.theMerchant);
    await running.browser.signIn();
    const leftOpen = hiddenIn((await running.browser.get("/cards")).html, "/selling/pause");
    await running.browser.post("/sign-out");
    await running.browser.signIn(OTHER);

    // These answer without a session, and the sign-out signs this browser out
    // whichever page it was pressed on.
    const above = new Set(["/sign-in", "/sign-in/open", "/sign-out", "/woocommerce/callback"]);
    const behind = routesOf(running).filter(
      ({ method, path }) => method === "post" && !above.has(path),
    );
    expect(behind.length).toBeGreaterThan(10);
    const silently = async (path: string): Promise<Visit> =>
      await running.browser.postRaw(path, "application/x-www-form-urlencoded", "");
    const refusal = await silently("/selling/pause");
    expect(refusal.status).toBe(409);
    for (const { path } of behind) {
      for (const answer of [await running.browser.post(path, leftOpen), await silently(path)]) {
        expect({ status: answer.status, html: answer.html }, path).toStrictEqual({
          status: 409,
          html: refusal.html,
        });
      }
    }
  });

  it("lets every form the working screens draw through for the address they were drawn for", async () => {
    // Each form is sent exactly as its page drew it, by the browser it was
    // drawn for, and must not be refused. The screens are those a merchant with
    // a card, an unset name and a shop to connect sees, plus the new-merchant
    // screen.
    const running = await started({ wooShops: memoryWooShops() });
    await publish(running.gateway, roomCard);
    await running.browser.signIn();
    const pages = ["/cards", "/keys", "/settings", "/integrations", "/woocommerce", "/nowhere"];
    const drawn = [];
    for (const path of pages) drawn.push(...postingFormsIn((await running.browser.get(path)).html));
    await unname(running);
    drawn.push(...postingFormsIn((await running.browser.get("/choose-name")).html));
    const fresh = await running.another();
    await fresh.signIn(FRESH.email);
    const offered = postingFormsIn((await fresh.get("/merchant")).html);

    const actions = new Set([...drawn, ...offered].map(({ action }) => action));
    for (const action of [
      "/selling/pause",
      "/keys",
      "/settings",
      "/settings/payout-wallet",
      "/settings/sign-out-others",
      "/woocommerce/connect",
      "/choose-name",
      "/merchant",
    ]) {
      expect(actions, action).toContain(action);
    }

    // Sent raw, so nothing the test's browser adds goes with it.
    const asDrawn = async (browser: Browser, action: string, fields: Record<string, string>) =>
      await browser.postRaw(
        action,
        "application/x-www-form-urlencoded",
        new URLSearchParams(fields).toString(),
      );
    const refusal = await asDrawn(running.browser, "/selling/pause", {});
    expect(refusal.status).toBe(409);
    for (const { action, fields } of drawn.filter(({ action }) => action !== "/sign-out")) {
      const answer = await asDrawn(running.browser, action, fields);
      expect(answer.status === 409 && answer.html === refusal.html, action).toBe(false);
    }
    // Still signed in: a form that ended the session would turn every later
    // answer into the sign-in.
    expect((await running.browser.get("/cards")).status).toBe(200);

    const freshRefusal = await asDrawn(fresh, "/selling/pause", {});
    // Somebody with no merchant is offered only the way to where they start.
    expect(freshRefusal.html).toContain(`href="${LATEST_REPORT}"`);
    expect(freshRefusal.html).not.toContain('href="/cards"');
    for (const { action, fields } of offered.filter(({ action }) => action !== "/sign-out")) {
      const answer = await asDrawn(fresh, action, fields);
      expect(answer.status === 409 && answer.html === freshRefusal.html, action).toBe(false);
    }
  });
});

describe("what the dashboard writes down about entry", () => {
  it("does not log the address, token, action URL, session, or merchant key", async () => {
    const running = await started();
    const lines: string[] = [];
    const collect = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
    const log = vi.spyOn(console, "log").mockImplementation(collect);
    const error = vi.spyOn(console, "error").mockImplementation(collect);
    try {
      await running.browser.post("/sign-in", { email: PERSON });
      const action = actionIn(running.mails.at(-1));
      const token = action.searchParams.get("token") ?? "";
      await running.browser.get(`${action.pathname}${action.search}`);
      await running.browser.from(running.url).post(action.pathname, { token });

      const said = lines.join("\n");
      expect(said).not.toContain(PERSON);
      expect(said).not.toContain(token);
      expect(said).not.toContain(action.toString());
      expect(said).not.toContain(running.browser.sessionToken() ?? "a-token-that-is-not-there");
      expect(said).not.toContain(KEY);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe("a press that fails in a way nobody planned for", () => {
  const said = async (during: () => Promise<void>): Promise<string> => {
    const lines: string[] = [];
    const collect = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
    const log = vi.spyOn(console, "log").mockImplementation(collect);
    const error = vi.spyOn(console, "error").mockImplementation(collect);
    try {
      await during();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    return lines.join("\n");
  };

  it("does not log values carried by an unexpected request failure", async () => {
    const marker = "token=raw-token merchant_key=raw-key session=raw-session";
    const { browser } = await started({
      registrar: {
        register: async () => {
          throw new Error(marker);
        },
      },
    });

    const written = await said(async () => {
      await browser.signIn(FRESH.email);
      expect((await browser.makeMerchant()).status).toBe(500);
    });

    expect(written).toMatch(/request failed/i);
    expect(written).not.toContain(marker);
    expect(written).not.toContain("raw-token");
    expect(written).not.toContain("raw-key");
    expect(written).not.toContain("raw-session");
  });
});

describe("naming a new key", () => {
  it("refuses a name longer than the one line a key is known by, and issues nothing", async () => {
    const running = await started();
    await running.browser.signIn();

    const refused = await running.browser.post("/keys", { label: "k".repeat(101) });

    expect(refused.status).toBe(400);
    const listed = await running.gateway.call("GET", "/v0/keys", { headers: asMerchant });
    expect((listed.body as MerchantKeyList).keys.some((key) => key.label.startsWith("kkk"))).toBe(
      false,
    );
  });
});

describe("a wallet change waiting on the live deployment", () => {
  // On live a replacement wallet is announced to every account naming the
  // merchant and waits forty-eight hours. The message says it takes effect only
  // if the wallet screen shows it, so the screen must show the waiting address
  // and the moment, and offer the cancel, by a signed-in person, in one press.
  const LIVE_DASHBOARD = {
    PAYMENT_NETWORK: "eip155:8453",
    FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  };
  const LIVE_GATEWAY = {
    ...LIVE_DASHBOARD,
    CDP_API_KEY_ID: "key-id",
    CDP_API_KEY_SECRET: "key-secret",
  };
  const WAITING = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
  const OVERTAKING = "0x0000000000000000000000000000000000000007";

  /**
   * A browser posts what the page it showed held, which is why the form carries
   * the change it showed.
   */
  const fromTheScreen = (screen: Visit): Record<string, string> => {
    const form = /<form[^>]*payout-wallet\/cancel[^>]*>([\s\S]*?)<\/form>/.exec(screen.html)?.[1];
    if (form === undefined) throw new Error("the settings screen carries no cancel form");
    return Object.fromEntries(
      [...form.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map((field) => [
        field[1] ?? "",
        field[2] ?? "",
      ]),
    );
  };

  /** What it sends besides the address, as the page was drawn. */
  const fromTheWalletForm = (screen: Visit): Record<string, string> => {
    const form = /<form[^>]*action="\/settings\/payout-wallet"[^>]*>([\s\S]*?)<\/form>/.exec(
      screen.html,
    )?.[1];
    if (form === undefined) throw new Error("the settings screen carries no wallet form");
    return Object.fromEntries(
      [...form.matchAll(/<input type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map(
        (field) => [field[1] ?? "", field[2] ?? ""],
      ),
    );
  };

  /** Where a change is announced and waits. */
  const live = async (options: Starting = {}): Promise<Running> =>
    await started({ ...options, gateway: LIVE_GATEWAY, dashboard: LIVE_DASHBOARD });

  /**
   * From another session: one somebody forgot to sign out of, or never owned.
   */
  const aChangeWaits = async (running: Running): Promise<void> => {
    const asked = await running.harnessed.gateway.setPayoutWallet(
      running.harnessed.merchant.id,
      WAITING,
      { kind: "signed_in", email: PERSON },
    );
    expect(typeof asked, JSON.stringify(asked)).toBe("object");
  };

  /** As the gateway answers it now. */
  const paidNow = async (running: Running): Promise<unknown> =>
    (
      (
        await running.gateway.call("GET", "/v0/payout-wallet", {
          headers: { authorization: `Bearer ${running.harnessed.merchant.key}` },
        })
      ).body as { payout_wallet: unknown }
    ).payout_wallet;

  const waitingNow = async (running: Running): Promise<unknown> =>
    (
      (
        await running.gateway.call("GET", "/v0/payout-wallet", {
          headers: { authorization: `Bearer ${running.harnessed.merchant.key}` },
        })
      ).body as { pending: unknown }
    ).pending;

  it("names, in the message, the account the session that asked is signed in as", async () => {
    // Two people at one merchant: the change comes from the second one's
    // session, and every account is told whose session it was.
    const running = await live();
    await running.identity.make(OTHER, running.theMerchant);
    const other = await running.another();
    await other.signIn(OTHER);
    const screen = await other.get("/settings");

    const asked = await other.post("/settings/payout-wallet", {
      ...fromTheWalletForm(screen),
      payout_wallet: WAITING,
    });

    expect(asked.status, asked.html).toBe(303);
    expect(running.harnessed.announcer.announced).toMatchObject([
      { kind: "wallet_change", to: WAITING, asked_with: { kind: "signed_in", email: OTHER } },
    ]);
  });

  it("shows the address waiting, the moment it takes effect, and a control to cancel it", async () => {
    const running = await live();
    await running.browser.signIn();
    await aChangeWaits(running);

    const screen = await running.browser.get("/settings");

    expect(screen.status).toBe(200);
    const text = screen.html.replaceAll(/<[^>]*>/g, "");
    expect(text).toContain(WAITING);
    expect(text).toContain(running.harnessed.merchant.wallet);
    // Forty-eight hours after the harness's clock, which starts at noon on
    // 2026-08-26.
    expect(readable(screen.html)).toContain("2026-08-28 12:00:00 UTC");
    expect(screen.html).toContain('action="/settings/payout-wallet/cancel"');
  });

  it("shows no cancel control where nothing is waiting", async () => {
    const running = await live();
    await running.browser.signIn();

    const screen = await running.browser.get("/settings");

    expect(screen.html).not.toContain('action="/settings/payout-wallet/cancel"');
  });

  it("cancels with one press, keeps the session that pressed, and signs every other session of the merchant out", async () => {
    const running = await live();
    await running.identity.make(OTHER, running.theMerchant);
    await running.browser.signIn();
    const otherDevice = await running.another();
    await otherDevice.signIn();
    const partner = await running.another();
    await partner.signIn(OTHER);
    await aChangeWaits(running);

    const pressed = await running.browser.post("/settings/payout-wallet/cancel");

    expect(pressed.status).toBe(303);
    expect(pressed.to).toBe("/settings");
    expect(await waitingNow(running)).toBeNull();
    expect((await running.browser.get("/settings")).status).toBe(200);
    // A session the person did not press from may be the one that asked, so it
    // ends: theirs on another device, and every other account's at the
    // merchant.
    expect((await otherDevice.get("/settings")).to).toMatch(/^\/sign-in/);
    expect((await partner.get("/cards")).to).toMatch(/^\/sign-in/);
  });

  it("signs nobody out when the gateway would not cancel", async () => {
    // A real refusal from the real gateway: another change is recorded between
    // the cancel's read and write, so the cancel is refused as raced and
    // nothing is written.
    const running = await live();
    await running.browser.signIn();
    const otherDevice = await running.another();
    await otherDevice.signIn();
    await aChangeWaits(running);
    const store = running.harnessed.store;
    const writing = store.setPayoutWallet.bind(store);
    let overtaken = false;
    store.setPayoutWallet = async (id, expected, next, when) => {
      if (!overtaken) {
        overtaken = true;
        await writing(
          id,
          expected,
          {
            address: running.harnessed.merchant.wallet,
            pending: { address: OVERTAKING, takesEffectAt: when + 48 * 60 * 60 * 1_000 },
          },
          when,
        );
      }
      return await writing(id, expected, next, when);
    };

    const pressed = await running.browser.post(
      "/settings/payout-wallet/cancel",
      fromTheScreen(await running.browser.get("/settings")),
    );

    expect(pressed.status).toBe(409);
    expect(await waitingNow(running)).toMatchObject({ payout_wallet: OVERTAKING });
    expect((await otherDevice.get("/settings")).status).toBe(200);
  });

  it("says a change that took effect before the press did take effect, and still signs the others out", async () => {
    // The unwanted change has just landed. It is not cancelled (nothing takes
    // it back at once) and the page must not say so; it signs every other
    // session out and says how the old address comes back.
    const said: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...parts) => said.push(parts.map(String).join(" ")));
    try {
      const running = await live();
      await running.browser.signIn();
      const otherDevice = await running.another();
      await otherDevice.signIn();
      await aChangeWaits(running);
      const screen = await running.browser.get("/settings");
      running.harnessed.advance(48 * 60 * 60 * 1_000);

      const pressed = await running.browser.post(
        "/settings/payout-wallet/cancel",
        fromTheScreen(screen),
      );

      expect(pressed.status).toBe(200);
      const page = readable(pressed.html);
      expect(page).toContain("2026-08-28 12:00:00 UTC");
      expect(pressed.html.replaceAll(/<[^>]*>/g, "")).toContain(WAITING);
      expect(page).not.toMatch(/cancelled/i);
      expect(await waitingNow(running)).toBeNull();
      expect(await paidNow(running)).toBe(WAITING);
      expect((await otherDevice.get("/settings")).to).toMatch(/^\/sign-in/);
      expect(said.join("\n")).not.toMatch(/cancelled/i);
    } finally {
      log.mockRestore();
    }
  });

  it("does not call a change back a cancel when the change took effect as it was pressed", async () => {
    // The change took effect before the gateway got the cancel, so asking for
    // the old address is a change back, which waits and is announced, and the
    // page and log say that.
    const said: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...parts) => said.push(parts.map(String).join(" ")));
    try {
      const holder: { running?: Running } = {};
      const running = await live({
        client: (real) => ({
          ...real,
          setPayoutWallet: async (address) => {
            holder.running?.harnessed.advance(48 * 60 * 60 * 1_000);
            return await real.setPayoutWallet(address);
          },
        }),
      });
      holder.running = running;
      await running.browser.signIn();
      const otherDevice = await running.another();
      await otherDevice.signIn();
      await aChangeWaits(running);

      const pressed = await running.browser.post(
        "/settings/payout-wallet/cancel",
        fromTheScreen(await running.browser.get("/settings")),
      );

      expect(pressed.status).toBe(200);
      expect(readable(pressed.html)).not.toMatch(/cancelled/i);
      expect(await paidNow(running)).toBe(WAITING);
      expect(await waitingNow(running)).toMatchObject({
        payout_wallet: running.harnessed.merchant.wallet,
      });
      expect((await otherDevice.get("/settings")).to).toMatch(/^\/sign-in/);
      expect(said.join("\n")).not.toMatch(/cancelled/i);
    } finally {
      log.mockRestore();
    }
  });

  it("is refused from a page on another site", async () => {
    const running = await live();
    await running.browser.signIn();
    await aChangeWaits(running);

    const pressed = await running.browser
      .from("https://elsewhere.example")
      .post("/settings/payout-wallet/cancel");

    expect(pressed.status).toBe(403);
    expect(await waitingNow(running)).not.toBeNull();
  });

  it("cancels a waiting change when the address paid now is typed in, and signs the others out", async () => {
    // Typing the current address is the same act as Cancel. Leaving the asking
    // session signed in would leave it free to ask again, and calling it a
    // change would misreport what happened.
    const said: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...parts) => said.push(parts.map(String).join(" ")));
    try {
      const running = await live();
      // Paid at an address with letters, so the one typed back can be in the
      // other spelling, as pasted from a block explorer.
      const PAID = checksummedAddressOf("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
      const { store } = running.harnessed;
      const merchant = await store.merchantById(running.harnessed.merchant.id);
      if (merchant === null) throw new Error("the harness's merchant is not in its store");
      await store.setPayoutWallet(
        merchant.id,
        merchant.payoutWallet,
        { address: PAID, pending: null },
        running.harnessed.now(),
      );
      await running.browser.signIn();
      const otherDevice = await running.another();
      await otherDevice.signIn();
      await aChangeWaits(running);

      const typed = await running.browser.post("/settings/payout-wallet", {
        payout_wallet: PAID.toLowerCase(),
      });

      expect(await waitingNow(running)).toBeNull();
      expect(await paidNow(running)).toBe(PAID);
      expect((await otherDevice.get("/settings")).to).toMatch(/^\/sign-in/);
      expect(readable(typed.html)).toMatch(/cancelled/i);
      expect(said.join("\n")).toMatch(/cancelled a waiting change/);
      expect(said.join("\n")).not.toMatch(/changed the address/);
    } finally {
      log.mockRestore();
    }
  });

  it("says a change that took effect before the old address was typed back took effect, and signs the others out", async () => {
    // Typing the address the page showed as paid, after the change took effect,
    // is the same act as Cancel there, not a new change that leaves the other
    // sessions signed in.
    const said: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...parts) => said.push(parts.map(String).join(" ")));
    try {
      const running = await live();
      await running.browser.signIn();
      const otherDevice = await running.another();
      await otherDevice.signIn();
      await aChangeWaits(running);
      const screen = await running.browser.get("/settings");
      running.harnessed.advance(48 * 60 * 60 * 1_000);

      const typed = await running.browser.post("/settings/payout-wallet", {
        ...fromTheWalletForm(screen),
        payout_wallet: running.harnessed.merchant.wallet,
      });

      expect(typed.status).toBe(200);
      expect(readable(typed.html)).toMatch(/took effect/i);
      expect(await paidNow(running)).toBe(WAITING);
      expect(await waitingNow(running)).toBeNull();
      expect((await otherDevice.get("/settings")).to).toMatch(/^\/sign-in/);
      expect(said.join("\n")).not.toMatch(/asked for a change/);
    } finally {
      log.mockRestore();
    }
  });

  it("signs nobody out when there was nothing to cancel", async () => {
    const running = await live();
    await running.browser.signIn();
    const otherDevice = await running.another();
    await otherDevice.signIn();

    const pressed = await running.browser.post("/settings/payout-wallet/cancel");

    expect(pressed.to).toBe("/settings");
    expect((await otherDevice.get("/settings")).status).toBe(200);
  });
});

describe("signing out every other device", () => {
  // It reaches this account's sessions and no other's, touches no key, and
  // needs no wallet change to be waiting.

  it("ends every other session of this account, keeps this one, and says how many", async () => {
    const running = await started();
    await running.browser.signIn();
    const laptop = await running.another();
    await laptop.signIn();
    const phone = await running.another();
    await phone.signIn();

    const pressed = await running.browser.post("/settings/sign-out-others");

    expect(pressed.status).toBe(200);
    expect(readable(pressed.html)).toMatch(/\b2\b/);
    expect(readable(pressed.html)).toMatch(/signed out/i);
    expect((await running.browser.get("/settings")).status).toBe(200);
    // Each of the others has to sign in again.
    expect((await laptop.get("/settings")).to).toMatch(/^\/sign-in/);
    expect((await phone.get("/cards")).to).toMatch(/^\/sign-in/);
  });

  it("counts no session of this browser's own that a second sign-in left behind", async () => {
    // A link opened in a signed-in browser replaces its session, so the count
    // is of other places.
    const running = await started();
    await running.browser.signIn();
    await running.browser.signIn();

    const pressed = await running.browser.post("/settings/sign-out-others");

    expect(readable(pressed.html)).toMatch(/no other session/i);
  });

  it("works with no wallet change waiting, and is offered on the settings screen", async () => {
    const running = await started();
    await running.browser.signIn();

    const screen = await running.browser.get("/settings");

    expect(screen.html).toContain('action="/settings/sign-out-others"');
    expect(await waitingOf(running)).toBeNull();
    expect((await running.browser.post("/settings/sign-out-others")).status).toBe(200);
  });

  it("leaves the sessions of another account at the same merchant alone", async () => {
    const running = await started();
    await running.identity.make(OTHER, running.theMerchant);
    await running.browser.signIn();
    const partner = await running.another();
    await partner.signIn(OTHER);

    await running.browser.post("/settings/sign-out-others");

    expect((await partner.get("/settings")).status).toBe(200);
  });

  it("is refused from a page on another site", async () => {
    const running = await started();
    await running.browser.signIn();
    const laptop = await running.another();
    await laptop.signIn();

    const pressed = await running.browser
      .from("https://elsewhere.example")
      .post("/settings/sign-out-others");

    expect(pressed.status).toBe(403);
    expect((await laptop.get("/settings")).status).toBe(200);
  });

  it("is behind the gate", async () => {
    const running = await started();

    const pressed = await running.browser.post("/settings/sign-out-others");

    expect(pressed.to).toMatch(/^\/sign-in/);
  });
});

describe("the screen a signed-out person was going to", () => {
  // A merchant whose session ran out opens a bookmark and signs in again from
  // the mail; landing on the cards, they would have to find their way back. The
  // same for screens a message links to with no token. The section travels to
  // the sign-in in the address and is kept with the link's token.
  const SECTIONS = ["orders", "receipts", "integrations", "keys", "settings", "woocommerce"];

  it.each(SECTIONS)("is %s after the link, for a visitor with no session", async (section) => {
    // Mounted with the shop screens, so the WooCommerce section is a page.
    const running = await started({ wooShops: memoryWooShops() });

    const arrived = await running.browser.get(`/${section}`);
    expect(arrived.to).toBe(`/sign-in?destination=${section}`);
    const form = await running.browser.get(arrived.to ?? "");
    expect(form.html).toContain(`name="destination" value="${section}"`);

    await running.browser.post("/sign-in", { email: PERSON, destination: section });
    const action = actionIn(running.mails.at(-1));
    const opened = await running.browser.from(running.url).post("/sign-in/open", {
      token: action.searchParams.get("token") ?? "",
    });

    expect(opened.to).toBe(`/${section}`);
    expect((await running.browser.get(opened.to ?? "")).status).toBe(200);
  });

  it("is kept for a session that ran out, beside the word that it did", async () => {
    const running = await started();
    await running.browser.signIn();
    await running.identity.endEverySessionFor(PERSON);

    const arrived = await running.browser.get("/orders");

    expect(arrived.to).toBe("/sign-in?reason=session-ended&destination=orders");
  });

  it("is kept for a form sent there with no session, so what was not saved can be done again", async () => {
    const running = await started();

    const sent = await running.browser.post("/keys", { label: "the stock worker" });

    expect(sent.to).toBe("/sign-in?reason=unsaved&destination=keys");
  });

  it("is the section an address below it belongs to: a screen inside it, or a form sent from it", async () => {
    // The form most likely lost is the payout wallet change, posted to an
    // address under the settings; the new-key form is a screen of the keys.
    const running = await started();

    const wallet = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: "0x1111111111111111111111111111111111111111",
    });
    const newKey = await running.browser.get("/keys/new");
    const disable = await running.browser.post("/keys/some-key/disable");

    expect(wallet.to).toBe("/sign-in?reason=unsaved&destination=settings");
    expect(newKey.to).toBe("/sign-in?destination=keys");
    expect(disable.to).toBe("/sign-in?reason=unsaved&destination=keys");
  });

  it("is kept for a form sent there after the session ended, beside the word that it was not saved", async () => {
    const running = await started();
    await running.browser.signIn();
    await running.identity.endEverySessionFor(PERSON);

    const sent = await running.browser.post("/keys", { label: "the stock worker" });

    expect(sent.to).toBe("/sign-in?reason=session-ended-unsaved&destination=keys");
  });

  it("is where a person already signed in goes from the sign-in that names it", async () => {
    const running = await started();
    await running.browser.signIn();

    const seen = await running.browser.get("/sign-in?destination=receipts");

    expect(seen.to).toBe("/receipts");
  });

  it("is the start for a person already signed in whose sign-in names something else", async () => {
    // The value is the browser's to send, so nothing in it may become the
    // address a person is sent to, another site's least of all.
    const running = await started();
    await running.browser.signIn();

    for (const named of ["//evil.example", "/evil.example", "https://evil.example", "ORDERS", ""]) {
      const seen = await running.browser.get(`/sign-in?destination=${encodeURIComponent(named)}`);
      expect(seen.to, named).toBe("/cards");
    }
    const twice = await running.browser.get("/sign-in?destination=keys&destination=orders");
    expect(twice.to).toBe("/cards");
  });

  it("is under the mount point where the dashboard is mounted under one", async () => {
    // Deployed under /dashboard, so a section read or written without it is an
    // address nothing answers.
    const running = await started({ base: "/dashboard" });

    const arrived = await running.browser.get("/dashboard/orders");
    expect(arrived.to).toBe("/dashboard/sign-in?destination=orders");

    await running.browser.post("/dashboard/sign-in", { email: PERSON, destination: "orders" });
    const action = actionIn(running.mails.at(-1));
    const opened = await running.browser
      .from(running.url)
      .post("/dashboard/sign-in/open", { token: action.searchParams.get("token") ?? "" });
    expect(opened.to).toBe("/dashboard/orders");

    const again = await running.browser.get("/dashboard/sign-in?destination=keys");
    expect(again.to).toBe("/dashboard/keys");
  });

  it("is not named for an address outside the sections", async () => {
    const running = await started();

    for (const path of ["/no-such-page", "/cards", "/keysmith"]) {
      expect((await running.browser.get(path)).to, path).toBe("/sign-in");
    }
  });
});

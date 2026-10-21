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

import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/core";
import { type Gateway, merchantPayout, payoutSplitFor, setPayoutWallet } from "@agentify/gateway";
import {
  buyOverHttp,
  type Harness,
  harness,
  type Served,
  serve,
  theMerchantKey,
} from "@agentify/gateway/testing";
import { telemetry } from "@agentify/observability/source";
import {
  type Card,
  checksummedAddressOf,
  MERCHANT_FINDINGS,
  type MerchantKey,
  type MerchantKeyList,
  OrderCloseRequestSchema,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalDirectory } from "./approval-command.js";
import { type DashboardConfig, loadConfig } from "./config.js";
import { SIGN_OUT_EVERY_OTHER_DEVICE } from "./control-labels.js";
import { DRAWN_FOR } from "./drawn-for.js";
import {
  type Acting,
  type Answer,
  type GatewayClient,
  gatewayFor,
  lateAnswer,
  type Registrar,
} from "./gateway.js";
import {
  type Identity,
  identityFor,
  LINK_CHANNEL_LIMIT,
  LINK_CLIENT_LIMIT,
  LINK_MIN_INTERVAL_MS,
  LINK_RATE_WINDOW_MS,
} from "./identity.js";
import type { Handover, Message, Postman } from "./mail.js";
import { NOT_AN_ADDRESS } from "./page-services.js";
import type { Pages } from "./pages.js";
import { buildApp } from "./server.js";
import { googleExchange } from "./testing/google.js";
import { formsIn, formTo, readable, shownMarkIn, waitingButton } from "./testing/html.js";
import { PAGES_IN_FRONT_OF_THE_GATE } from "./testing/in-front-of-the-gate.js";
import { rewindLinkSends } from "./testing/link-sends.js";
import { testPages } from "./testing/pages.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";
import { CLOSURE_NOTES } from "./views.js";
import { memoryWooShops, type WooShops } from "./woo-shops.js";

/**
 * Named rather than spelled again: the gateway reads the environment off the
 * key's prefix, so a copy would come apart from the harness when the prefix
 * changed.
 */

/** Every section of the dashboard a merchant works in. */
const ALL_SECTIONS = ["/cards", "/orders", "/receipts", "/keys", "/integrations", "/settings"];
const KEY = theMerchantKey("test");
const asMerchant = { authorization: `Bearer ${KEY}` };
const PAY_TO = "0x0000000000000000000000000000000000000001";

/** On the plain-http local origin. */
const COOKIE = "agentify.session_token";
/** Given anew by every press, so page data kept before it no longer matches. */
const PRESSED = "agentify.dashboard_pressed";
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
  readonly pages: Pages;
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
  readonly approvalDirectory?: ApprovalDirectory;
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
    pages: await testPages(),
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
    AUTH_SECRET: TEST_AUTH_SECRET,
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
    pages: await testPages(),
    gateway: application,
    approvalDirectory: options.approvalDirectory ?? {
      resolve: async (email) => {
        const found = await identity.byEmail(email.trim().toLowerCase());
        return found === null
          ? []
          : [
              found.merchant === null
                ? { email: found.email, binding: "unbound" as const }
                : { email: found.email, binding: "bound" as const, merchantId: found.merchant.id },
            ];
      },
    },
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
): Promise<{ status: number; head: string; body: string }> =>
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
        head: said.split("\r\n\r\n")[0] ?? "",
        body: readable(said.split("\r\n\r\n").slice(1).join("\r\n\r\n")),
      });
    });
  });

/**
 * Where the cards page's switches post: the page itself, naming the switch.
 * Written out because many tests press a switch without drawing the page; the
 * tests about what the page draws read its forms off it.
 */
const STOP_SELLING = "/cards?selling=pause";
const START_SELLING = "/cards?selling=resume";
const switchOf = (itemId: string, way: "pause" | "resume"): string =>
  `/cards?${new URLSearchParams({ [way]: itemId })}`;

/** The reasons the banner over a page names, in its order. */
const reasonsIn = (html: string): readonly string[] =>
  [...html.matchAll(/data-reason="([^"]+)"/g)].map(([, reason = ""]) => reason);

/** Each card's row on the cards screen, as markup. */
const rowsIn = (html: string): readonly string[] =>
  [...html.matchAll(/<li class="list-row[^"]*">([\s\S]*?)<\/li>/g)].map(([, row = ""]) => row);

/** The switches drawn for one card each. */
const cardSwitchesIn = (html: string) =>
  formsIn(html).filter(({ action }) => /^\/cards\?(pause|resume)=/.test(action));

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

it("keeps mounted dashboard assets separate from interactive traffic", async () => {
  const running = await started({ base: "/dashboard" });
  const app = buildApp(
    loadConfig({
      DATABASE_URL: "postgres://nobody@nowhere/unused",
      AUTH_SECRET: TEST_AUTH_SECRET,
      BASE_PATH: "/dashboard",
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "sandbox:scripted",
    }),
    {
      pages: {
        ...running.pages,
        assets: {
          path: "/dashboard/assets",
          handle: (_request, response) => response.end("asset"),
        },
      },
      gateway: running.harnessed.gateway,
      identity: running.identity,
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const count = async () => {
    const body = await telemetry.metrics();
    return Number(
      body.match(
        /^agentify_http_requests_total\{component="dashboard",route="asset",method="GET",status_class="2xx",traffic="client"\} ([\d.]+)$/m,
      )?.[1] ?? 0,
    );
  };
  try {
    const before = await count();
    expect(
      (await fetch(`${url}/dashboard/assets/private-build-name.js?token=private-token`)).status,
    ).toBe(200);
    expect((await fetch(`${url}/dashboard/healthz`)).status).toBe(200);
    expect(await count()).toBe(before + 1);
    const metrics = await telemetry.metrics();
    expect(metrics).toContain(
      'component="dashboard",route="/dashboard/healthz",method="GET",status_class="2xx"',
    );
    expect(metrics).not.toMatch(/private-build-name|private-token/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

describe("the passwordless dashboard door", () => {
  it.each(["", "/dashboard"])(
    "keeps the sign-in form and its answers out of search at %s",
    async (base) => {
      const { browser } = await started({ base });
      const path = `${base}/sign-in`;
      const pages = [
        await browser.get(path),
        await browser.get(`${path}?reason=session-ended&destination=settings`),
        await browser.post(path, { email: "not an address" }),
        await browser.post(path, { email: PERSON }),
      ];

      for (const page of pages) {
        expect(page.status).toBeLessThan(500);
        const head = page.html.slice(0, page.html.indexOf("</head>"));
        expect(head.match(/<meta\b[^>]*name="robots"[^>]*>/)?.[0]).toMatch(
          /content="[^"\n]*\bnoindex\b/,
        );
        expect(formTo(page.html, "post", path)).toBeDefined();
      }
    },
  );

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

  it("leaves a stranger the site header's ways back to the rest of the site, and no one's address", async () => {
    const { browser } = await started({ base: "/dashboard" });

    const page = (await browser.get("/dashboard/sign-in")).html;
    const bar = /<header class="site-header">([\s\S]*?)<\/header>/.exec(page)?.[1] ?? "";

    for (const href of [
      "/",
      "/docs/scanner",
      "/docs/scanner/methodology",
      "/docs/",
      "/dashboard",
    ]) {
      expect(bar, href).toContain(`href="${href}"`);
    }
    expect(bar).not.toContain("site-who");
    expect(formTo(bar, "post", "/dashboard/sign-out")).toBeUndefined();
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
    expect(formTo(known.html, "post", "/sign-in")?.fields.get("email")).toBe(PERSON);
    expect(formTo(known.html, "get", "/sign-in")).toBeDefined();
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
      expect(formTo(answer.html, "post", "/sign-in")?.fields.get("email")).toBe(PERSON);
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
    expect(formTo(limited.html, "post", "/sign-in")).toBeDefined();
    expect(formTo(limited.html, "get", "/sign-in")).toBeDefined();
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
    expect(formTo(again.html, "post", "/sign-in")).toBeDefined();
    expect(formTo(again.html, "get", "/sign-in")).toBeDefined();
    expect(mails).toHaveLength(1);
  });

  /** Documentation addresses, as the edge would write them: none of them is anybody's. */
  const CROWDED = { "x-forwarded-for": "198.51.100.7" };
  const ELSEWHERE = { "x-forwarded-for": "198.51.100.8" };
  const GOOGLE_ON = { GOOGLE_CLIENT_ID: "offline-client", GOOGLE_CLIENT_SECRET: "offline-secret" };

  /** Each refusal page with its address taken out, which is all two of them may differ by. */
  const withoutAddress = (page: Visit, email: string): string =>
    readable(page.html).replaceAll(email, "the address");

  const spendTheClientsHour = async (browser: Browser): Promise<void> => {
    for (let sent = 0; sent < LINK_CLIENT_LIMIT; sent += 1) {
      const page = await browser
        .sending(CROWDED)
        .post("/sign-in", { email: `person-${sent}@example.com` });
      expect(readable(page.html)).toContain("is on its way");
    }
  };

  it("sends no link past one client's hourly allowance, says so the same way for an address with an account and one without, and offers Google", async () => {
    const { browser, mails } = await started({ dashboard: GOOGLE_ON });
    await spendTheClientsHour(browser);

    const known = await browser.sending(CROWDED).post("/sign-in", { email: PERSON });
    const unknown = await browser
      .sending(CROWDED)
      .post("/sign-in", { email: "nobody@example.com" });

    expect(mails).toHaveLength(LINK_CLIENT_LIMIT);
    for (const page of [known, unknown]) {
      expect(page.status).toBe(202);
      expect(Number(page.headers.get("retry-after"))).toBeGreaterThan(LINK_MIN_INTERVAL_MS / 1_000);
      expect(readable(page.html)).not.toContain("is on its way");
      expect(formTo(page.html, "post", "/sign-in/google")).toBeDefined();
      const resend = waitingButton(page.html);
      expect(resend.attributes.get("data-link-wait")).toBe(page.headers.get("retry-after"));
      expect(resend.attributes.has("disabled")).toBe(false);
    }
    expect(withoutAddress(known, PERSON)).toBe(withoutAddress(unknown, "nobody@example.com"));
    // Not the page an address that spent its own hour gets: that one would
    // send the person to another address, which does not help here.
    expect(readable(known.html)).not.toContain("three links an hour");

    const elsewhere = await browser
      .sending(ELSEWHERE)
      .post("/sign-in", { email: "nobody@example.com" });
    expect(readable(elsewhere.html)).toContain("is on its way");
    expect(mails).toHaveLength(LINK_CLIENT_LIMIT + 1);
  });

  it("offers no Google sign-in on a client's refusal where Google is not configured", async () => {
    const { browser, mails } = await started();
    await spendTheClientsHour(browser);

    const refused = await browser.sending(CROWDED).post("/sign-in", { email: PERSON });

    expect(readable(refused.html)).not.toContain("is on its way");
    expect(formTo(refused.html, "post", "/sign-in/google")).toBeUndefined();
    expect(mails).toHaveLength(LINK_CLIENT_LIMIT);
  });

  it("does not count two visitors arriving through one private ingress address as one client", async () => {
    const { browser, mails } = await started();
    const throughTheIngress = browser.sending({ "x-forwarded-for": "::ffff:10.20.10.11" });

    for (let sent = 0; sent <= LINK_CLIENT_LIMIT; sent += 1) {
      const page = await throughTheIngress.post("/sign-in", {
        email: `visitor-${sent}@example.com`,
      });
      expect(readable(page.html)).toContain("is on its way");
    }

    expect(mails).toHaveLength(LINK_CLIENT_LIMIT + 1);
  });

  it("counts a client by the address the edge added, not by one a browser put in front of it", async () => {
    const { browser, mails } = await started();
    await spendTheClientsHour(browser);

    const forged = await browser
      .sending({ "x-forwarded-for": `203.0.113.99, ${CROWDED["x-forwarded-for"]}` })
      .post("/sign-in", { email: PERSON });

    expect(readable(forged.html)).not.toContain("is on its way");
    expect(mails).toHaveLength(LINK_CLIENT_LIMIT);
  });

  it("sends nobody a link once the channel has sent its hour's links, says so the same way for every address, and offers Google", async () => {
    const { browser, mails, rows } = await started({ dashboard: GOOGLE_ON });
    const now = Date.now();
    for (let sent = 0; sent < LINK_CHANNEL_LIMIT; sent += 1) {
      rows.dashboard_link_sends?.push({
        id: `arranged-${sent}`,
        emailHash: `arranged-${sent}`,
        clientHash: `arranged-${sent}`,
        purpose: "dashboard",
        sentAt: new Date(now),
        expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
      });
    }

    const known = await browser.sending(CROWDED).post("/sign-in", { email: PERSON });
    const unknown = await browser
      .sending(ELSEWHERE)
      .post("/sign-in", { email: "nobody@example.com" });

    expect(mails).toHaveLength(0);
    for (const page of [known, unknown]) {
      expect(page.status).toBe(202);
      expect(Number(page.headers.get("retry-after"))).toBeGreaterThan(LINK_MIN_INTERVAL_MS / 1_000);
      expect(readable(page.html)).not.toContain("is on its way");
      expect(formTo(page.html, "post", "/sign-in/google")).toBeDefined();
    }
    expect(withoutAddress(known, PERSON)).toBe(withoutAddress(unknown, "nobody@example.com"));
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
    expect(formTo(screen.html, "post", "/merchant")).toBeDefined();
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

  it("ends the session of a person whose account is gone, even on the day the session is renewed", async () => {
    // The gate renews a session once a day by setting its cookie again; a
    // page that clears the cookie must have the last word, or the renewal
    // would put back what the page took away.
    const running = await started({
      identity: (real) => ({
        ...real,
        attachMerchant: async () => ({ status: "person-missing" as const }),
      }),
    });
    await running.browser.signIn(FRESH.email);
    await running.browser.get("/merchant");
    const aDayAndAnHourAgo = Date.now() - 25 * 60 * 60 * 1_000;
    for (const session of sessionRows()) {
      session.expiresAt = new Date(aDayAndAnHourAgo + THIRTY_DAYS_SECONDS * 1_000);
    }

    const pressed = await running.browser.post("/merchant");

    expect(pressed.to).toBe("/sign-in");
    const session = pressed.headers.getSetCookie().filter((line) => line.startsWith(`${COOKIE}=`));
    expect(session.length).toBeGreaterThan(1);
    expect(session.at(-1)).toMatch(new RegExp(`^${COOKIE}=;`));
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

/** In the form the tracker's identifiers take, and nobody's. */
const CLICK = "qa_click_0123456789abcdef";
const ANOTHER_CLICK = "qa_click_fedcba9876543210";

/** A laptop's dashboard with the report switched on, posting to a receiver of its own. */
const REPORTING = {
  REGISTRATION_POSTBACK_ENABLED: "true",
  REGISTRATION_POSTBACK_KEY: ["qa", "synthetic", "postback", "key"].join("-"),
  REGISTRATION_POSTBACK_URL: "http://127.0.0.1:4010/postback",
} as const;

/** What a person reads on a page and what its forms would send, for telling two pages apart. */
const seenOn = (html: string) => ({
  text: readable(html),
  forms: formsIn(html).map((form) => ({ ...form, fields: [...form.fields] })),
});

/** The latest mailed link, pressed in the browser given. */
const openLatest = async (running: Running, browser: Browser = running.browser): Promise<Visit> => {
  const action = actionIn(running.mails.at(-1));
  return await browser
    .from(running.url)
    .post(action.pathname, { token: action.searchParams.get("token") ?? "" });
};

const registrationsIn = (running: Running): Record<string, unknown>[] =>
  running.rows.dashboard_registration_postbacks ?? [];

/**
 * Whether anything a sign-in keeps on the server until it is finished, a
 * link's claim or a Google sign-in's state, holds the click.
 */
const keptBeforeSignIn = (running: Running, click: string): boolean =>
  JSON.stringify(running.rows.dashboard_verifications ?? []).includes(click);

describe("the report to the ad tracker of a registration its ad brought", () => {
  it("draws the sign-in page as it is without a click, asking nothing, and carries the click in its form", async () => {
    const { browser } = await started({ dashboard: REPORTING });
    const today = await browser.get("/sign-in");

    const page = await browser.get(`/sign-in?clickid=${CLICK}`);

    expect(page.status).toBe(200);
    expect(readable(page.html)).toBe(readable(today.html));
    expect(page.html).not.toContain('type="checkbox"');
    expect(formTo(page.html, "post", "/sign-in")?.fields.get("clickid")).toBe(CLICK);
  });

  it("draws today's page for a click that is missing, malformed, repeated or too long", async () => {
    const { browser } = await started({ dashboard: REPORTING });
    const today = seenOn((await browser.get("/sign-in")).html);

    for (const query of [
      "",
      "?clickid=",
      "?clickid=too-short",
      `?clickid=${CLICK}%20`,
      `?clickid=${CLICK.replace("_", ".")}`,
      `?clickid=${CLICK}&clickid=${ANOTHER_CLICK}`,
      `?clickid=${"a".repeat(65)}`,
    ]) {
      const page = await browser.get(`/sign-in${query}`);
      expect(page.status, query).toBe(200);
      expect(seenOn(page.html), query).toStrictEqual(today);
    }
  });

  it("draws today's pages, keeps no click and records nothing while the report is switched off, even for a valid click", async () => {
    const running = await started();
    const sameAs = (html: string, email: string) => seenOn(html.replaceAll(email, "x@example.com"));

    const today = await running.browser.get("/sign-in");
    const offered = await running.browser.get(`/sign-in?clickid=${CLICK}`);
    const plainlyRefused = await running.browser.post("/sign-in", { email: "not an address" });
    const refused = await running.browser.post("/sign-in", {
      email: "not an address",
      clickid: CLICK,
    });
    const plainlyAsked = await running.browser.post("/sign-in", { email: OTHER });
    const asked = await running.browser.post("/sign-in", { email: FRESH.email, clickid: CLICK });

    expect(seenOn(offered.html)).toStrictEqual(seenOn(today.html));
    expect(seenOn(refused.html)).toStrictEqual(seenOn(plainlyRefused.html));
    expect(asked.status).toBe(202);
    expect(sameAs(asked.html, FRESH.email)).toStrictEqual(sameAs(plainlyAsked.html, OTHER));
    expect(keptBeforeSignIn(running, CLICK)).toBe(false);
    const opened = await openLatest(running);
    expect(opened.status).toBe(303);
    expect((await running.identity.byEmail(FRESH.email))?.confirmed).toBe(true);
    expect(registrationsIn(running)).toStrictEqual([]);
  });

  it("leaves one pending registration holding the click, and nothing else of the sign-in, once a link asked for with it is opened", async () => {
    const running = await started({ dashboard: REPORTING });
    const page = await running.browser.get(`/sign-in?clickid=${CLICK}`);
    const form = formTo(page.html, "post", "/sign-in");

    const asked = await running.browser.post("/sign-in", {
      ...Object.fromEntries(form?.fields ?? []),
      email: FRESH.email,
    });
    expect(asked.status).toBe(202);
    expect(registrationsIn(running)).toStrictEqual([]);

    const opened = await openLatest(running);

    expect(opened.status).toBe(303);
    const person = await running.identity.byEmail(FRESH.email);
    expect(registrationsIn(running)).toStrictEqual([
      {
        accountId: person?.id,
        clickId: CLICK,
        state: "pending",
        attempts: 0,
        nextAttemptAt: expect.any(Date),
        lastOutcome: null,
        createdAt: expect.any(Date),
        settledAt: null,
      },
    ]);
  });

  it("records nothing for a sign-in after the first, or for an address already verified", async () => {
    const running = await started({ dashboard: REPORTING });
    await running.browser.post("/sign-in", { email: FRESH.email, clickid: CLICK });
    await openLatest(running);
    const first = structuredClone(registrationsIn(running));
    await running.browser.post("/sign-in", { email: OTHER });
    await openLatest(running);

    for (const [email, click] of [
      [FRESH.email, ANOTHER_CLICK],
      [OTHER, CLICK],
    ] as const) {
      rewindLinkSends(running.rows);
      const visitor = await running.another();
      await visitor.post("/sign-in", { email, clickid: click });
      expect((await openLatest(running, visitor)).status, email).toBe(303);
    }

    expect(first).toMatchObject([{ clickId: CLICK }]);
    expect(registrationsIn(running)).toStrictEqual(first);
  });

  it("keeps nothing for a click it cannot read, or one named twice", async () => {
    const running = await started({ dashboard: REPORTING });

    for (const clickid of [undefined, "too-short", `${CLICK}!`]) {
      rewindLinkSends(running.rows);
      const asked = await running.browser.post("/sign-in", {
        email: FRESH.email,
        ...(clickid === undefined ? {} : { clickid }),
      });
      expect(asked.status, clickid).toBe(202);
      for (const form of formsIn(asked.html))
        expect(form.fields.has("clickid"), clickid).toBe(false);
    }
    rewindLinkSends(running.rows);
    const twice = await running.browser.postRaw(
      "/sign-in",
      "application/x-www-form-urlencoded",
      `email=${encodeURIComponent(FRESH.email)}&clickid=${CLICK}&clickid=${ANOTHER_CLICK}`,
    );
    expect(twice.status).toBe(202);
    for (const form of formsIn(twice.html)) expect(form.fields.has("clickid")).toBe(false);
    expect(keptBeforeSignIn(running, CLICK)).toBe(false);
    expect(keptBeforeSignIn(running, ANOTHER_CLICK)).toBe(false);
    const opened = await openLatest(running);

    expect(opened.status).toBe(303);
    expect(registrationsIn(running)).toStrictEqual([]);
  });

  it("keeps the click on the page that refuses an address", async () => {
    const { browser } = await started({ dashboard: REPORTING });

    const refused = await browser.post("/sign-in", { email: "not an address", clickid: CLICK });

    expect(refused.status).toBe(400);
    expect(readable(refused.html)).toContain(NOT_AN_ADDRESS);
    expect(formTo(refused.html, "post", "/sign-in")?.fields.get("clickid")).toBe(CLICK);
  });

  it("carries the click into the next link, and to the page that asks for another address", async () => {
    const running = await started({ dashboard: REPORTING });
    const asked = await running.browser.post("/sign-in", { email: FRESH.email, clickid: CLICK });

    const resend = formTo(asked.html, "post", "/sign-in");
    expect(resend?.fields.get("clickid")).toBe(CLICK);
    const elsewhere = formTo(asked.html, "get", "/sign-in");
    expect(elsewhere?.fields.get("clickid")).toBe(CLICK);

    // The link that is opened is the one that counts, so the second carries
    // the click as the first did.
    rewindLinkSends(running.rows);
    const again = await running.browser.post("/sign-in", Object.fromEntries(resend?.fields ?? []));
    expect(again.status).toBe(202);
    expect(running.mails).toHaveLength(2);
    await openLatest(running);
    expect(registrationsIn(running)).toMatchObject([{ clickId: CLICK, state: "pending" }]);

    const other = await running.another();
    const offeredAgain = await other.get(
      `/sign-in?${new URLSearchParams([...(elsewhere?.fields ?? [])])}`,
    );
    expect(formTo(offeredAgain.html, "post", "/sign-in")?.fields.get("clickid")).toBe(CLICK);
  });

  it("keeps the click on the way back from a link the mail could not send", async () => {
    const running = await started({ dashboard: REPORTING, mailTakes: "refused" });

    const refused = await running.browser.post("/sign-in", {
      email: FRESH.email,
      clickid: CLICK,
    });

    expect(refused.status).toBe(503);
    const back = formTo(refused.html, "get", "/sign-in");
    expect([...(back?.fields ?? [])]).toStrictEqual([["clickid", CLICK]]);
    const offered = await running.browser.get(
      `/sign-in?${new URLSearchParams([...(back?.fields ?? [])])}`,
    );
    expect(formTo(offered.html, "post", "/sign-in")?.fields.get("clickid")).toBe(CLICK);
  });

  it("records the registration when the link is opened in a browser that never asked for it", async () => {
    // Nothing about the click rides in a cookie: it travels with the link.
    const running = await started({ dashboard: REPORTING });
    await running.browser.post("/sign-in", { email: FRESH.email, clickid: CLICK });

    const elsewhere = await running.another();
    const opened = await openLatest(running, elsewhere);

    expect(opened.status).toBe(303);
    expect(registrationsIn(running)).toMatchObject([{ clickId: CLICK, state: "pending" }]);
  });

  it("sets no cookie on a visitor an ad sent, asking or not", async () => {
    const { browser } = await started({ dashboard: REPORTING });

    const page = await browser.get(`/sign-in?clickid=${CLICK}`);
    const asked = await browser.post("/sign-in", { email: FRESH.email, clickid: CLICK });
    const refused = await browser.post("/sign-in", { email: "not an address", clickid: CLICK });

    expect(page.headers.getSetCookie()).toStrictEqual([]);
    expect(asked.headers.getSetCookie()).toStrictEqual([]);
    expect(refused.headers.getSetCookie()).toStrictEqual([]);
  });

  it("sends a signed-in visitor an ad brought on as before, and records nothing", async () => {
    const running = await started({ dashboard: REPORTING });
    await running.browser.signIn();
    const mailed = running.mails.length;
    const sends = running.rows.dashboard_link_sends?.length;

    const page = await running.browser.get(`/sign-in?clickid=${CLICK}`);

    expect(page.status).toBe(303);
    expect(page.to).toBe("/cards");
    expect(running.mails).toHaveLength(mailed);
    expect(running.rows.dashboard_link_sends).toHaveLength(sends ?? 0);
    expect(registrationsIn(running)).toStrictEqual([]);
  });
});

describe("the click of a visitor an ad sent, through the Google sign-in", () => {
  const GOOGLE = { GOOGLE_CLIENT_ID: "offline-client", GOOGLE_CLIENT_SECRET: "offline-secret" };

  /** Google's code exchange is answered in the process; every other request goes out. */
  const exchangingWithGoogle = () => {
    const google = googleExchange();
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", ((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url === "https://oauth2.googleapis.com/token"
        ? google.fetch(input, init)
        : nativeFetch(input, init);
    }) satisfies typeof fetch);
    return google;
  };

  /**
   * A Google sign-in pressed with this form, in a browser of its own, by the
   * Google account of this address; with everything the browser was sent along
   * the way, its addresses and cookies, for looking for the click in.
   */
  const signInWithGoogle = async (
    running: Running,
    google: ReturnType<typeof googleExchange>,
    press: Record<string, string>,
    email: string,
  ) => {
    const browser = await running.another();
    const sent = await browser.from(running.url).post("/sign-in/google", press);
    const returned = await browser.get(
      `/sign-in/google/callback?${google.authorize(sent.to ?? "", { sub: email, email })}`,
    );
    const seen = [sent.to, returned.to, ...sent.headers.getSetCookie()]
      .concat(returned.headers.getSetCookie())
      .map((line) => decodeURIComponent(line ?? ""))
      .join("\n");
    return { sent, returned, seen };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries the click with the Google press as with the email press, asking nothing", async () => {
    const { browser } = await started({ dashboard: { ...REPORTING, ...GOOGLE } });
    const today = await browser.get("/sign-in?destination=settings");

    const page = await browser.get(`/sign-in?clickid=${CLICK}&destination=settings`);

    const google = formTo(page.html, "post", "/sign-in/google");
    expect(google?.fields.get("clickid")).toBe(CLICK);
    expect(google?.fields.get("destination")).toBe("settings");
    expect(formTo(page.html, "post", "/sign-in")?.fields.get("clickid")).toBe(CLICK);
    expect(readable(page.html)).toBe(readable(today.html));
    expect(page.html).not.toContain('type="checkbox"');
  });

  it("takes the click through Google to one registration, and none for a click it cannot read, in no cookie and no address the browser is sent to", async () => {
    const google = exchangingWithGoogle();
    const running = await started({ dashboard: { ...REPORTING, ...GOOGLE } });
    const page = await running.browser.get(`/sign-in?clickid=${CLICK}&destination=settings`);
    const form = Object.fromEntries(formTo(page.html, "post", "/sign-in/google")?.fields ?? []);

    const carried = await signInWithGoogle(running, google, form, "carried@gmail.com");
    const unreadable = await signInWithGoogle(
      running,
      google,
      { ...form, clickid: "too-short" },
      "unreadable@gmail.com",
    );

    for (const flow of [carried, unreadable]) {
      expect(flow.sent.status).toBe(303);
      expect(flow.returned.status).toBe(303);
      expect(flow.returned.to).toBe("/merchant");
      expect(flow.seen).not.toContain(CLICK);
    }
    const person = await running.identity.byEmail("carried@gmail.com");
    expect(registrationsIn(running)).toMatchObject([
      { accountId: person?.id, clickId: CLICK, state: "pending" },
    ]);
    expect(registrationsIn(running)).toHaveLength(1);
    expect((await running.identity.byEmail("unreadable@gmail.com"))?.confirmed).toBe(true);
  });

  it("draws the Google page as it is, keeps no click and records nothing while the report is switched off", async () => {
    const google = exchangingWithGoogle();
    const running = await started({ dashboard: GOOGLE });

    const today = await running.browser.get("/sign-in");
    const offered = await running.browser.get(`/sign-in?clickid=${CLICK}`);
    const browser = await running.another();
    const sent = await browser.from(running.url).post("/sign-in/google", { clickid: CLICK });
    const keptWhileAway = keptBeforeSignIn(running, CLICK);
    const returned = await browser.get(
      `/sign-in/google/callback?${google.authorize(sent.to ?? "", { sub: "person@gmail.com", email: "person@gmail.com" })}`,
    );

    expect(seenOn(offered.html)).toStrictEqual(seenOn(today.html));
    expect(keptWhileAway).toBe(false);
    expect(returned.status).toBe(303);
    expect((await running.identity.byEmail("person@gmail.com"))?.confirmed).toBe(true);
    expect(registrationsIn(running)).toStrictEqual([]);
  });

  it("draws the Google page as it is for a visitor with no click, or one it cannot read", async () => {
    const off = await started({ dashboard: GOOGLE });
    const today = seenOn((await off.browser.get("/sign-in")).html);
    await off.browser.close();
    await off.identity.close();
    await off.gateway.close();
    await off.harnessed.stop();
    const { browser } = await started({ dashboard: { ...REPORTING, ...GOOGLE } });

    for (const query of ["", "?clickid=too-short", `?clickid=${CLICK}&clickid=${ANOTHER_CLICK}`]) {
      expect(seenOn((await browser.get(`/sign-in${query}`)).html), query).toStrictEqual(today);
    }
  });

  it("carries the click on the page a cancelled Google sign-in returns to, keeping it out of its cookies, and a link asked for from there reports it", async () => {
    const google = exchangingWithGoogle();
    const running = await started({ dashboard: { ...REPORTING, ...GOOGLE } });
    const sent = await running.browser.from(running.url).post("/sign-in/google", {
      clickid: CLICK,
      destination: "settings",
    });
    const cancelled = google.authorize(sent.to ?? "");
    cancelled.delete("code");
    cancelled.set("error", "access_denied");

    const refused = await running.browser.get(`/sign-in/google/callback?${cancelled}`);

    expect(refused.status).toBe(401);
    const again = formTo(refused.html, "post", "/sign-in");
    expect(again?.fields.get("clickid")).toBe(CLICK);
    expect(again?.fields.get("destination")).toBe("settings");
    expect(formTo(refused.html, "post", "/sign-in/google")?.fields.get("clickid")).toBe(CLICK);
    expect(refused.headers.getSetCookie().map(decodeURIComponent).join("\n")).not.toContain(CLICK);
    const asked = await running.browser.post("/sign-in", {
      ...Object.fromEntries(again?.fields ?? []),
      email: FRESH.email,
    });
    expect(asked.status).toBe(202);
    expect((await openLatest(running)).status).toBe(303);
    expect(registrationsIn(running)).toMatchObject([{ clickId: CLICK }]);
  });

  it("keeps the click when Google cannot be started", async () => {
    const running = await started({
      dashboard: REPORTING,
      identity: (real) => ({
        ...real,
        googleEnabled: true,
        async startGoogle() {
          return { status: "unavailable" };
        },
      }),
    });

    const failed = await running.browser.post("/sign-in/google", {
      clickid: CLICK,
      destination: "settings",
    });

    expect(failed.status).toBe(503);
    const again = formTo(failed.html, "post", "/sign-in");
    expect(again?.fields.get("clickid")).toBe(CLICK);
    expect(again?.fields.get("destination")).toBe("settings");
  });
});

describe("the link's page for a link asked for with an ad's click", () => {
  it("draws the same one-button page whether or not its press will report, and writes nothing until pressed", async () => {
    const running = await started({ dashboard: REPORTING });
    const pages: string[] = [];
    const ask = async (form: Record<string, string>) => {
      rewindLinkSends(running.rows);
      await running.browser.post("/sign-in", { email: FRESH.email, ...form });
      const action = actionIn(running.mails.at(-1));
      const landing = await (await running.another()).get(`${action.pathname}${action.search}`);
      expect(landing.status).toBe(200);
      pages.push(landing.html.replaceAll(action.searchParams.get("token") ?? "", "TOKEN"));
    };

    await ask({});
    await ask({ clickid: CLICK });

    const [plain, reporting] = pages.map(seenOn);
    expect(reporting).toStrictEqual(plain);
    const form = formTo(pages[1] ?? "", "post", "/sign-in/open");
    expect(form?.presses.map(({ name, value }) => ({ name, value }))).toStrictEqual([
      { name: undefined, value: undefined },
    ]);
    expect(await running.identity.byEmail(FRESH.email)).toBeNull();
    expect(registrationsIn(running)).toStrictEqual([]);
  });
});

describe("what the React pages take from a stranger", () => {
  it("reads a body that is not a form as a form with nothing in it", async () => {
    // A program can post anything; the pages answer it as the empty form it
    // amounts to, never as a fault of the dashboard's.
    const { browser } = await started();

    const asked = await browser.postRaw("/sign-in", "text/plain", "email=owner@example.com");
    const opened = await browser.postRaw("/sign-in/open", "application/json", '{"token":"x"}');

    expect(asked.status).toBe(400);
    expect(readable(asked.html)).toContain("Enter an address of the shape someone@example.com.");
    expect(opened.status).toBe(401);
    expect(readable(opened.html)).toContain("That link no longer works");
  });

  it("takes a page's action only as a form post, so no other method gets past the origin check", async () => {
    // The origin check reads posts, so a sign-out sent by another site as
    // DELETE must not reach the action that ends the session.
    const running = await started();
    await running.browser.signIn();
    const signedIn = running.rows.dashboard_sessions?.length ?? 0;

    const answered = await fetch(`${running.url}/sign-out`, {
      method: "DELETE",
      body: "x",
      redirect: "manual",
      headers: {
        cookie: `${COOKIE}=${running.browser.sessionToken() ?? ""}`,
        origin: "https://evil.example",
      },
    });

    expect(answered.headers.getSetCookie()).toStrictEqual([]);
    expect(running.rows.dashboard_sessions).toHaveLength(signedIn);
    expect(signedIn).toBeGreaterThan(0);
  });

  it("writes nothing a stranger sent into the log, from an address or the route table's question", async () => {
    // A path that cannot be decoded is one React Router would write to the log
    // as it came, and a newline in it forges a line in the record of who did
    // what. The build's version, which the route table asks for, is public.
    const { browser, pages, url } = await started();
    const build = typeof pages.build === "function" ? await pages.build() : pages.build;
    const version = build.assets.version;
    const written: string[] = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...said: unknown[]) => {
        written.push(said.map(String).join(" "));
      });
    }

    const page = await browser.get("/cards%E0%A4%A");
    const forged = encodeURIComponent("/%E0\n[dashboard] forged");
    // A second question mark is part of the query to React Router, which reads
    // the question from everything after the first.
    const tables = [
      await browser.get(`/__manifest?version=${version}&paths=${forged}`),
      await browser.get(`/__manifest?version=${version}&x=?&paths=${forged}`),
      // Dot segments, which a browser takes out before sending and React
      // Router takes out on arrival, so they are written on the wire by hand.
      await overASocket(url, `/x/../__manifest?version=${version}&paths=${forged}`, ""),
      await overASocket(url, `/x/%2e%2e/__manifest?version=${version}&paths=${forged}`, ""),
    ];
    vi.restoreAllMocks();

    expect(page.status).toBeLessThan(500);
    expect(tables.map((table) => table.status)).toStrictEqual([400, 400, 400, 400]);
    expect(written.filter((line) => /%E0|forged/.test(line))).toStrictEqual([]);
  });

  it("refuses a form longer than any page sends, or one that does not say its length, unread", async () => {
    // React Router reads a form whole, so a body is bounded before it is read;
    // the refusal is the dashboard's page, saying what was wrong with it.
    const running = await started();
    await running.browser.signIn();

    const long = await running.browser.post("/keys", { label: "x".repeat(17_000) });
    const unsaid = await fetch(`${running.url}/keys`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: `${COOKIE}=${running.browser.sessionToken() ?? ""}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      // A stream has no length to declare, so it is sent in chunks.
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("label=nightly"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);

    for (const [name, status, html] of [
      ["longer", long.status, long.html],
      ["unsaid", unsaid.status, await unsaid.text()],
    ] as const) {
      expect(status, name).toBe(413);
      expect(readable(html), name).toContain("That was larger than any form on this page sends.");
    }
    const keys = await running.browser.get("/keys");
    expect(readable(keys.html)).not.toContain("nightly");
  });

  it("decides what a browser may keep by the page React Router answers, however its address is written", async () => {
    // A path with dot segments in it is answered as the path they lead to,
    // and so is what may be kept of it: the key list never.
    const { browser, url } = await started();
    await browser.signIn();
    const cookie = `${COOKIE}=${browser.sessionToken() ?? ""}`;

    for (const path of ["/x/../keys.data", "/x/%2e%2e/keys.data", "/x/./../keys.data"]) {
      const answered = await overASocket(url, path, cookie);
      expect(answered.status, path).toBe(200);
      expect(/^cache-control: (.*)$/im.exec(answered.head)?.[1], path).toBe("private, no-store");
    }
  });

  it("never lets a browser keep the data of the page a mailed link lands on", async () => {
    // That page holds a one-time token and runs no script, so nothing of the
    // pages' own asks for its data; asked by hand, it is kept nowhere.
    const { browser } = await started();

    const data = await browser.get(`/sign-in/open.data?token=${"D".repeat(32)}`);

    expect(data.headers.get("cache-control")).toBe("private, no-store");
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
 * added later: the routes beside the pages off the Express router, and the
 * pages off React Router's build, by the methods each answers.
 */
const routesOf = async (running: Running): Promise<{ method: string; path: string }[]> => {
  const build =
    typeof running.pages.build === "function" ? await running.pages.build() : running.pages.build;
  const pathOf = (id: string | undefined): string => {
    const route = id === undefined ? undefined : build.routes[id];
    return route === undefined
      ? ""
      : [pathOf(route.parentId), route.path ?? ""].filter((part) => part !== "").join("/");
  };
  const drawn = Object.values(build.routes).flatMap((route) => {
    if (route === undefined || (route.path ?? "") === "") return [];
    const module = route.module as { default?: unknown; loader?: unknown; action?: unknown };
    const path = `/${pathOf(route.id)}`.replaceAll(/:[a-z_]+/g, "x");
    return [
      ...(module.loader !== undefined ||
      (module.default !== undefined && module.action === undefined)
        ? [{ method: "get", path }]
        : []),
      ...(module.action !== undefined ? [{ method: "post", path }] : []),
    ];
  });
  const listed = buildApp(
    loadConfig({
      DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
      AUTH_SECRET: "x".repeat(44),
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "sandbox:scripted",
    }),
    {
      pages: running.pages,
      gateway: running.harnessed.gateway,
      identity: running.identity,
      wooShops: memoryWooShops(),
    },
  );
  return (listed.router.stack as { route?: { path: string; methods: Record<string, boolean> } }[])
    .flatMap(({ route }) =>
      route === undefined
        ? []
        : Object.keys(route.methods).map((method) => ({
            method,
            path: route.path.replaceAll(/:[a-z_]+/g, "x"),
          })),
    )
    .concat(drawn);
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
    const routes = await routesOf(running);
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

describe("the Google dashboard door", () => {
  const stateCookie = "agentify.oauth_state=browser-bound; Path=/; HttpOnly; SameSite=Lax";
  const clearedState = "agentify.oauth_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax";

  it("offers Google only when configured, while the email door stays open without it", async () => {
    const running = await started();
    const page = await running.browser.get("/sign-in?destination=settings");

    expect(formTo(page.html, "post", "/sign-in/google")).toBeUndefined();
    expect(formTo(page.html, "post", "/sign-in")?.fields.get("destination")).toBe("settings");
    const unavailable = await running.browser.post("/sign-in/google", { destination: "settings" });
    expect(unavailable.status).toBe(503);
    expect(formTo(unavailable.html, "post", "/sign-in")?.fields.get("destination")).toBe(
      "settings",
    );
    expect((await running.browser.post("/sign-in", { email: PERSON })).status).toBe(202);
  });

  it("starts a browser navigation from its own post and carries only a closed dashboard destination", async () => {
    const running = await started({
      base: "/dashboard",
      identity: (real) => ({
        ...real,
        googleEnabled: true,
        async startGoogle(destination) {
          return {
            status: "redirect",
            location: `https://accounts.google.com/o/oauth2/v2/auth?destination=${destination}`,
            setCookies: [stateCookie],
          };
        },
      }),
    });
    const page = await running.browser.get("/dashboard/sign-in?destination=settings");
    expect(formTo(page.html, "post", "/dashboard/sign-in/google")?.fields.get("destination")).toBe(
      "settings",
    );

    const sent = await running.browser
      .from(running.url)
      .post("/dashboard/sign-in/google", { destination: "settings" });
    expect(sent.status).toBe(303);
    expect(sent.to).toBe("https://accounts.google.com/o/oauth2/v2/auth?destination=settings");
    expect(sent.headers.getSetCookie()).toContain(stateCookie);
    expect(running.rows.dashboard_sessions).toStrictEqual([]);

    const external = await running.browser.post("/dashboard/sign-in/google", {
      destination: "https://elsewhere.example",
    });
    expect(external.to).toBe("https://accounts.google.com/o/oauth2/v2/auth?destination=default");
    const forged = await running.browser
      .from("https://test.agentify.ad")
      .post("/dashboard/sign-in/google");
    expect(forged.status).toBe(403);
    expect(
      forged.headers.getSetCookie().filter((line) => line.startsWith("agentify.oauth_state=")),
    ).toStrictEqual([]);
  });

  for (const reason of [
    "email-unverified",
    "email-changed",
    "cancelled",
    "invalid",
    "unavailable",
  ] as const) {
    it(`keeps a mail alternative and the trusted destination after Google answers ${reason}`, async () => {
      const email =
        reason === "email-unverified" || reason === "email-changed" ? "owner@example.net" : null;
      const running = await started({
        base: "/dashboard",
        identity: (real) => ({
          ...real,
          googleEnabled: true,
          async finishGoogle() {
            return {
              status: "refused",
              reason,
              email,
              destination: "settings",
              setCookies: [clearedState],
            };
          },
        }),
      });
      const refused = await running.browser.get(
        "/dashboard/sign-in/google/callback?state=state&error=attacker-secret&email=attacker@example.com&destination=https://elsewhere.example",
      );

      expect(refused.status).toBe(reason === "unavailable" ? 503 : 401);
      expect(formTo(refused.html, "post", "/dashboard/sign-in")?.fields.get("destination")).toBe(
        "settings",
      );
      expect(formTo(refused.html, "post", "/dashboard/sign-in")?.fields.get("email")).toBe(
        reason === "email-unverified" ? email : "",
      );
      expect(refused.html).not.toContain("attacker@example.com");
      expect(refused.html).not.toContain("attacker-secret");
      expect(refused.html).not.toContain("<script");
      expect(refused.headers.getSetCookie()).toContain(clearedState);
      expect(running.rows.dashboard_sessions).toStrictEqual([]);
    });
  }

  it("replaces only this browser's old session after Google succeeds and follows the held destination", async () => {
    let opening: Awaited<ReturnType<Identity["openLink"]>> = { status: "refused" };
    const running = await started({
      identity: (real) => ({
        ...real,
        googleEnabled: true,
        async finishGoogle() {
          if (opening.status !== "opened") throw new Error("the identity did not open a session");
          return { ...opening, destination: "settings" };
        },
      }),
    });
    await running.identity.make(OTHER, running.theMerchant);
    await running.browser.signIn(PERSON);
    const oldToken = running.browser.sessionToken();
    const otherDevice = await running.another();
    await otherDevice.signIn(PERSON);
    await running.browser.post("/sign-in", { email: OTHER });
    opening = await running.identity.openLink(
      actionIn(running.mails.at(-1)).searchParams.get("token") ?? "",
    );

    const opened = await running.browser.get(
      "/sign-in/google/callback?state=held&code=google-code",
    );

    expect(opened.status).toBe(303);
    expect(opened.to).toBe("/settings");
    expect(running.browser.sessionToken()).not.toBe(oldToken);
    expect(readable((await running.browser.get("/settings")).html)).toContain(OTHER);
    const oldSession = await running.browser
      .withRawCookie(`${COOKIE}=${oldToken}`)
      .get("/settings");
    expect(oldSession.status).toBe(303);
    expect(oldSession.to).toMatch(/^\/sign-in/);
    expect((await otherDevice.get("/settings")).status).toBe(200);
  });

  it("does not sign an existing browser out when Google refuses", async () => {
    const running = await started({
      identity: (real) => ({
        ...real,
        googleEnabled: true,
        async finishGoogle() {
          return {
            status: "refused",
            reason: "invalid",
            email: null,
            destination: "default",
            setCookies: [clearedState],
          };
        },
      }),
    });
    await running.browser.signIn(PERSON);
    const token = running.browser.sessionToken();
    expect(
      (await running.browser.get("/sign-in/google/callback?state=forged&code=code")).status,
    ).toBe(401);
    expect(running.browser.sessionToken()).toBe(token);
    expect((await running.browser.get("/settings")).status).toBe(200);
  });

  it("does not exchange a Google code on a HEAD or page-data request", async () => {
    const running = await started({
      identity: (real) => ({
        ...real,
        googleEnabled: true,
        async finishGoogle() {
          throw new Error("a prefetch must never exchange this code");
        },
      }),
    });
    const head = await fetch(`${running.url}/sign-in/google/callback?state=held&code=code`, {
      method: "HEAD",
      redirect: "manual",
    });
    const data = await running.browser.get("/sign-in/google/callback.data?state=held&code=code");

    expect(head.status).toBe(405);
    expect(data.status).toBe(405);
    expect(head.headers.getSetCookie()).toStrictEqual([]);
    expect(data.headers.getSetCookie()).toStrictEqual([]);
    expect(running.rows.dashboard_sessions).toStrictEqual([]);
  });
});

describe("the gate", () => {
  it("lets a visitor with no session reach only the sign-in pages, the health probe and the shop's callback and return", async () => {
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
      [
        "the route table the pages' script asks for",
        () => stranger.get("/dashboard/__manifest?paths=%2Fdashboard%2Fcards&version=any"),
      ],
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
    for (const page of PAGES_IN_FRONT_OF_THE_GATE) {
      const answer = await stranger.get(`/dashboard${page}`);
      expect(gate(answer), page).toBe(false);
      if (page === "/sign-in/google/callback") {
        // Google is not configured here; its return still offers the email
        // door rather than sending the visitor through the account gate.
        expect(answer.status).toBe(503);
        expect(formTo(answer.html, "post", "/dashboard/sign-in")).toBeDefined();
      } else {
        expect(answer.status, page).toBeLessThan(500);
      }
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

describe("the address a press posts to, opened as a page", () => {
  it("leads to the page the press's form lives on, never to one that is not there", async () => {
    // Opened again from history or the address bar, the address would
    // otherwise be a dead end, and a page drawn there without a press would
    // say nothing happened.
    const { browser } = await started({ wooShops: memoryWooShops() });
    await browser.signIn();

    for (const [path, page] of [
      ["/settings/site", "/settings"],
      ["/settings/sign-out-others", "/settings"],
      ["/settings/payout-wallet", "/settings"],
      ["/settings/payout-wallet/cancel", "/settings"],
      ["/keys/some-key/disable", "/keys"],
      ["/woocommerce/connect", "/woocommerce"],
      ["/woocommerce/import", "/woocommerce"],
      ["/woocommerce/switch", "/woocommerce"],
      ["/woocommerce/disconnect", "/woocommerce"],
      ["/sign-out", "/"],
    ] as const) {
      const read = await browser.get(path);
      expect({ status: read.status, to: read.to }, path).toStrictEqual({ status: 303, to: page });
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
    expect(text).toMatch(
      /every card you publish is refused, until you choose the name buyers see/i,
    );
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

  it("marks every refused box on the settings as refused, with the refusal read out with it", async () => {
    // The same state as a refused name where the account began: the box
    // outlined, named invalid, and described by the sentence that refused it.
    const running = await started();
    await running.browser.signIn();

    for (const [path, box, value] of [
      ["/settings", "seller_name", "<b>Shop</b>"],
      ["/settings/site", "seller_site", "https://brightdataplans.example/contact"],
      ["/settings/payout-wallet", "payout_wallet", "0x123"],
    ] as const) {
      const answered = await running.browser.post(path, { [box]: value });

      expect(answered.status, path).toBe(400);
      const input = new RegExp(`<input[^>]*id="${box}"[^>]*>`).exec(answered.html)?.[0] ?? "";
      expect(input, path).toContain('aria-invalid="true"');
      const line = /aria-describedby="([^"]+)"/.exec(input)?.[1] ?? "(none)";
      const said = new RegExp(`id="${line}"[^>]*>([^<]*)<`).exec(answered.html)?.[1] ?? "";
      expect(said, path).toMatch(/not saved|refused|printable|address|Use/i);
      // A browser opening the refused page puts the cursor in the box.
      expect(input, path).toContain("autofocus");
    }
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

  it("leads the wallet form's address to the settings at once, even while the gateway does not answer", async () => {
    // Nothing on the way to the page asks the gateway, so a gateway that has
    // stopped answering does not hold up the way there.
    const running = await started();
    await running.browser.signIn();
    running.silenceGateway();

    const answered = await Promise.race([
      running.browser.get("/settings/payout-wallet"),
      new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 5_000)),
    ]);

    expect(answered).not.toBe("still waiting");
    expect((answered as Visit).status).toBe(303);
    expect((answered as Visit).to).toBe("/settings");
  });

  it("serves the settings' data at a press's address, which the page drawn there asks for when the browser comes back to it", async () => {
    // A page answered to a press is a page of the application; going back to
    // it from another screen asks for its data at its own address.
    const { browser } = await started();
    await browser.signIn();

    for (const path of [
      "/settings/site",
      "/settings/sign-out-others",
      "/settings/payout-wallet/cancel",
    ]) {
      const data = await browser.get(`${path}.data`);
      expect(data.status, path).toBe(200);
      expect(data.html, path).toContain(PERSON);
      expect(readable(data.html), path).not.toContain("There is no such page");
    }
  });

  it("never lets a browser keep the settings' data, so the wallet shown is the one the gateway holds now", async () => {
    // A press there loads a whole page at its own address, which drops nothing
    // a browser kept for the settings; kept, a waiting change could be missing
    // from the screen whose showing it is what makes it take effect.
    const { browser } = await started();
    await browser.signIn();

    for (const path of ["/settings", "/settings/sign-out-others", "/settings/payout-wallet"]) {
      const data = await browser.get(`${path}.data`);
      expect(data.headers.get("cache-control"), path).toBe("private, no-store");
    }
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

describe("the wallet a merchant's share is paid out to", () => {
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

  it("shows, once saved, the payout contract recorded for it and the whole transaction that pays it out", async () => {
    const running = await started({
      dashboard: { FACILITATOR_URL: "https://x402.org/facilitator" },
    });
    await running.browser.signIn();

    const saved = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: AS_A_WALLET_SHOWS_IT,
    });
    const screen = await running.browser.get("/settings");

    expect(saved.status).toBe(303);
    const recorded = await running.harnessed.gateway.payoutSplitsOf(running.harnessed.merchant.id);
    expect(recorded.inForce?.merchantWallet).toBe(AS_A_WALLET_SHOWS_IT);
    const split = recorded.inForce?.address ?? "";
    expect(screen.html.replaceAll(/<[^>]*>/g, "")).toContain(split);
    expect(screen.html).toContain(`href="https://sepolia.basescan.org/address/${split}"`);
    const data = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(screen.html)?.[1];
    expect(data).toBe(
      merchantPayout(
        running.harnessed.runtime.config.payoutSplit,
        recorded.toPayOut,
        running.harnessed.runtime.config.payoutSplitNetworks,
      ).data,
    );
    expect(data).toHaveLength(3_146);
  });

  it("names the commission at the terms the split of the saved wallet was recorded with", async () => {
    // The screen's words are the merchant's consent, and the split is what
    // takes the money: the percentages on the page are the recorded split's.
    const running = await started({
      dashboard: { FACILITATOR_URL: "https://x402.org/facilitator" },
    });
    await running.browser.signIn();
    await running.browser.post("/settings/payout-wallet", { payout_wallet: AS_A_WALLET_SHOWS_IT });

    const screen = await running.browser.get("/settings");

    const { inForce } = await running.harnessed.gateway.payoutSplitsOf(
      running.harnessed.merchant.id,
    );
    if (inForce === null) throw new Error("no split was recorded for the saved wallet");
    const percent = (part: number): string => `${(part / inForce.totalAllocation) * 100}%`;
    const text = readable(screen.html);
    expect(text).toContain(`Agentify keeps ${percent(inForce.commissionAllocation)} of every sale`);
    expect(text).toContain(
      `it pays ${percent(inForce.merchantAllocation)} to the wallet and ${percent(inForce.commissionAllocation)} to Agentify`,
    );
  });

  it("pays out, beside the contract of the wallet saved now, the earlier contract a sale was paid into, each to its own wallet", async () => {
    // A sale paid into the earlier wallet's contract waits there after the
    // change, and pays that wallet, not the new one.
    const running = await started({
      dashboard: { FACILITATOR_URL: "https://x402.org/facilitator" },
    });
    const { harnessed } = running;
    const earlier = (await harnessed.gateway.payoutSplitsOf(harnessed.merchant.id)).inForce;
    const itemId = await publish(running.gateway, roomCard);
    await buyOverHttp(harnessed, running.gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await running.browser.signIn();

    await running.browser.post("/settings/payout-wallet", { payout_wallet: AS_A_WALLET_SHOWS_IT });
    const screen = await running.browser.get("/settings");

    const { inForce: now, toPayOut } = await harnessed.gateway.payoutSplitsOf(
      harnessed.merchant.id,
    );
    expect(now?.merchantWallet).toBe(AS_A_WALLET_SHOWS_IT);
    expect(toPayOut.map((split) => split.address).sort()).toStrictEqual(
      [earlier?.address, now?.address].sort(),
    );
    expect(/<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(screen.html)?.[1]).toBe(
      merchantPayout(
        harnessed.runtime.config.payoutSplit,
        toPayOut,
        harnessed.runtime.config.payoutSplitNetworks,
      ).data,
    );
    const shown = readable(screen.html.replaceAll(/<\/?span[^>]*>/g, ""));
    expect(shown).toContain(`${earlier?.address} pays ${harnessed.merchant.wallet}`);
    expect(shown).toContain(`${now?.address} pays ${AS_A_WALLET_SHOWS_IT}`);
  });

  it("refuses an address a merchant's share could never come back from, says what it is, and saves nothing", async () => {
    const running = await started({
      dashboard: { FACILITATOR_URL: "https://x402.org/facilitator" },
    });
    await running.browser.signIn();
    const network = running.harnessed.runtime.config.payoutSplit;
    const ownSplit =
      (await running.harnessed.gateway.payoutSplitsOf(running.harnessed.merchant.id)).inForce
        ?.address ?? "";
    const before = await paidInto(running);

    for (const [address, said] of [
      [network.commissionWallet, /Agentify's commission wallet/],
      [network.warehouse.toLowerCase(), /0xSplits warehouse/],
      [network.multicall3, /Multicall3/],
      [ownSplit, /one of your own payout contracts, not a wallet/],
      ["0x0000000000000000000000000000000000000000", /the zero address/],
    ] as const) {
      const answered = await running.browser.post("/settings/payout-wallet", {
        payout_wallet: address,
      });

      expect(answered.status, address).toBe(400);
      const text = readable(answered.html);
      expect(text, address).toMatch(said);
      expect(text, address).toMatch(/not saved/i);
      // Given back whole under the box, to be read against the wallet.
      expect(answered.html.replaceAll(/<[^>]*>/g, ""), address).toContain(address);
      expect(await paidInto(running), address).toBe(before);
    }
  });

  it("tells a payout contract of the merchant's own, an earlier wallet's too, from another merchant's, which pays that merchant", async () => {
    // The gateway refuses every recorded split alike. The words differ because
    // a share paid into another merchant's contract becomes that merchant's,
    // and one paid into the merchant's own comes back to them split again.
    const running = await started({
      dashboard: { FACILITATOR_URL: "https://x402.org/facilitator" },
    });
    const { harnessed } = running;
    const network = harnessed.runtime.config.payoutSplit;
    const earlier = (await harnessed.gateway.payoutSplitsOf(harnessed.merchant.id)).inForce;
    const other = await harnessed.gateway.registerMerchant();
    await setPayoutWallet(
      harnessed.runtime.store,
      network,
      other,
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      harnessed.runtime.clock(),
    );
    const theirs = (await harnessed.gateway.payoutSplitsOf(other)).inForce;
    await running.browser.signIn();
    // The test channel applies a change at once, so the first wallet's
    // contract is now neither in force nor paid into.
    await running.browser.post("/settings/payout-wallet", { payout_wallet: AS_A_WALLET_SHOWS_IT });
    const said = async (address: string | undefined): Promise<string> =>
      readable(
        (await running.browser.post("/settings/payout-wallet", { payout_wallet: address ?? "" }))
          .html,
      );

    const ofAnEarlierWallet = await said(earlier?.address);
    const ofAnotherMerchant = await said(theirs?.address);

    expect(ofAnEarlierWallet).toMatch(/one of your own payout contracts, not a wallet/);
    expect(ofAnEarlierWallet).not.toMatch(/another merchant/);
    expect(ofAnotherMerchant).toMatch(/another merchant's payout contract, not a wallet/);
    expect(ofAnotherMerchant).toMatch(/go to that merchant/);
    expect(ofAnotherMerchant).not.toMatch(/your own/);
    expect(await paidInto(running)).toBe(AS_A_WALLET_SHOWS_IT);
  });

  it("draws the rest of Settings, and no transaction, where the payout cannot be built", async () => {
    // A wallet saved before the rule existed, written straight into the store:
    // its split pays Multicall3, a payout over it would hand the share to
    // whoever calls Multicall3 next, and the builder refuses it. The merchant
    // still needs the page, the control that signs every other device out and
    // the box that replaces the wallet among it.
    const running = await started({
      dashboard: { FACILITATOR_URL: "https://x402.org/facilitator" },
    });
    const { harnessed } = running;
    const network = harnessed.runtime.config.payoutSplit;
    await setPayoutWallet(
      harnessed.runtime.store,
      network,
      harnessed.merchant.id,
      network.multicall3,
      harnessed.runtime.clock(),
    );
    await running.browser.signIn();

    const screen = await running.browser.get("/settings");

    expect(screen.status).toBe(200);
    expect(screen.html).not.toContain("<textarea");
    const text = readable(screen.html);
    expect(text).toMatch(/get your payout/i);
    expect(text).toMatch(/could not build/i);
    expect(text).toContain(SIGN_OUT_EVERY_OTHER_DEVICE);
    expect(screen.html).toContain('name="payout_wallet"');
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

    for (const path of ALL_SECTIONS) {
      const screen = await running.browser.get(path);
      const text = readable(screen.html);
      expect(screen.status, path).toBe(200);
      expect(text, path).toMatch(
        /every card you publish is refused, until you choose the name buyers see/i,
      );
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

    for (const path of ALL_SECTIONS) {
      const text = readable((await running.browser.get(path)).html);
      expect(text, path).not.toMatch(
        /every card you publish is refused, until you choose the name buyers see/i,
      );
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
    expect(text).toMatch(
      /every card you publish is refused, until you choose the name buyers see/i,
    );
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
    // a working gateway. It is the copy button's, and its title says it.
    const running = await started({ dashboard: { PUBLIC_BASE_URL: "https://shop.example.com" } });
    const itemId = await publish(running.gateway, roomCard);
    await running.browser.signIn();

    const screen = await running.browser.get("/cards");
    const shown =
      /title="Copy the purchase address: https:\/\/shop\.example\.com(\/x402\/[^"]+?\/purchase)"/.exec(
        screen.html,
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
    expect(text).toContain("Immediate");
    expect(text).toContain("eSIM Europe, 5 GB for 30 days");
    expect(text).toContain("8.00 USD");
    expect(text).toContain("Later, within 4 hours");
    expect(text).toContain("80.00 USD On the card since");
    expect(text).toContain("On sale");
  });

  it("puts the switch for all selling at the end of the title bar, over the page", async () => {
    // A merchant on a phone who has to stop selling reaches the switch
    // without scrolling past every card first.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);

    const html = (await browser.signIn()).html;
    const title = html.indexOf('class="top-title"');
    const control = html.indexOf(`action="${STOP_SELLING}"`);

    expect(title).toBeGreaterThan(-1);
    expect(control).toBeGreaterThan(title);
    expect(control).toBeLessThan(html.indexOf('class="app-content"'));
  });

  it("answers a search in the address with the cards it finds, and says what found none", async () => {
    // A GET the loader answers, so the search works with no script on the page.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await publish(gateway, esimCard);
    await browser.signIn();

    const found = readable((await browser.get("/cards?q=esim")).html);
    const none = readable((await browser.get("/cards?q=sofa")).html);

    expect(found).toContain("eSIM Europe, 5 GB for 30 days");
    expect(found).not.toContain("A room for the night");
    expect(none).toContain("No card matches “sofa”.");
    expect(none).not.toContain("haven't published any cards");
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
    expect(text).toContain("Later, within 1 hour");
  });

  it("says so plainly when a merchant has published nothing", async () => {
    const { browser } = await started();

    const screen = await browser.signIn();
    const text = readable(screen.html);

    expect(text).toContain("haven't published any cards yet");
    expect(screen.html).toContain('href="/docs/quickstart"');
  });

  it("says an empty catalogue in the same sentence whatever the account lacks, which the banner says", async () => {
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    const html = (await running.browser.get("/cards")).html;
    const banner = html.indexOf('class="account-banner"');
    const underIt = readable(html.slice(html.indexOf("</section>", banner)));

    expect(reasonsIn(html)).toContain("no_seller_name");
    expect(underIt).toContain("haven't published any cards yet");
    expect(underIt).not.toMatch(/seller name|choose/i);
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

    const paused = await browser.post(switchOf(room, "pause"));
    const text = readable((await browser.get("/cards")).html);

    expect(paused.to).toBe("/cards");
    expect(text).toContain("Paused by you");
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
    await browser.post(switchOf(itemId, "pause"));

    await browser.post(switchOf(itemId, "resume"));

    expect(await purchasable(gateway, itemId)).toBe(true);
    expect(readable((await browser.get("/cards")).html)).toContain("Pause");
  });

  it("stops all selling from one control, and starts it again", async () => {
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();

    await browser.post(STOP_SELLING);
    const stopped = (await browser.get("/cards")).html;

    expect(reasonsIn(stopped)).toStrictEqual(["paused"]);
    expect(readable(stopped)).toContain("Resume all sales");
    expect(await purchasable(gateway, itemId)).toBe(false);

    await browser.post(START_SELLING);
    const reopened = (await browser.get("/cards")).html;

    expect(await purchasable(gateway, itemId)).toBe(true);
    expect(readable(reopened)).toContain("Pause all sales");
    expect(reasonsIn(reopened)).toStrictEqual([]);
  });

  it("does not promise a merchant that the orders they accepted get fulfilled", async () => {
    // On the SDK path the merchant's own code fulfils, and an accepted order
    // nobody delivers ends owing a refund; told a pause leaves orders
    // "fulfilled", a merchant might switch that code off.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    expect(readable((await browser.get("/cards")).html)).not.toMatch(/fulfil/i);
    await browser.post(STOP_SELLING);
    expect(readable((await browser.get("/cards")).html)).not.toMatch(/fulfil/i);
  });

  it("says once, over the cards, which switch holds them, and keeps each card's own switch", async () => {
    // With everything stopped the banner says which switch holds the cards
    // and a card's row says only that it is off sale. Its own switch stays:
    // a card paused now stays paused when all sales resume, and a Resume
    // pressed by mistake can be taken back before they do.
    const { browser, gateway } = await started();
    const room = await publish(gateway, roomCard);
    await browser.signIn();

    await browser.post(STOP_SELLING);
    const html = (await browser.get("/cards")).html;
    const [row = ""] = rowsIn(html);
    const [own] = cardSwitchesIn(row);
    if (own === undefined) throw new Error("the card drawn under a pause has no switch");
    await browser.post(own.action, Object.fromEntries(own.fields));
    await browser.post(START_SELLING);

    expect(reasonsIn(html)).toStrictEqual(["paused"]);
    expect(readable(row)).toContain("Off sale");
    expect(readable(row)).not.toMatch(/selling|sales/i);
    expect(own.presses[0]?.label).toBe("Pause");
    expect(await purchasable(gateway, room)).toBe(false);
  });

  it("leaves a card paused when it is published again", async () => {
    // A merchant editing a price is not asking for a paused product to go back
    // on sale.
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();
    await browser.post(switchOf(itemId, "pause"));

    await publish(gateway, { ...roomCard, price: { amount: "90.00", currency: "USD" } });
    const text = readable((await browser.get("/cards")).html);

    expect(text).toContain("90.00 USD");
    expect(text).toContain("Paused by you");
    expect(await purchasable(gateway, itemId)).toBe(false);
  });

  it("answers a switch pressed by the page's script inside the application, which reads the cards again", async () => {
    // A whole page load after every press would cost the merchant the page
    // they were reading; inside the application the switch's own answer leads
    // back to the cards, and the cards are read again with the press in them.
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();
    const drawn = formsIn((await browser.get("/cards")).html).find(
      ({ method, action }) => method === "post" && action.includes(encodeURIComponent(itemId)),
    );
    if (drawn === undefined) throw new Error("the cards draw no switch for the card");
    // The address the script posts a form to: the form's own, as data.
    const [path = "", query = ""] = drawn.action.split("?");

    const pressed = await browser.post(`${path}.data?${query}`, Object.fromEntries(drawn.fields));

    expect(pressed.status).toBe(202);
    expect(pressed.html).toContain('"redirect","/cards"');
    expect(pressed.headers.get("x-remix-reload-document")).toBeNull();
    expect(await purchasable(gateway, itemId)).toBe(false);
    expect(readable((await browser.get("/cards")).html)).toContain("Resume");
  });

  it("leads a press back to the search and the segment it was drawn under, all selling's switch too", async () => {
    // A merchant pausing a card they searched for goes on reading what they
    // searched for, not every card from the first.
    const { browser, gateway } = await started();
    const room = await publish(gateway, roomCard);
    await publish(gateway, esimCard);
    await browser.signIn();
    const html = (await browser.get("/cards?q=room&show=on-sale")).html;
    const forms = formsIn(html).filter(({ method }) => method === "post");
    const pause = forms.find(({ action }) => action.includes(encodeURIComponent(room)));
    const all = forms.find(({ action }) => action === STOP_SELLING);
    if (pause === undefined || all === undefined) throw new Error("the cards draw no switch");

    const paused = await browser.post(pause.action, Object.fromEntries(pause.fields));
    const stopped = await browser.post(all.action, Object.fromEntries(all.fields));

    expect(paused.to).toBe("/cards?q=room&show=on-sale");
    expect(stopped.to).toBe("/cards?q=room&show=on-sale");
    expect(await purchasable(gateway, room)).toBe(false);
  });

  it("reads the place a press carries as the cards' own address is read, the page included", async () => {
    // Read as the loader reads an address, so a field no list draws leads to
    // the default rather than to an address of its own.
    const { browser, gateway } = await started();
    const room = await publish(gateway, roomCard);
    await browser.signIn();
    await browser.get("/cards");

    const kept = await browser.post(switchOf(room, "pause"), {
      q: "room",
      show: "off-sale",
      page: "3",
    });
    const unknown = await browser.post(switchOf(room, "resume"), {
      q: " room ",
      show: "every",
      page: "-1",
    });
    // A search in another script goes back as a browser writes it, since a
    // header carries no letter outside Latin-1.
    const written = await browser.post(switchOf(room, "pause"), { q: "кофе" });
    await browser.post(switchOf(room, "resume"));

    expect(kept.to).toBe("/cards?q=room&show=off-sale&page=3");
    expect(unknown.to).toBe("/cards?q=room");
    expect(written.to).toBe(`/cards?q=${encodeURIComponent("кофе")}`);
    expect(await purchasable(gateway, room)).toBe(true);
  });

  it("answers a press from a searched list inside the application, leading back to that list", async () => {
    const { browser, gateway } = await started();
    const room = await publish(gateway, roomCard);
    await browser.signIn();
    const drawn = formsIn((await browser.get("/cards?q=room")).html).find(
      ({ method, action }) => method === "post" && action.includes(encodeURIComponent(room)),
    );
    if (drawn === undefined) throw new Error("the cards draw no switch for the card");
    const [path = "", query = ""] = drawn.action.split("?");

    const pressed = await browser.post(`${path}.data?${query}`, Object.fromEntries(drawn.fields));

    expect(pressed.status).toBe(202);
    expect(pressed.html).toContain('"redirect","/cards?q=room"');
    expect(pressed.headers.get("x-remix-reload-document")).toBeNull();
  });

  it("loads a page whole when a press is answered on another page, which may not be one the script draws", async () => {
    // Only a press answered back on its own page stays inside the
    // application; the seller name is answered on the cards.
    const running = await started();
    await unname(running);
    await running.browser.signIn();
    await running.browser.get("/choose-name");

    const chosen = await running.browser.post("/choose-name.data", { seller_name: "Freeland" });

    expect(chosen.status).toBe(202);
    expect(chosen.headers.get("x-remix-reload-document")).toBe("true");
    expect(await listedAs(running)).toBe("Freeland");
  });

  it("refuses a press that names no one switch, and switches nothing", async () => {
    // A press is the switch its form names. One naming two switches, naming
    // its switch twice, or naming a way no switch has, is refused whole
    // rather than read as whichever part came first.
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();

    for (const query of [
      `?selling=pause&pause=${itemId}`,
      `?pause=${itemId}&pause=${itemId}`,
      "?selling=pause&selling=pause",
      "?selling=stop",
      "?pause=",
      "",
    ]) {
      const answered = await browser.post(`/cards${query}`);
      expect(answered.status, query).toBe(404);
      expect(readable(answered.html), query).toMatch(/no such switch/i);
    }
    expect(await purchasable(gateway, itemId)).toBe(true);
    expect(readable((await browser.get("/cards")).html)).toContain("Pause all sales");
  });
});

describe("a card held off sale by what its merchant lacks", () => {
  // A card nobody paused, of a merchant who is selling, reads paused only
  // because the merchant lacks something the gateway asks of every merchant.
  // The banner over the cards names each thing the gateway finds missing, and
  // nothing else: a reason it did not find would send a merchant looking for
  // something nobody asked of them. The card's own row says it is off sale
  // and offers its own switch, which holds once nothing is missing.
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

  /** The banner's reason for each thing the gateway finds missing. */
  const SAID_AS: Readonly<Record<string, string>> = {
    [MERCHANT_FINDINGS.NO_OPERATOR_APPROVAL]: "not_approved",
    [MERCHANT_FINDINGS.NO_SELLER_NAME]: "no_seller_name",
    [MERCHANT_FINDINGS.NO_PAYOUT_WALLET]: "no_payout_wallet",
  };

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
        const [row = ""] = rowsIn(screen.html);

        expect(screen.status).toBe(200);
        if (door.length === 0) {
          // Nothing stands in the way, so the banner says nothing and the
          // control is the merchant's own switch.
          expect(reasonsIn(screen.html)).toStrictEqual([]);
          expect(cardSwitchesIn(row).map(({ presses }) => presses[0]?.label)).toStrictEqual([
            "Pause",
          ]);
          return;
        }
        expect([...reasonsIn(screen.html)].sort()).toStrictEqual(
          door.map((code) => SAID_AS[code]).sort(),
        );
        expect(readable(row)).toContain("Off sale");
        // What the account lacks is said once, over the cards, not again in
        // every row; the card keeps its own switch, so a card paused now
        // stays paused once nothing is missing.
        expect(readable(row)).not.toMatch(/settings|approv|\bname\b|wallet/i);
        expect(cardSwitchesIn(row).map(({ presses }) => presses[0]?.label)).toStrictEqual([
          "Pause",
        ]);
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

  it("on live, before Agentify approves, says so once on Settings, in the banner", async () => {
    const running = await started({
      gateway: { ...CHANNELS.live, ...LIVE_GATEWAY_ONLY },
      dashboard: CHANNELS.live,
    });
    await running.browser.signIn(FRESH.email);
    expect((await running.browser.makeMerchant()).status).toBe(200);

    const settings = readable((await running.browser.get("/settings")).html);

    expect(settings.split("Not approved for live sales yet")).toHaveLength(2);
    expect(settings).not.toMatch(/has not approved your merchant/);
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

    expect(settings).toMatch(/approved your merchant/);
    expect(settings).not.toMatch(/not approved your merchant/);
    expect(reasonsIn(screen.html)).toStrictEqual([]);
    expect(readable(rowsIn(screen.html)[0] ?? "")).toContain("On sale");
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
    expect(formTo(page, "post", START_SELLING)).toBeUndefined();
    expect(formTo(page, "post", STOP_SELLING)).toBeUndefined();
    expect(text).not.toContain("Resume all sales");
    expect(text).not.toContain("Pause all sales");
    // A departure does not let accepted orders play out; a pause does.
    expect(text).not.toContain("play out as usual");
  });

  it("is offered no switch on a card, not even one they paused before they left", async () => {
    // A card's own switch puts nothing back on sale once its merchant has
    // left, so a Resume beside it would promise what nothing here does.
    const { browser, gateway, harnessed } = await started();
    const room = await publish(gateway, roomCard);
    await publish(gateway, esimCard);
    await browser.signIn();
    await browser.post(switchOf(room, "pause"));
    await harnessed.store.setSelling(harnessed.merchant.id, "departed");

    const page = (await browser.get("/cards")).html;

    expect(reasonsIn(page)).toStrictEqual(["left"]);
    expect(readable(page)).toContain("Paused by you");
    expect(cardSwitchesIn(page)).toStrictEqual([]);
  });

  it("is told what the gateway said, not that the gateway is down", async () => {
    // The gateway answers 409 with a reason; shown as "did not answer", it
    // would send a merchant to check a service that is running.
    const { browser, gateway, harnessed } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    await harnessed.store.setSelling(harnessed.merchant.id, "departed");

    const refused = await browser.post(START_SELLING);

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

    expect(text).toContain("Delivered");
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
    const openOnly = readable((await browser.get("/orders?show=open")).html);

    expect(all).toContain("A room for the night");
    // The sale is over, so it is not in the open list, and the empty list says
    // so rather than looking like a failed load.
    expect(openOnly).toContain("Nothing is open");
  });

  it("finds an order by its ID searched for through the address, and says when none matches", async () => {
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, roomCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const [order] = (
      (await gateway.call("GET", "/v0/orders", { headers: asMerchant })).body as {
        orders: { id: string }[];
      }
    ).orders;
    if (order === undefined) throw new Error("the purchase made no order");
    await browser.signIn();

    const found = readable((await browser.get(`/orders?q=${order.id}`)).html);
    const missed = readable((await browser.get("/orders?q=ord_0000…0000")).html);

    expect(found).toContain("A room for the night");
    expect(found).not.toContain("No order matches");
    expect(missed).toContain("No order matches “ord_0000…0000”.");
    expect(missed).not.toContain("A room for the night");
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
    const openOnly = readable((await browser.get("/orders?show=open")).html);

    expect(all).toContain("In progress");
    expect(openOnly).toContain("Nothing is open");
    expect(openOnly).not.toMatch(/finished/i);
  });

  it("does not tell a merchant nothing is owed while an order is still running", async () => {
    // An order under way may already have taken the buyer's money against goods
    // not yet sent, so nothing on the page says nothing is owed.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, esimCard);
    await buyOverHttp(harnessed, gateway, itemId, { onOrder: () => ({ accepted: {} }) });
    await browser.signIn();

    const text = readable((await browser.get("/orders?show=open")).html);

    expect(text).toContain("In progress");
    expect(text).not.toMatch(/nothing is owed|no order is owed|no refunds are due/i);
  });

  it("says which orders it cannot show at all", async () => {
    // A purchase that closed before any price was named cannot be on this list,
    // and an absence never mentioned is a truncation, so the page says it.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    const text = readable((await browser.get("/orders")).html);

    expect(text).toContain("closed before they had a price are not listed");
    expect(text).toContain("nothing was charged for them");
  });

  it("says there are no orders rather than showing an empty table", async () => {
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    expect(readable((await browser.get("/orders")).html)).toContain("No orders yet");
  });

  it("calls out a paid unfulfilled order", async () => {
    // The one open state that costs the buyer money must be shown, not left
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
        expect(listed.orders.map((order) => order.status)).toContain("unfulfilled");
      },
      { timeout: 2_000, interval: 5 },
    );

    await browser.signIn();
    const text = readable((await browser.get("/orders?show=open")).html);

    expect(text).toContain("Unfulfilled");
    expect(text).toContain("Needs you 1");
    // The whole price, though the split paid the merchant only their share,
    // and said to be a test purchase's, as every sale on this stack is.
    expect(text).toContain("8.00 USD test");
  });

  it("says why an order was unfulfilled without guessing that a window ran out", async () => {
    // An order is unfulfilled too when the merchant refuses one already paid for;
    // a callout that blamed a passed delivery window whatever the cause would
    // send a merchant reconciling it looking for a deadline that never passed.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, esimCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ refused: { code: "out_of_stock", message: "no eSIMs left" } }),
    });

    await browser.signIn();
    const text = readable((await browser.get("/orders?show=open")).html);

    expect(text).toContain("Needs you 1");
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

    const { html } = await browser.get("/orders?show=open");
    const text = readable(html);

    expect(text).toContain("the goods are held");
    // Still open, with nothing owed by the merchant. What can still happen is
    // the portal's to explain, and the page links there. It must never suggest
    // the buyer start again, which would deliver twice.
    expect(text).toContain("The buyer can pay again for this same order");
    expect(text).not.toContain("repeat purchase");
    // Nothing is owed by the merchant, so the order is not counted among
    // those that need them.
    expect(text).toContain("Waiting on the buyer 1");
    expect(text).toContain("Needs you 0");
    expect(html).not.toContain('aria-label="Orders that need you"');
  });
});

describe("the banner about the account", () => {
  it("says the same on every section, all sales paused among it", async () => {
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    await browser.post(STOP_SELLING);

    for (const path of ALL_SECTIONS) {
      expect(readable((await browser.get(path)).html), path).toContain("All sales are paused");
    }
  });

  it("says it could not check the account where a read does not answer, and still draws the page", async () => {
    const { browser, gateway } = await started({
      client: (real) => ({ ...real, standing: async () => lateAnswer(10) }),
    });
    await publish(gateway, roomCard);
    await browser.signIn();

    // The keys read nothing of the merchant's standing themselves, so only the
    // banner's read fails.
    const keys = await browser.get("/keys");

    expect(keys.status).toBe(200);
    expect(readable(keys.html)).toContain("Your account could not be checked");
  });

  it("does not hold a page past its own short deadline where the standing is slow to come", async () => {
    // The gateway itself takes longer than the frame waits; the page is drawn
    // at the frame's two seconds, not at the gateway's ten, and says it could
    // not check.
    const { browser, gateway, harnessed } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    const standingOf = harnessed.gateway.standingOf.bind(harnessed.gateway);
    harnessed.gateway.standingOf = async (merchantId) => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      return await standingOf(merchantId);
    };

    const begun = Date.now();
    const keys = await browser.get("/keys");
    const took = Date.now() - begun;

    expect(keys.status).toBe(200);
    expect(readable(keys.html)).toContain("Your account could not be checked");
    expect(took).toBeLessThan(3_500);
  });

  it("is read beside the page's own data, never after it", async () => {
    // Each read waits until the other has been asked for: read one after the
    // other, the page would come back unanswered.
    const asked = () => {
      let done = () => {};
      const once = new Promise<void>((resolve) => {
        done = resolve;
      });
      const awaited = async () =>
        await Promise.race([
          once.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
        ]);
      return { done, awaited };
    };
    const cardsAsked = asked();
    const standingAsked = asked();
    const { browser, gateway } = await started({
      client: (real) => ({
        ...real,
        cards: async () => {
          cardsAsked.done();
          return (await standingAsked.awaited()) ? await real.cards() : lateAnswer(2_000);
        },
        standing: async () => {
          standingAsked.done();
          return (await cardsAsked.awaited()) ? await real.standing() : lateAnswer(2_000);
        },
      }),
    });
    await publish(gateway, roomCard);

    const cards = await browser.signIn();

    expect(cards.status).toBe(200);
    expect(readable(cards.html)).toContain("A room for the night");
    expect(readable(cards.html)).not.toContain("could not be checked");
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

  it("says on Orders and Receipts about how much of a sale is the merchant's and how much Agentify's", async () => {
    // The sale went into the merchant's payout split, which pays 99.9% to
    // their wallet and 0.1% to Agentify when it is paid out.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, roomCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await browser.signIn();

    const receipts = (await browser.get("/receipts")).html;
    const orders = (await browser.get("/orders")).html;
    const receipt =
      /<div class="cell cell-amount">([\s\S]*?)<\/div><div class="cell cell-state">/.exec(
        receipts,
      )?.[1] ?? "";
    const receiptOpened =
      /<div class="more-body">([\s\S]*?)<\/div><\/details>/.exec(receipts)?.[1] ?? "";
    // An order's wide row says the merchant's share; the row a phone opens
    // says both.
    const order =
      /<div class="cell cell-amount">([\s\S]*?)<\/div><div class="cell cell-state">/.exec(
        orders,
      )?.[1] ?? "";
    const opened = /<div class="more-body">([\s\S]*?)<\/div><\/details>/.exec(orders)?.[1] ?? "";

    expect(readable(receipt)).toBe("80.00 USD test ≈ 79.92 USD to you");
    expect(readable(receiptOpened)).toContain("≈ 79.92 USD to you ≈ 0.08 USD to Agentify");
    expect(readable(order)).toBe("80.00 USD test ≈ 79.92 USD to you");
    expect(readable(opened)).toContain("≈ 79.92 USD to you ≈ 0.08 USD to Agentify");
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

    // The band over every page of the test channel says it, once.
    expect(receipts).toContain(SURFACE_WORDS.test);
    expect(orders).toContain(SURFACE_WORDS.test);
    expect(receipts).not.toContain("Every receipt here is a test purchase");
    expect(orders).not.toContain("Every order here is a test purchase");
    // The mark is on each sum as well, which the band promises.
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
    expect(readable((await browser.get("/orders?show=open")).html)).toContain("8.00 USD");
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
   * What a key's row says in the place its column's head names: the moment
   * it was created, or when it was last called. Found by the place the row
   * gives each, so a change of the columns' order does not move what is read.
   */
  const inColumn = (html: string, keyId: string, header: RegExp): string => {
    const place = header.test("Last call") ? "fact" : header.test("Created") ? "aside" : null;
    if (place === null) throw new Error(`no column of the keys is headed ${header}`);
    const row = (html.match(/<li class="list-row[^"]*">[\s\S]*?<\/li>/g) ?? []).find((one) =>
      one.includes(keyId),
    );
    if (row === undefined) {
      throw new Error(`no row of this list is the key ${keyId}`);
    }
    const cell = new RegExp(`<div class="cell cell-${place}">([\\s\\S]*?)</div>`).exec(row)?.[1];
    return readable(cell ?? "").replace(/^Last call /, "");
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
    // Read where a person reads it: the page's data carries it too, drawn or
    // not.
    expect(readable(issued.html)).toContain(SECRET);
    // Kept by no cache, so nothing can hand the page back later.
    expect(issued.headers.get("cache-control")).toBe("private, no-store");
    expect(readable(issued.html)).toMatch(/only time|once/i);
    expect(readable(issued.html)).toContain("Copy key");

    expect(keys.issued).toStrictEqual(["the second worker"]);
    // Gone from every later page: the list is drawn from documents that carry
    // no secret.
    expect((await browser.get("/keys")).html).not.toContain(SECRET);
  });

  it("hands the secret only to the press that issued it, in an answer no cache keeps", async () => {
    // Where script runs, React Router sends the press as a data request and
    // draws the page from its answer. Whatever a reload, a prefetch, Back or
    // the page itself asks the server for afterwards is answered without it;
    // what the browser does with the press's answer is held where the page
    // runs, in the route's own tests.
    const keys = withKeys();
    const { browser } = await started({ client: keys.client });
    await browser.signIn();
    await browser.get("/keys");

    const pressed = await browser.post("/keys.data", { label: "the second worker" });

    expect(keys.issued).toStrictEqual(["the second worker"]);
    expect(pressed.html).toContain(SECRET);
    expect(pressed.headers.get("cache-control")).toBe("private, no-store");
    for (const asked of [
      "/keys.data",
      `/keys.data?_routes=${encodeURIComponent("routes/gate,routes/keys")}`,
      "/keys",
    ]) {
      expect((await browser.get(asked)).html, asked).not.toContain(SECRET);
    }
    expect(keys.issued).toStrictEqual(["the second worker"]);
  });

  it("never lets a browser keep the list's data, so a key revoked a moment ago never reads as working", async () => {
    // The list is the screen a merchant opens when a key has leaked. A browser
    // keeps a page's data under the address it asked with, and a press posts
    // to another one, so data kept from before a revoke would show the key
    // still working, with its Revoke button.
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    for (const asked of [
      "/keys.data",
      `/keys.data?_routes=${encodeURIComponent("routes/keys")}`,
      `/keys.data?_routes=${encodeURIComponent("routes/gate,routes/keys")}`,
    ]) {
      const data = await browser.get(asked);
      expect(data.status, asked).toBe(200);
      expect(data.html, asked).toContain(NIGHTLY.id);
      expect(data.headers.get("cache-control"), asked).toBe("private, no-store");
    }
  });

  it("shows the secret of the key it issued even when the list cannot be read right after", async () => {
    // A key issued and never seen is one the merchant cannot use and must find
    // and revoke, so nothing read after the issue may stand between the press
    // and the one page that shows the secret.
    const keys = withKeys();
    let issuing = false;
    const { browser } = await started({
      client: (real) => {
        const decorated = keys.client(real);
        return {
          ...decorated,
          keys: async () =>
            issuing
              ? { ok: false, status: 0, why: "the gateway did not answer in time" }
              : await decorated.keys(),
        };
      },
    });
    await browser.signIn();
    await browser.get("/keys");
    issuing = true;

    const issued = await browser.post("/keys", { label: "the second worker" });

    expect(keys.issued).toStrictEqual(["the second worker"]);
    expect(issued.status).toBe(200);
    expect(readable(issued.html)).toContain(SECRET);
    expect(readable(issued.html)).not.toContain("Something went wrong");
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

  it("does nothing for a press sent as React Router's data request from a page drawn for somebody else", async () => {
    // Where script runs the presses go out as data requests, and the gate holds
    // for those as it does for a form the browser posts itself.
    const keys = withKeys();
    const running = await started({ client: keys.client });
    await running.identity.make(OTHER, running.theMerchant);
    await running.browser.signIn();
    const leftOpen = hiddenIn((await running.browser.get("/keys")).html, "/keys");
    await running.browser.post("/sign-out");
    await running.browser.signIn(OTHER);

    for (const [path, form] of [
      ["/keys.data", { ...leftOpen, label: "the second worker" }],
      [`/keys/${NIGHTLY.id}/disable.data`, leftOpen],
      ["/keys.data", { [DRAWN_FOR]: "", label: "the second worker" }],
    ] as const) {
      const pressed = await running.browser.post(path, form);
      expect(pressed.status, path).toBe(409);
      expect(pressed.html, path).not.toContain(SECRET);
    }
    expect(keys.issued).toStrictEqual([]);
    expect(keys.disabled).toStrictEqual([]);
  });

  it("issues, revokes and leads back to the list under the dashboard's mount point", async () => {
    // Deployed under /dashboard, so a form or a redirect written without it
    // reaches an address nothing answers.
    const keys = withKeys();
    const { browser } = await started({ base: "/dashboard", client: keys.client });
    await browser.signIn();

    const list = await browser.get("/dashboard/keys");
    expect(postingFormsIn(list.html).map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        "/dashboard/keys",
        `/dashboard/keys/${NIGHTLY.id}/disable`,
        "/dashboard/sign-out",
      ]),
    );
    const issued = await browser.post("/dashboard/keys", { label: "the second worker" });
    expect(readable(issued.html)).toContain(SECRET);
    expect(issued.html).toContain('href="/dashboard/keys"');
    const revoked = await browser.post(`/dashboard/keys/${NIGHTLY.id}/disable`);
    expect(revoked.to).toBe("/dashboard/keys");
    expect(keys.disabled).toStrictEqual([NIGHTLY.id]);
  });
});

/** The bar at the top of a page, its menu included, as the server sends it. */
const barOf = (html: string): string =>
  /<header class="site-header[^"]*">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";

/** Every link in the markup, as its words and where it leads. */
const waysIn = (html: string): (readonly [string, string])[] =>
  [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map(
    ([, href = "", words = ""]) => [readable(words), href] as const,
  );

/** The public site's sections and the door to the dashboard, as they lead from under its prefix. */
const PUBLIC_WAYS = [
  ["Sell to agents", "/agentic-shop"],
  ["Scanner", "/docs/scanner"],
  ["Methodology", "/docs/scanner/methodology"],
  ["Privacy", "/privacy"],
  ["Dashboard", "/dashboard"],
] as const;

describe("what every screen says about the address", () => {
  it("carries the documentation, the signed-in address and a sign-out in the working header of every page in the frame, and none of the public site's sections or a door to the dashboard", async () => {
    // Somebody working in the dashboard is already inside it, and the public
    // site's pages are the front page's lockup away.
    const { browser } = await started({ base: "/dashboard", wooShops: memoryWooShops() });
    await browser.signIn();

    for (const path of [...ALL_SECTIONS, "/woocommerce", "/nowhere"]) {
      const answered = await browser.get(`/dashboard${path}`);
      // A page showing a person's address is never stored by a shared cache.
      expect(answered.headers.get("cache-control"), path).toBe("private, no-store");
      const bar = barOf(answered.html);
      const ways = waysIn(bar);

      expect(
        ways.filter(([words, href]) =>
          PUBLIC_WAYS.some(([name, to]) => words === name || href === to),
        ),
        path,
      ).toStrictEqual([]);
      expect(ways, path).toContainEqual(["Docs", "/docs/"]);
      expect(ways, path).toContainEqual([PERSON, "/dashboard/settings"]);
      expect(formTo(bar, "post", "/dashboard/sign-out"), path).toBeDefined();
    }
  });

  it("keeps the site header, its sections and its door to the dashboard, over a page outside the frame for somebody signed in", async () => {
    const running = await started({ base: "/dashboard" });
    await running.browser.signIn();
    running.forgetMerchant(PERSON);

    const answered = await running.browser.get("/dashboard/merchant");
    const bar = barOf(answered.html);

    expect(answered.status).toBe(200);
    expect(waysIn(bar)).toEqual(
      expect.arrayContaining(PUBLIC_WAYS.map(([name, to]) => [name, to])),
    );
    expect(readable(bar)).toContain(PERSON);
    expect(formTo(bar, "post", "/dashboard/sign-out")).toBeDefined();
  });

  it("lets only this browser keep a page's data, for the ten seconds a prefetch needs, and per session", async () => {
    // A page's data is fetched while the pointer rests on its link, and a
    // browser hands that answer to the click only while it is fresh; it names
    // the signed-in address, so no shared cache may keep it, and a session
    // signed in afterwards must not be handed it.
    const { browser } = await started();
    await browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts", "/integrations"]) {
      const data = await browser.get(`${path}.data`);
      expect(data.status, path).toBe(200);
      expect(data.html, path).toContain(PERSON);
      expect(data.headers.get("cache-control"), path).toBe("private, max-age=10");
      expect(data.headers.get("vary"), path).toMatch(/cookie/i);
    }
  });

  it("leaves nothing a browser kept of any page to be read after a press, wherever the press was posted", async () => {
    // The data is kept per cookie, and the page's script reads its page again
    // after a press at the very address a prefetch or the press before filled;
    // kept data handed to that read would show the merchant the state before
    // what they just did. Every press therefore gives the browser a new value,
    // and the answer it leaves behind no longer matches.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, roomCard);
    const priced = await harnessed.gateway.beginPurchase(itemId, {});
    if (priced.step !== "pay") throw new Error("the closure order was not priced");
    await browser.signIn();
    const kept = await browser.get("/cards.data");
    expect(kept.headers.get("vary")).toMatch(/cookie/i);

    const presses: [string, () => Promise<Visit>][] = [
      ["a switch sent by the page's script", () => browser.post(`/cards.data?pause=${itemId}`)],
      ["a switch sent as a plain form", () => browser.post(switchOf(itemId, "resume"))],
      ["a press on another page", () => browser.post("/keys", { label: "ci" })],
      ["closing fulfillment", () => browser.post("/orders", { order_id: priced.order.order.id })],
    ];
    const given: string[] = [];
    for (const [name, press] of presses) {
      const answered = await press();
      expect(answered.status, name).toBeLessThan(400);
      const line = answered.headers.getSetCookie().find((one) => one.startsWith(`${PRESSED}=`));
      expect(line, name).toBeDefined();
      // Sent back with every read of the dashboard's data for the rest of the
      // browser's session, on the plain-http origin too.
      const attributes = attributesOf(line ?? "");
      expect(attributes.get("path"), name).toBe("/");
      expect(attributes.has("max-age") || attributes.has("expires"), name).toBe(false);
      expect(attributes.has("secure"), name).toBe(false);
      given.push(line?.split(";")[0] ?? "");
    }

    expect(new Set(given).size).toBe(presses.length);
  });

  it("gives the press's cookie to every page of a dashboard under a prefix", async () => {
    const running = await started({ base: "/dashboard" });
    await running.browser.signIn();

    const answered = await running.browser.post("/dashboard/cards?selling=pause");

    expect(answered.status).toBe(303);
    const line = answered.headers.getSetCookie().find((one) => one.startsWith(`${PRESSED}=`));
    expect(attributesOf(line ?? "").get("path")).toBe("/dashboard");
  });

  it("marks the press's cookie Secure wherever the session's is", async () => {
    // Behind https the session cookie is Secure, and the press's goes the same
    // way rather than being the one cookie of the dashboard's sent in clear.
    const running = await started({ base: "/dashboard", dashboard: { COOKIE_SECURE: "true" } });
    await running.browser.signIn();

    const answered = await running.browser.post("/dashboard/cards?selling=pause");

    const line = answered.headers.getSetCookie().find((one) => one.startsWith(`${PRESSED}=`));
    expect(line).toBeDefined();
    expect(attributesOf(line ?? "").has("secure")).toBe(true);
  });

  it("answers a signed-out browser's request for a page's data with the sign-in, not the data", async () => {
    const { browser } = await started();
    await browser.signIn();
    await browser.post("/sign-out");

    const data = await browser.get("/orders.data");

    expect(data.html).not.toContain(PERSON);
    expect(data.html).toContain("/sign-in");
  });

  it.each([
    ["sandbox", {}],
    ["test", { FACILITATOR_URL: "https://x402.org/facilitator" }],
  ] as const)(
    "says on every screen in the frame that it is the %s stack, and so whether money is real",
    async (mode, dashboard) => {
      // The band is the page's own statement that nothing settles here; a screen
      // drawn without it would read as the live dashboard.
      const running = await started({ dashboard, wooShops: memoryWooShops() });
      await running.browser.signIn();

      for (const path of [
        "/cards",
        "/orders",
        "/receipts",
        "/integrations",
        "/keys",
        "/settings",
        "/woocommerce",
        "/nowhere",
      ]) {
        const answered = await running.browser.get(path);
        expect(answered.html, path).toContain(`${SURFACE_MARKER_ATTRIBUTE}="${mode}"`);
        expect(readable(answered.html), path).toContain(SURFACE_WORDS[mode]);
      }
    },
  );

  it("links the signed-in address to settings without a confirmation control", async () => {
    const { browser } = await started();
    await browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts", "/keys", "/settings"]) {
      const answered = await browser.get(path);
      const link = /<a class="site-who" [^>]*href="\/settings"[^>]*>([^<]*)<\/a>/.exec(
        answered.html,
      );
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
          standing: answer,
          unfulfilledOrders: answer,
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
      const answered = await browser.post(STOP_SELLING, { [DRAWN_FOR]: PERSON });

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
    // Said once, in the bar, as every screen's title is.
    expect(answered.html.match(/<h1\b/g)).toHaveLength(1);
    expect(answered.html).toMatch(/<a [^>]*href="\/cards"[^>]*>Back to the dashboard<\/a>/);
    const bar = barOf(answered.html);
    expect(readable(bar)).toContain(PERSON);
    expect(formTo(bar, "post", "/sign-out")).toBeDefined();
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

    const forged = await browser.from("https://evil.example.com").post(STOP_SELLING);

    expect(forged.status).toBe(403);
    expect(await purchasable(gateway, itemId)).toBe(true);
  });

  it("lets a merchant in whatever the terminator in front of it says about the scheme", async () => {
    // A scheme taken from `X-Forwarded-Proto` would let whatever is in front
    // decide whether a merchant can sign in: where that header disagrees with
    // the browser, every form post, sign-in included, would be refused. The
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
    // one means the merchant should act.
    const { browser, gateway, silenceGateway } = await started({ answerWithinMs: 100 });
    await publish(gateway, roomCard);
    await browser.signIn();
    silenceGateway();

    const answered = await browser.get("/cards");

    expect(answered.status).toBe(504);
    const text = readable(answered.html);
    expect(text).toContain("could not be loaded");
    expect(text).not.toContain("Publish a card through the SDK");
  });
});

describe("the page that says a call to the gateway failed", () => {
  it("tries the page the merchant was on again, not another one", async () => {
    // A merchant reading Settings who presses "Try again" wants Settings
    // again; sent to Cards, they lose their place and press their way back.
    const { browser, silenceGateway } = await started({ answerWithinMs: 100 });
    await browser.signIn();
    silenceGateway();

    const failed = await browser.get("/settings");
    const again =
      /<(?:a|form)\b[^>]*\b(?:href|action)="([^"]*)"[^>]*>(?:(?!<\/(?:a|form)>)[\s\S])*?Try again/.exec(
        failed.html,
      )?.[1];

    expect(failed.status).toBe(504);
    expect(again).toMatch(/\/settings$/);
  });

  it("offers the page again, not its data, when the page was opened inside the application", async () => {
    // A click inside the application asks for the page's data alone; the way
    // back the failed page offers is still the page, with what it was asked
    // with, never the address of its data.
    const { browser, silenceGateway } = await started({ answerWithinMs: 100 });
    await browser.signIn();
    silenceGateway();

    const failed = await browser.get(
      "/orders.data?show=open&_routes=routes%2Fgate%2Croutes%2Forders",
    );

    expect(failed.html).toContain('"/orders?show=open"');
    expect(failed.html).not.toContain(".data");
    expect(failed.html).not.toContain("_routes");
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

    const refused = await browser.post(STOP_SELLING);
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
    const refused = await browser.post(STOP_SELLING);

    expect(refused.status).toBe(303);
    expect(refused.to).toBe(UNSAVED);
    const recovery = (await browser.get(refused.to ?? "")).html;
    // Something the person did was not kept, so it is a refusal, in the line
    // the form keeps for one.
    const refusal = readable(/<p class="field-error"[^>]*>[\s\S]*?<\/p>/.exec(recovery)?.[0] ?? "");
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
    const leftOpen = hiddenIn((await running.browser.get("/cards")).html, STOP_SELLING);

    await running.browser.post("/sign-out");
    await running.browser.signIn(OTHER);
    const refused = await running.browser.post(STOP_SELLING, leftOpen);

    expect(refused.status).toBe(409);
    const said = readable(refused.html);
    expect(said).toContain("Nothing was changed");
    // It names who is signed in now, never what the form claimed, and leads to
    // where that person starts.
    expect(said).toContain(OTHER);
    expect(said).not.toContain(PERSON);
    expect(refused.html).toContain('href="/cards"');
    expect(await purchasable(running.gateway, itemId)).toBe(true);

    const drawnNow = hiddenIn((await running.browser.get("/cards")).html, STOP_SELLING);
    expect((await running.browser.post(STOP_SELLING, drawnNow)).status).toBe(303);
    expect(await purchasable(running.gateway, itemId)).toBe(false);
  });

  it("is refused at every address behind the gate, read off the router, as is a form that says nothing", async () => {
    // Held in the gate, so a route added later is held too. A form with no mark
    // at all is refused as well, as a form the marking missed would be.
    const running = await started({ wooShops: memoryWooShops() });
    await publish(running.gateway, roomCard);
    await running.identity.make(OTHER, running.theMerchant);
    await running.browser.signIn();
    const leftOpen = hiddenIn((await running.browser.get("/cards")).html, STOP_SELLING);
    await running.browser.post("/sign-out");
    await running.browser.signIn(OTHER);

    // These answer without a session, and the sign-out signs this browser out
    // whichever page it was pressed on.
    const above = new Set([
      "/sign-in",
      "/sign-in/open",
      "/sign-in/google",
      "/sign-out",
      "/woocommerce/callback",
    ]);
    const behind = (await routesOf(running)).filter(
      ({ method, path }) => method === "post" && !above.has(path),
    );
    expect(behind.length).toBeGreaterThan(10);
    const silently = async (path: string): Promise<Visit> =>
      await running.browser.postRaw(path, "application/x-www-form-urlencoded", "");
    const refusal = await silently(STOP_SELLING);
    expect(refusal.status).toBe(409);
    for (const { path } of behind) {
      for (const answer of [await running.browser.post(path, leftOpen), await silently(path)]) {
        // The same words whichever way the screen is drawn.
        expect({ status: answer.status, said: readable(answer.html) }, path).toStrictEqual({
          status: 409,
          said: readable(refusal.html),
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
      STOP_SELLING,
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
    const refusal = await asDrawn(running.browser, STOP_SELLING, {});
    expect(refusal.status).toBe(409);
    for (const { action, fields } of drawn.filter(({ action }) => action !== "/sign-out")) {
      const answer = await asDrawn(running.browser, action, fields);
      expect(answer.status === 409 && answer.html === refusal.html, action).toBe(false);
    }
    // Still signed in: a form that ended the session would turn every later
    // answer into the sign-in.
    expect((await running.browser.get("/cards")).status).toBe(200);

    const freshRefusal = await asDrawn(fresh, STOP_SELLING, {});
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

describe("a list, when it could not be read", () => {
  /** The page's own part: the sections beside it are left out. */
  const mainOf = (html: string): string => /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";
  const waysOnIn = (html: string): readonly string[] =>
    [...mainOf(html).matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((link) =>
      (link[1] ?? "").replaceAll("&amp;", "&"),
    );
  const quietly = async <T>(during: () => Promise<T>): Promise<T> => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      return await during();
    } finally {
      error.mockRestore();
    }
  };
  // Each screen at an address it was asked with, and the read it cannot do
  // without.
  const LISTS = [
    ["/orders?show=open", "orders"],
    ["/cards?q=room", "cards"],
    ["/receipts", "receipts"],
    ["/keys", "keys"],
  ] as const;

  it.each(LISTS)(
    "%s says a failed read changed nothing, beside the dashboard's sections, and offers the same page again",
    async (path, read) => {
      // A read changes nothing, so the merchant has nothing to check before
      // going on, and the way on is the page they asked for.
      let breaking = false;
      const { browser } = await started({
        client: (real) => ({
          ...real,
          [read]: async (...asked: unknown[]) => {
            if (breaking) throw new Error("the read failed");
            return await (real[read] as (...given: unknown[]) => Promise<unknown>)(...asked);
          },
        }),
      });
      await browser.signIn();
      breaking = true;

      const failed = await quietly(async () => await browser.get(path));

      expect(failed.status).toBe(500);
      expect(failed.html).toContain('aria-label="Dashboard sections"');
      expect(waysOnIn(failed.html)).toStrictEqual([path]);
      expect(readable(mainOf(failed.html))).toMatch(/changed nothing/i);
      expect(readable(failed.html)).not.toMatch(/went through/i);
    },
  );

  it.each(LISTS)("%s says the same of a read Agentify did not answer", async (path) => {
    const { browser, silenceGateway } = await started({ answerWithinMs: 100 });
    await browser.signIn();
    silenceGateway();

    const failed = await quietly(async () => await browser.get(path));

    expect(failed.status).toBe(504);
    expect(failed.html).toContain('aria-label="Dashboard sections"');
    expect(waysOnIn(failed.html)).toStrictEqual([path]);
    expect(readable(mainOf(failed.html))).toMatch(/changed nothing/i);
    expect(readable(failed.html)).not.toMatch(/may or may not have been done/i);
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

  it("answers on the dashboard's own page, which says to look before pressing again and leads on", async () => {
    // A press can fail after its work was done, so the page cannot say
    // whether it went through; a bare line would leave the person with no
    // way on and nothing to tell them what to check.
    const { browser } = await started({
      registrar: {
        register: async () => {
          throw new Error("the answer was not a document this contract knows");
        },
      },
    });
    await browser.signIn(FRESH.email);

    const answered = await said(async () => {
      const failed = await browser.makeMerchant();
      expect(failed.status).toBe(500);
      expect(readable(failed.html)).toContain(
        "Check the page you were on before deciding whether it went through.",
      );
      expect(failed.html).toMatch(/<a [^>]*href="\/cards"[^>]*>Back to Cards<\/a>/);
    });

    expect(answered).toMatch(/request failed/i);
  });

  it("answers every press inside the dashboard that fails on the dashboard's page saying so", async () => {
    // Whichever press it was, the merchant learns that something broke and to
    // look before pressing again, on a page with a way on; a bare line of text
    // gives them neither.
    const broken = (): never => {
      throw new Error("the answer was not a document this contract knows");
    };
    // Broken once the person is in, since signing in reads the merchant too.
    let breaking = false;
    const { browser } = await started({
      client: (real) =>
        new Proxy(real, {
          get: (target, name, receiver) =>
            breaking && typeof Reflect.get(target, name, receiver) === "function"
              ? broken
              : Reflect.get(target, name, receiver),
        }),
      identity: (real) => ({
        ...real,
        signOut: async (cookie) => (breaking ? broken() : await real.signOut(cookie)),
        endOtherSessionsOfPerson: broken,
      }),
    });
    await browser.signIn();
    breaking = true;

    await said(async () => {
      for (const [path, form] of [
        [STOP_SELLING, {}],
        ["/keys", { label: "the second worker" }],
        ["/keys/some-key/disable", {}],
        ["/settings", { seller_name: "Bright Data Plans" }],
        ["/settings/site", { seller_site: "https://example.com" }],
        ["/settings/sign-out-others", {}],
        [
          "/settings/payout-wallet",
          { payout_wallet: "0x1111111111111111111111111111111111111111" },
        ],
        [
          "/settings/payout-wallet/cancel",
          { payout_wallet: "0x1111111111111111111111111111111111111111" },
        ],
        ["/sign-out", {}],
        ["/orders", { order_id: `ord_${"0".repeat(32)}` }],
      ] as const) {
        const pressed = await browser.post(path, form);

        expect({ status: pressed.status, to: pressed.to }, path).toStrictEqual({
          status: 500,
          to: null,
        });
        expect(readable(pressed.html), path).toContain(
          "Something in the dashboard is broken. Check the page you were on before deciding whether it went through.",
        );
      }
    });
  });

  it("answers a sign-in press that fails with the dashboard's page saying so, and logs nothing it carried", async () => {
    // Nothing is drawn after a press that throws but what the press answers,
    // so the page around the answer has to come with it.
    const marker = "token=raw-token session=raw-session";
    const broken = async (): Promise<never> => {
      throw new Error(marker);
    };
    const { browser } = await started({
      identity: (real) => ({ ...real, requestLink: broken, openLink: broken }),
    });

    const written = await said(async () => {
      for (const [path, form] of [
        ["/sign-in", { email: PERSON }],
        ["/sign-in/open", { token: "C".repeat(32) }],
      ] as const) {
        const pressed = await browser.post(path, form);

        expect(pressed.status, path).toBe(500);
        expect(readable(pressed.html), path).toContain(
          "Something in the dashboard is broken. Check the page you were on before deciding whether it went through.",
        );
      }
    });

    expect(written).toMatch(/request failed/i);
    expect(written).not.toContain(marker);
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

describe("a key issued from the dashboard, against the real gateway", () => {
  const LIVE = {
    PAYMENT_NETWORK: "eip155:8453",
    FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  };
  const issuedOn = async (live: boolean): Promise<{ running: Running; issued: Visit }> => {
    const running = await started(
      live
        ? {
            gateway: { ...LIVE, CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: "key-secret" },
            dashboard: LIVE,
          }
        : {},
    );
    await running.browser.signIn();
    await running.browser.get("/keys");
    return { running, issued: await running.browser.post("/keys", { label: "the stock worker" }) };
  };

  it("carries the prefix of the site it works on, which its holder can read", async () => {
    // A key from the other site is refused with a sentence naming the site it
    // works on, so the prefix the merchant copies is the site's own.
    const { issued: onTest } = await issuedOn(false);
    expect(onTest.status).toBe(200);
    expect(readable(onTest.html)).toMatch(/\bcsk_test_\S+/);
    expect(onTest.html).not.toContain("csk_live_");
    await open?.browser.close();

    const { issued: onLive } = await issuedOn(true);
    expect(onLive.status).toBe(200);
    expect(readable(onLive.html)).toMatch(/\bcsk_live_\S+/);
    expect(onLive.html).not.toContain("csk_test_");
  });

  it("is announced on live to the merchant's accounts, naming the address the session is signed in as", async () => {
    const { running, issued } = await issuedOn(true);

    expect(issued.status).toBe(200);
    expect(running.harnessed.announcer.announced).toMatchObject([
      {
        kind: "key_issued",
        merchant_id: running.theMerchant,
        key: { label: "the stock worker" },
        asked_with: { kind: "signed_in", email: PERSON },
      },
    ]);
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

  it("keeps the payout transaction on the contract paid now while a change waits, and moves it once the change applies", async () => {
    const running = await live();
    await running.browser.signIn();
    const merchantId = running.harnessed.merchant.id;
    const { payoutSplit: network, payoutSplitNetworks: networks } =
      running.harnessed.runtime.config;
    const paidNowSplit = (await running.harnessed.gateway.payoutSplitsOf(merchantId)).inForce;
    await aChangeWaits(running);
    const waitingSplit = (await running.harnessed.gateway.payoutSplitsOf(merchantId)).pending;
    const dataOn = (screen: Visit) =>
      /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(screen.html)?.[1];

    const waiting = await running.browser.get("/settings");

    expect(waitingSplit?.merchantWallet).toBe(WAITING);
    const shown = waiting.html.replaceAll(/<[^>]*>/g, "");
    expect(shown.slice(shown.indexOf("Waiting to replace it"))).toContain(waitingSplit?.address);
    expect(dataOn(waiting)).toBe(
      merchantPayout(network, paidNowSplit === null ? [] : [paidNowSplit], networks).data,
    );

    running.harnessed.advance(48 * 60 * 60 * 1_000);
    const applied = await running.browser.get("/settings");

    expect(dataOn(applied)).toBe(
      merchantPayout(network, waitingSplit === null ? [] : [waitingSplit], networks).data,
    );
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
            split: payoutSplitFor(
              running.harnessed.runtime.config.payoutSplit,
              id,
              running.harnessed.merchant.wallet,
            ),
            pending: {
              address: OVERTAKING,
              takesEffectAt: when + 48 * 60 * 60 * 1_000,
              split: payoutSplitFor(running.harnessed.runtime.config.payoutSplit, id, OVERTAKING),
            },
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
        {
          address: PAID,
          split: payoutSplitFor(running.harnessed.runtime.config.payoutSplit, merchant.id, PAID),
          pending: null,
        },
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
    // address under the settings; a key's revoke is an address of the keys,
    // read or pressed.
    const running = await started();

    const wallet = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: "0x1111111111111111111111111111111111111111",
    });
    const read = await running.browser.get("/keys/some-key/disable");
    const disable = await running.browser.post("/keys/some-key/disable");

    expect(wallet.to).toBe("/sign-in?reason=unsaved&destination=settings");
    expect(read.to).toBe("/sign-in?destination=keys");
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

describe("live sales approval in the admin screen", () => {
  const path = "/admin/live-sales";
  const live = {
    PAYMENT_NETWORK: "eip155:8453",
    FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  };
  const asAdmin = async (options: Starting = {}) => {
    const running = await started({
      gateway: { ...live, CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: "key-secret" },
      dashboard: live,
      ...options,
    });
    await running.identity.setOperator(PERSON, true);
    await running.browser.signIn();
    const seller = await running.harnessed.store.addMerchant(
      { id: "mer_approval", name: "Registered merchant" },
      Date.now(),
    );
    if (seller === null) throw new Error("merchant already exists");
    await running.identity.make(OTHER, seller.id);
    await running.harnessed.store.setServiceName(seller.id, "Freeland", Date.now());
    return { ...running, seller: seller.id };
  };
  const confirmation = (seller: string) => ({
    intent: "approve",
    email: OTHER,
    merchant_id: seller,
    confirm: "live-sales",
  });

  it("lets an administrator inspect an existing seller, then grant live approval idempotently", async () => {
    const running = await asAdmin();
    const { browser, seller, harnessed } = running;
    expect((await browser.get(path)).status).toBe(200);
    const preview = await browser.post(path, { intent: "lookup", email: OTHER });
    expect(preview.status).toBe(200);
    expect(readable(preview.html)).toContain("Freeland");
    expect(readable(preview.html)).toContain(seller);
    expect((await harnessed.store.merchantById(seller))?.liveApprovedAt).toBeNull();
    const approved = await browser.post(path, confirmation(seller));
    expect(approved.status).toBe(200);
    const first = (await harnessed.store.merchantById(seller))?.liveApprovedAt;
    expect(first).toBeTypeOf("number");
    harnessed.advance(1_000);
    expect((await browser.post(path, confirmation(seller))).status).toBe(200);
    expect((await harnessed.store.merchantById(seller))?.liveApprovedAt).toBe(first);
    expect((await browser.get(`${path}.data`)).headers.get("cache-control")).toContain("no-store");
  });

  it("does not require the administrator to register as a merchant", async () => {
    const running = await asAdmin();
    running.forgetMerchant(PERSON);
    expect((await running.browser.get(path)).status).toBe(200);
    expect((await running.browser.post(path, confirmation(running.seller))).status).toBe(200);
    expect(
      (await running.harnessed.store.merchantById(running.seller))?.liveApprovedAt,
    ).not.toBeNull();
  });

  it("refuses ordinary accounts and revoked administrators on reads and writes", async () => {
    const running = await asAdmin();
    await running.browser.get(path);
    await running.identity.setOperator(PERSON, false);
    for (const target of [path, `${path}.data`]) {
      expect((await running.browser.get(target)).status).toBe(404);
      expect((await running.browser.post(target, confirmation(running.seller))).status).toBe(404);
    }
    expect((await running.harnessed.store.merchantById(running.seller))?.liveApprovedAt).toBeNull();
  });

  it("does not grant approval from a test or sandbox screen", async () => {
    const running = await asAdmin({ gateway: {}, dashboard: {} });
    expect((await running.browser.get(path)).status).toBe(200);
    const refused = await running.browser.post(path, confirmation(running.seller));
    expect(refused.status).toBe(409);
    expect((await running.harnessed.store.merchantById(running.seller))?.liveApprovedAt).toBeNull();
  });

  it.each(["email", "merchant_id", "confirm", "intent"])(
    "requires %s before granting real sales",
    async (field) => {
      const running = await asAdmin();
      await running.browser.get(path);
      const form: Record<string, string> = confirmation(running.seller);
      delete form[field];
      const refused = await running.browser.post(path, form);
      expect(refused.status).toBe(400);
      // The refusal is said where the screen says refusals, not left to a status code.
      expect(/<p class="problem" role="alert">[^<]+<\/p>/.test(refused.html)).toBe(true);
      expect(
        (await running.harnessed.store.merchantById(running.seller))?.liveApprovedAt,
      ).toBeNull();
    },
  );

  it("refuses a merchant identifier that differs from the account being approved", async () => {
    const running = await asAdmin();
    await running.browser.get(path);
    const refused = await running.browser.post(path, {
      ...confirmation(running.seller),
      merchant_id: running.theMerchant,
    });
    expect(refused.status).toBe(409);
    expect((await running.harnessed.store.merchantById(running.seller))?.liveApprovedAt).toBeNull();
  });

  it("refuses an ambiguous account lookup instead of approving either merchant", async () => {
    const running = await asAdmin({
      approvalDirectory: {
        resolve: async () => [
          { email: OTHER, binding: "bound", merchantId: "mer_approval" },
          { email: OTHER, binding: "bound", merchantId: "another_merchant" },
        ],
      },
    });
    await running.browser.get(path);
    expect((await running.browser.post(path, confirmation(running.seller))).status).toBe(409);
    expect((await running.harnessed.store.merchantById(running.seller))?.liveApprovedAt).toBeNull();
  });

  it("refuses foreign origins and forms drawn for a different account", async () => {
    const running = await asAdmin();
    await running.browser.get(path);
    expect(
      (await running.browser.from("https://other.invalid").post(path, confirmation(running.seller)))
        .status,
    ).toBe(403);
    expect(
      (await running.browser.post(path, { ...confirmation(running.seller), [DRAWN_FOR]: OTHER }))
        .status,
    ).toBe(409);
    expect((await running.harnessed.store.merchantById(running.seller))?.liveApprovedAt).toBeNull();
  });

  it("does not turn a directory outage into an approval or a missing account", async () => {
    const running = await asAdmin({
      approvalDirectory: {
        resolve: async () => {
          throw new Error("database unavailable");
        },
      },
    });
    await running.browser.get(path);
    const result = await running.browser.post(path, confirmation(running.seller));
    expect(result.status).toBe(503);
    expect(readable(result.html)).toMatch(/could not|unavailable/i);
    expect((await running.harnessed.store.merchantById(running.seller))?.liveApprovedAt).toBeNull();
  });
  it("leaves the outcome unknown when the response is lost after the approval commits", async () => {
    const running = await asAdmin();
    await running.browser.get(path);
    const store = running.harnessed.store;
    const grant = store.grantLiveApproval.bind(store);
    vi.spyOn(store, "grantLiveApproval").mockImplementationOnce(async (id, at) => {
      await grant(id, at);
      throw new Error("connection lost after commit");
    });
    const result = await running.browser.post(path, confirmation(running.seller));
    expect(result.status).toBe(503);
    expect(readable(result.html)).toMatch(/outcome is unknown/i);
    const recorded = (await store.merchantById(running.seller))?.liveApprovedAt;
    expect(recorded).toBeTypeOf("number");
    const inspected = await running.browser.post(path, { intent: "lookup", email: OTHER });
    expect(inspected.status).toBe(200);
    expect(readable(inspected.html)).toContain(
      new Date(recorded as number).toISOString().slice(0, 10),
    );
    expect((await running.browser.post(path, confirmation(running.seller))).status).toBe(200);
    expect((await store.merchantById(running.seller))?.liveApprovedAt).toBe(recorded);
  });

  it("does not approve a missing account or an account without a merchant", async () => {
    const running = await asAdmin();
    await running.browser.get(path);
    for (const email of ["absent@example.com", OTHER]) {
      if (email === OTHER) running.forgetMerchant(OTHER);
      expect(
        (await running.browser.post(path, { ...confirmation(running.seller), email })).status,
      ).toBe(409);
      expect(
        (await running.harnessed.store.merchantById(running.seller))?.liveApprovedAt,
      ).toBeNull();
    }
  });

  it("does not accept duplicate confirmation fields", async () => {
    const running = await asAdmin();
    await running.browser.get(path);
    const form = new URLSearchParams({ ...confirmation(running.seller), [DRAWN_FOR]: PERSON });
    form.append("confirm", "live-sales");
    expect(
      (await running.browser.postRaw(path, "application/x-www-form-urlencoded", form.toString()))
        .status,
    ).toBe(400);
    expect((await running.harnessed.store.merchantById(running.seller))?.liveApprovedAt).toBeNull();
  });
});

describe("closing fulfillment from Orders", () => {
  const paid = async (running: Running) => {
    const itemId = await publish(running.gateway, esimCard);
    await buyOverHttp(running.harnessed, running.gateway, itemId, {
      onOrder: () => ({ accepted: {} }),
    });
    const [record] = await running.harnessed.gateway.orders(running.theMerchant, true);
    if (record === undefined) throw new Error("the paid order was not open");
    return record.order.id;
  };

  it("closes through the signed-in merchant and keeps the first message and original payment", async () => {
    const running = await started();
    const id = await paid(running);
    await running.browser.signIn();
    const before = await running.harnessed.store.orderById(id);
    const first = await running.browser.post("/orders", {
      order_id: id,
      message: "A remedy was arranged outside Agentify.",
    });
    expect(first.status).toBe(303);
    const read = await running.browser.get(first.to ?? "");
    expect(readable(read.html)).toContain("Closed by you");
    expect(readable(read.html)).toContain("Payment Paid");
    expect(readable(read.html)).toContain("A remedy was arranged outside Agentify.");
    const after = await running.harnessed.store.orderById(id);
    expect(after?.order.price).toStrictEqual(before?.order.price);
    expect(after?.order.payment).toStrictEqual(before?.order.payment);
    expect(after?.order.merchantClosure?.message).toBe("A remedy was arranged outside Agentify.");
    await running.browser.post("/orders", { order_id: id, message: "A different message." });
    expect((await running.harnessed.store.orderById(id))?.order.merchantClosure).toStrictEqual(
      after?.order.merchantClosure,
    );
    const delivered = await running.harnessed.gateway.deliverOrder(running.theMerchant, id, {
      iccid: "late",
    });
    expect(delivered).toMatchObject({ ok: false, error: { code: "fulfillment_closed" } });
    expect(
      (await running.harnessed.gateway.orders(running.theMerchant, true)).map(
        (record) => record.order.id,
      ),
    ).not.toContain(id);
  });

  it("keeps the line breaks of an explanation, as the buyer's agent reads it", async () => {
    // A browser sends the breaks of a box of several lines as a carriage
    // return and a line feed; plain text breaks a line with a line feed alone.
    const running = await started();
    const itemId = await publish(running.gateway, esimCard);
    const bought = await buyOverHttp(running.harnessed, running.gateway, itemId, {
      onOrder: () => ({ accepted: {} }),
    });
    const { order_id: id, status_url: status } = bought.body as {
      order_id: string;
      status_url: string;
    };
    await running.browser.signIn();

    const closed = await running.browser.post("/orders", {
      order_id: id,
      message: "The delivery deadline was missed.\r\nA refund was sent outside Agentify.",
    });

    expect(closed.status).toBe(303);
    const told = (await running.gateway.call("GET", new URL(status).pathname)).body as {
      merchant_closure?: { message?: string };
    };
    expect(told.merchant_closure?.message).toBe(
      "The delivery deadline was missed.\nA refund was sent outside Agentify.",
    );
    expect((await running.browser.get(closed.to ?? "")).html).toContain(
      "The delivery deadline was missed.\nA refund was sent outside Agentify.",
    );
  });

  it("still refuses a carriage return that is not half of a browser's line break", async () => {
    const running = await started();
    const id = await paid(running);
    await running.browser.signIn();

    const refused = await running.browser.post("/orders", {
      order_id: id,
      message: "The delivery deadline was missed.\rA refund was sent outside Agentify.",
    });

    expect(refused.status).toBe(400);
    expect((await running.harnessed.store.orderById(id))?.order.merchantClosure).toBeUndefined();
  });

  it("keeps a press's answer when the orders cannot be read after it, which it reads once", async () => {
    // A form sent without the page's script is answered in one request, and
    // the press has already said what became of it.
    let pressed = false;
    let readsAfter = 0;
    const running = await started({
      client: (real) => ({
        ...real,
        closeOrder: async () => {
          pressed = true;
          return lateAnswer(10);
        },
        getOrder: async () => lateAnswer(10),
        orders: async (open) => {
          if (pressed) {
            readsAfter += 1;
            if (readsAfter > 2) throw new Error("a second read failed");
          }
          return await real.orders(open);
        },
      }),
    });
    const id = await paid(running);
    await running.browser.signIn();
    const typed = "Payment returned outside Agentify.";

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const posted = await running.browser.post("/orders", { order_id: id, message: typed });
    error.mockRestore();

    expect(posted.status).toBe(503);
    expect(readable(posted.html)).toContain("closure could not be confirmed");
    expect(
      formsIn(posted.html)
        .find((one) => one.fields.get("order_id") === id)
        ?.fields.get("message"),
    ).toBe(typed);
    // The open list and the whole one, read once, by the press's own answer.
    expect(readsAfter).toBe(2);
  });

  it.each([
    ["fails", async (): Promise<never> => Promise.reject(new Error("the list could not be read"))],
    ["is not answered", async () => lateAnswer(10)],
  ] as const)(
    "keeps an unconfirmed closure in the dashboard when every list read after it %s",
    async (_, failed) => {
      // The closure is recorded, but its answer and the read that would
      // confirm it are lost, and none of the lists beside it can be drawn.
      let down = false;
      const running = await started({
        client: (real) => ({
          ...real,
          closeOrder: async (id, request) => {
            await real.closeOrder(id, request);
            down = true;
            return lateAnswer(10);
          },
          getOrder: async (id) => (down ? lateAnswer(10) : await real.getOrder(id)),
          cards: async () => (down ? await failed() : await real.cards()),
          orders: async (open) => (down ? await failed() : await real.orders(open)),
          unfulfilledOrders: async () => (down ? await failed() : await real.unfulfilledOrders()),
          paidIntoSplits: async () => (down ? await failed() : await real.paidIntoSplits()),
        }),
      });
      const id = await paid(running);
      await running.browser.signIn();
      const typed = "Payment returned outside Agentify.";

      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const posted = await running.browser.post("/orders", { order_id: id, message: typed });
      error.mockRestore();

      expect(posted.status).toBe(503);
      expect(posted.html).toContain('aria-label="Dashboard sections"');
      const main = readable(/<main\b[^>]*>([\s\S]*?)<\/main>/.exec(posted.html)?.[1] ?? "");
      expect(main).toContain(CLOSURE_NOTES.unconfirmed);
      expect(main).toContain(typed);
      expect(main).not.toMatch(/changed nothing/i);
      const back = [...posted.html.matchAll(/<a\b[^>]*href="([^"]*)"/g)]
        .map((link) => (link[1] ?? "").replaceAll("&amp;", "&"))
        .find((href) => href.includes(`details=${id}`));
      expect(back).toBeDefined();

      down = false;
      const later = await running.browser.get(back ?? "");
      expect(readable(later.html)).toContain("Closed by you");
    },
  );

  it("says in the dashboard that nothing changed when an explanation is refused and no list can be read", async () => {
    // A refused explanation never reached the gateway, so the press changed
    // nothing, which the page can say even where it cannot draw the lists.
    let down = false;
    const failed = async (): Promise<never> =>
      Promise.reject(new Error("the list could not be read"));
    const running = await started({
      client: (real) => ({
        ...real,
        cards: async () => (down ? await failed() : await real.cards()),
        orders: async (open) => (down ? await failed() : await real.orders(open)),
        unfulfilledOrders: async () => (down ? await failed() : await real.unfulfilledOrders()),
        paidIntoSplits: async () => (down ? await failed() : await real.paidIntoSplits()),
      }),
    });
    const id = await paid(running);
    await running.browser.signIn();
    down = true;

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const typed = "The delivery deadline was missed.\rA refund was sent outside Agentify.";
    const posted = await running.browser.post("/orders", { order_id: id, message: typed });
    error.mockRestore();

    expect(posted.status).toBe(400);
    expect(posted.html).toContain('aria-label="Dashboard sections"');
    const main = readable(/<main\b[^>]*>([\s\S]*?)<\/main>/.exec(posted.html)?.[1] ?? "");
    expect(main).toMatch(/changed nothing/i);
    // The contract's own reason, and the words a list that could not be read
    // is said with on its own page.
    const reason = OrderCloseRequestSchema.safeParse({ message: typed }).error?.issues[0]?.message;
    expect(reason).toBeDefined();
    expect(main).toContain((reason ?? "").replace(/^a closure message /, ""));
    const unreadPage = await quietly(async () => await running.browser.get("/orders"));
    const unreadSaid = /<div class="what">([^<]*)<\/div>/.exec(unreadPage.html)?.[1];
    expect(unreadSaid).toBeDefined();
    expect(main).toContain(readable(unreadSaid ?? ""));
    expect(
      [...posted.html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].some((link) =>
        (link[1] ?? "").includes(`details=${id}`),
      ),
    ).toBe(true);
    expect((await running.harnessed.store.orderById(id))?.order.merchantClosure).toBeUndefined();
  });

  /** The reads the orders page is drawn from, failing while `down` says so. */
  const listsFailing = (real: GatewayClient, down: () => boolean) => {
    const failed = async (): Promise<never> =>
      Promise.reject(new Error("the list could not be read"));
    return {
      cards: async () => (down() ? await failed() : await real.cards()),
      orders: async (open: boolean) => (down() ? await failed() : await real.orders(open)),
      unfulfilledOrders: async () => (down() ? await failed() : await real.unfulfilledOrders()),
      paidIntoSplits: async () => (down() ? await failed() : await real.paidIntoSplits()),
    };
  };
  const mainOf = (html: string): string =>
    readable(/<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "");
  const quietly = async <T>(during: () => Promise<T>): Promise<T> => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      return await during();
    } finally {
      error.mockRestore();
    }
  };

  it("keeps an unconfirmed closure in the dashboard when the read that would confirm it throws", async () => {
    // The closure is recorded, its answer is lost, and then the store goes:
    // the confirming read throws rather than answering late.
    let down = false;
    const running = await started({
      client: (real) => ({
        ...real,
        ...listsFailing(real, () => down),
        closeOrder: async (id, request) => {
          await real.closeOrder(id, request);
          down = true;
          return lateAnswer(10);
        },
        getOrder: async (id) => {
          if (down) throw new Error("the store went away");
          return await real.getOrder(id);
        },
      }),
    });
    const id = await paid(running);
    await running.browser.signIn();
    const typed = "Payment returned outside Agentify.";

    const posted = await quietly(
      async () => await running.browser.post("/orders", { order_id: id, message: typed }),
    );

    expect(posted.status).toBe(503);
    expect(posted.html).toContain('aria-label="Dashboard sections"');
    expect(mainOf(posted.html)).toContain(CLOSURE_NOTES.unconfirmed);
    expect(mainOf(posted.html)).toContain(typed);
  });

  it("does not take a closure from before for a second one whose answer was lost", async () => {
    // An order paid after its first closure is open again and still carries
    // that closure; only the order no longer being open shows a second one.
    let lose = false;
    const running = await started({
      client: (real) => ({
        ...real,
        closeOrder: async (id, request) =>
          lose ? lateAnswer(10) : await real.closeOrder(id, request),
      }),
    });
    const itemId = await publish(running.gateway, esimCard);
    const priced = await running.harnessed.gateway.beginPurchase(itemId, {});
    if (priced.step !== "pay") throw new Error("the order was not priced");
    const id = priced.order.order.id;
    running.harnessed.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await running.harnessed.gateway.payPurchase(id, "PAYMENT", "fp-original");
    await running.browser.signIn();
    await running.browser.post("/orders", { order_id: id, message: "Payment did not arrive." });
    const pending = await running.harnessed.store.orderById(id);
    if (pending?.paymentAttempt === undefined) throw new Error("the payment attempt is missing");
    await running.harnessed.gateway.runner.completePaymentAttempt(
      id,
      pending.paymentAttempt.id,
      { settled: true, transaction: "late-transaction" },
      "facilitator",
    );
    lose = true;

    const again = await running.browser.post("/orders", {
      order_id: id,
      message: "The payment arrived late; it will be returned.",
    });

    expect(again.status).toBe(503);
    expect(mainOf(again.html)).toContain(CLOSURE_NOTES.unconfirmed);
    expect((await running.harnessed.store.orderById(id))?.order.merchantClosure?.message).toBe(
      "Payment did not arrive.",
    );
  });

  it("leads to what was recorded, as a confirmed closure does, when the lists read after a lost answer show the order closed", async () => {
    const running = await started({
      client: (real) => ({
        ...real,
        closeOrder: async (id, request) => {
          await real.closeOrder(id, request);
          return lateAnswer(10);
        },
        getOrder: async () => lateAnswer(10),
      }),
    });
    const id = await paid(running);
    await running.browser.signIn();
    const typed = "Payment returned outside Agentify.";

    const posted = await running.browser.post("/orders", { order_id: id, message: typed });

    // Sent on rather than drawn, so a reload does not repeat the press.
    expect(posted.status).toBe(303);
    const read = await running.browser.get(posted.to ?? "");
    expect(mainOf(read.html)).not.toContain(CLOSURE_NOTES.unconfirmed);
    expect(mainOf(read.html)).toContain(typed);
    expect(formsIn(read.html).some((form) => form.fields.get("order_id") === id)).toBe(false);
  });

  it("keeps a refusal from an order that ended in the dashboard when no list can be read", async () => {
    let down = false;
    const running = await started({
      client: (real) => ({
        ...real,
        ...listsFailing(real, () => down),
        closeOrder: async (id, request) => {
          await real.deliverOrder(id, { iccid: "arrived first" });
          const refused = await real.closeOrder(id, request);
          down = true;
          return refused;
        },
      }),
    });
    const id = await paid(running);
    await running.browser.signIn();
    const typed = "Too late.";

    const posted = await quietly(
      async () => await running.browser.post("/orders", { order_id: id, message: typed }),
    );

    expect(posted.status).toBe(409);
    expect(posted.html).toContain('aria-label="Dashboard sections"');
    expect(mainOf(posted.html)).toContain(CLOSURE_NOTES.ended);
    expect(mainOf(posted.html)).toContain(typed);
  });

  it.each([
    ["throws", async (): Promise<never> => Promise.reject(new Error("the store went away"))],
    ["is not answered", async () => lateAnswer(10)],
  ] as const)(
    "says the gateway's refusal in the dashboard when the read after it %s",
    async (_, unread) => {
      let refusal = "";
      const running = await started({
        client: (real) => ({
          ...real,
          closeOrder: async (id, request) => {
            await real.deliverOrder(id, { iccid: "arrived first" });
            const refused = await real.closeOrder(id, request);
            if (!refused.ok) refusal = refused.why;
            return refused;
          },
          getOrder: async () => await unread(),
        }),
      });
      const id = await paid(running);
      await running.browser.signIn();

      const posted = await quietly(
        async () => await running.browser.post("/orders", { order_id: id, message: "Too late." }),
      );

      expect(posted.status).toBe(409);
      expect(posted.html).toContain('aria-label="Dashboard sections"');
      expect(refusal).not.toBe("");
      expect(mainOf(posted.html)).toContain(refusal.slice(1));
      // No form is drawn for an order that ended, so what was typed is kept
      // beside what became of it.
      expect(mainOf(posted.html)).toContain("Too late.");
    },
  );

  it("says why an explanation was refused on an order a stale page still offered to close", async () => {
    // Closed meanwhile in another tab: no form is left to say the reason
    // under, and a page drawn after a refusal is not taken for a closure.
    const running = await started();
    const id = await paid(running);
    await running.browser.signIn();
    expect((await running.browser.post("/orders", { order_id: id })).status).toBe(303);
    const typed = "The delivery deadline was missed.\rA refund was sent outside Agentify.";

    const posted = await running.browser.post("/orders", { order_id: id, message: typed });

    expect(posted.status).toBe(400);
    const reason = OrderCloseRequestSchema.safeParse({ message: typed }).error?.issues[0]?.message;
    expect(reason).toBeDefined();
    expect(mainOf(posted.html)).toContain((reason ?? "").replace(/^a closure message /, ""));
  });

  it("keeps an unconfirmed closure in the dashboard when the open list cannot be read to confirm it", async () => {
    // The order carries a closure, which says nothing until the open list
    // shows it is no longer open.
    let down = false;
    const running = await started({
      client: (real) => ({
        ...real,
        closeOrder: async (id, request) => {
          await real.closeOrder(id, request);
          down = true;
          return lateAnswer(10);
        },
        orders: async (open) => {
          if (down && open) throw new Error("the open list could not be read");
          return await real.orders(open);
        },
      }),
    });
    const id = await paid(running);
    await running.browser.signIn();

    const posted = await quietly(
      async () => await running.browser.post("/orders", { order_id: id, message: "Returned." }),
    );

    expect(posted.status).toBe(503);
    expect(posted.html).toContain('aria-label="Dashboard sections"');
    expect(mainOf(posted.html)).toContain(CLOSURE_NOTES.unconfirmed);
  });

  it("leads back to the list the closure was pressed on, with the order opened", async () => {
    const running = await started();
    const id = await paid(running);
    await running.browser.signIn();

    const closed = await running.browser.post("/orders", {
      order_id: id,
      show: "needs",
      page: "2",
    });

    expect(closed.status).toBe(303);
    expect(closed.to).toBe(`/orders?show=needs&page=2&details=${id}#details-${id}`);
  });

  it("rereads an unanswered write and shows the recorded closure", async () => {
    const running = await started({
      client: (real) => ({
        ...real,
        closeOrder: async (id, request) => {
          await real.closeOrder(id, request);
          return lateAnswer(10);
        },
      }),
    });
    const id = await paid(running);
    await running.browser.signIn();
    const posted = await running.browser.post("/orders", { order_id: id });
    const read = await running.browser.get(posted.to ?? "");
    expect(readable(read.html)).toContain("Closed by you");
    expect(readable(read.html)).not.toContain("closure could not be confirmed");
  });

  it("keeps an unanswered closure honest when its read also cannot confirm it", async () => {
    const running = await started({
      client: (real) => ({
        ...real,
        closeOrder: async () => lateAnswer(10),
        getOrder: async () => lateAnswer(10),
      }),
    });
    const id = await paid(running);
    await running.browser.signIn();
    const typed = "Payment returned outside Agentify.";
    const posted = await running.browser.post("/orders", { order_id: id, message: typed });
    // The page itself answers, so the note sits by the order's form and what
    // was typed is still in its box; a reload does not repeat the note.
    expect(posted.status).toBe(503);
    expect(readable(posted.html)).toContain("closure could not be confirmed");
    expect(readable(posted.html)).not.toContain("Closed by you");
    const form = formsIn(posted.html).find((one) => one.fields.get("order_id") === id);
    expect(form?.fields.get("message")).toBe(typed);
    expect((await running.harnessed.store.orderById(id))?.order.merchantClosure).toBeUndefined();
  });

  it("brings back an order paid after its closure until the merchant closes it again", async () => {
    const running = await started();
    const itemId = await publish(running.gateway, esimCard);
    const priced = await running.harnessed.gateway.beginPurchase(itemId, {});
    if (priced.step !== "pay") throw new Error("the order was not priced");
    const id = priced.order.order.id;
    running.harnessed.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await running.harnessed.gateway.payPurchase(id, "PAYMENT", "fp-original");
    await running.browser.signIn();
    await running.browser.post("/orders", { order_id: id, message: "Payment did not arrive." });
    const pending = await running.harnessed.store.orderById(id);
    if (pending?.paymentAttempt === undefined) throw new Error("the payment attempt is missing");
    await running.harnessed.gateway.runner.completePaymentAttempt(
      id,
      pending.paymentAttempt.id,
      { settled: true, transaction: "late-transaction" },
      "facilitator",
    );

    const back = await running.browser.get("/orders");
    expect(readable(back.html)).toContain("Needs you 1");
    expect(readable(back.html)).toContain("payment completed after you closed fulfillment");
    expect(formsIn(back.html).some((form) => form.fields.get("order_id") === id)).toBe(true);

    const again = await running.browser.post("/orders", {
      order_id: id,
      message: "The payment arrived late; it will be returned.",
    });
    expect(again.status).toBe(303);
    const after = await running.browser.get("/orders");
    expect(readable(after.html)).toContain("Needs you 0");
    expect(after.html).not.toContain('aria-label="Orders that need you"');
    expect(formsIn(after.html).some((form) => form.fields.get("order_id") === id)).toBe(false);
    expect((await running.harnessed.store.orderById(id))?.order.merchantClosure?.message).toBe(
      "The payment arrived late; it will be returned.",
    );
  });

  it("leads back to the order in its own words when a delivery lands before the closure", async () => {
    const running = await started({
      client: (real) => ({
        ...real,
        closeOrder: async (id, request) => {
          await real.deliverOrder(id, { iccid: "arrived first" });
          return await real.closeOrder(id, request);
        },
      }),
    });
    const id = await paid(running);
    await running.browser.signIn();
    const read = await running.browser.post("/orders", { order_id: id, message: "Too late." });
    expect(read.status).toBe(409);
    const text = readable(read.html);
    expect(text).toContain("Nothing was closed: this order ended before your closure arrived.");
    expect(text).toContain("Delivered");
    expect(formsIn(read.html).some((form) => form.fields.get("order_id") === id)).toBe(false);
    expect((await running.harnessed.store.orderById(id))?.order.merchantClosure).toBeUndefined();
  });

  it("refuses foreign-origin, mismatched-account and unowned order posts", async () => {
    const running = await started();
    const id = await paid(running);
    await running.browser.signIn();
    expect(
      (await running.browser.from("https://elsewhere.example").post("/orders", { order_id: id }))
        .status,
    ).toBe(403);
    expect(
      (
        await running.browser.post("/orders", {
          order_id: id,
          [DRAWN_FOR]: "someoneelse@example.com",
        })
      ).status,
    ).toBe(409);
    const foreign = await running.harnessed.gateway.registerMerchant();
    const foreignClient = gatewayFor(running.harnessed.gateway, {
      merchantId: foreign,
      email: "someoneelse@example.com",
    });
    const attempt = await foreignClient.closeOrder(id, {});
    expect(attempt).toMatchObject({ ok: false, status: 404 });
    expect((await running.harnessed.store.orderById(id))?.order.merchantClosure).toBeUndefined();
  });

  it("says why an explanation was refused under its box and keeps what was typed", async () => {
    const running = await started();
    const id = await paid(running);
    await running.browser.signIn();
    const typed = "A remedy was agreed <b>outside</b> Agentify.";

    const refused = await running.browser.post("/orders", { order_id: id, message: typed });

    expect(refused.status).toBe(400);
    const form = formsIn(refused.html).find((one) => one.fields.get("order_id") === id);
    // Kept in the box, and escaped there like any other text.
    expect(form?.fields.get("message")).toBe(
      "A remedy was agreed &lt;b&gt;outside&lt;/b&gt; Agentify.",
    );
    const box = /<textarea[^>]*name="message"[^>]*>/.exec(refused.html)?.[0] ?? "";
    expect(box).toContain('aria-invalid="true"');
    expect(readable(refused.html)).toContain("Your explanation carries HTML markup");
    expect((await running.harnessed.store.orderById(id))?.order.merchantClosure).toBeUndefined();
  });

  it("refuses a malformed explanation without closing the order", async () => {
    const running = await started();
    const id = await paid(running);
    await running.browser.signIn();
    expect(
      (await running.browser.post("/orders", { order_id: id, message: "x".repeat(2001) })).status,
    ).toBe(400);
    expect((await running.harnessed.store.orderById(id))?.order.merchantClosure).toBeUndefined();
  });
});

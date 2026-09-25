/**
 * The cabinet, driven the way a merchant drives it: over HTTP, against a real
 * gateway.
 *
 * Nothing between the browser and the order machine is stubbed. The gateway on
 * the other end is the real one on in-memory adapters — the same harness its
 * own HTTP tests use — so every screen here is drawn from documents the real
 * API produced, and a cabinet that drifted from the contract fails here rather
 * than in front of a merchant. That is ADR-0005 §3 held by a test: if the
 * cabinet cannot show something, the API is missing it.
 *
 * Signing in is not stubbed either. The component ADR-0009 hands identity to is
 * the real one, doing the real deriving and the real signing; what is swapped
 * for the tests is only where it keeps its rows, which is the component's own
 * memory store rather than Postgres, because `pnpm test` works without a
 * database. `identity.db-test.ts` runs the same flows against a real one, on
 * tables the checked-in migrations built.
 *
 * The assertions are about what a merchant can see and do — a state beside a
 * card, a control that pauses it, a purchase that is refused afterwards. They
 * are deliberately not about markup: a page that changed its class names has
 * not broken a promise to anybody.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import {
  ANNOUNCING,
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
import { keyRenewal } from "./cabinet-key.js";
import { type CabinetConfig, loadConfig } from "./config.js";
import { type Answer, type GatewayClient, gatewayFor, type Registrar } from "./gateway.js";
import {
  type Identity,
  identityFor,
  LINK_MIN_INTERVAL_MS,
  LINK_RATE_WINDOW_MS,
} from "./identity.js";
import type { Handover, Message, Postman } from "./mail.js";
import { buildReportIdentityApp, REPORT_IDENTITY_PATH } from "./report-identity-server.js";
import { buildApp } from "./server.js";
import { readable, waitingButton } from "./testing/html.js";
import { rewindLinkSends } from "./testing/link-sends.js";
import { memoryWooShops, type WooShops } from "./woo-shops.js";

/**
 * The key the gateway harness's own merchant holds, named rather than spelled
 * again. Every call in this file goes to a real gateway, whose door reads the
 * environment off the prefix, so a second copy of the string here would come
 * apart from the harness the first time that prefix changed. Every gateway this
 * file boots is a test one, which is why the environment can be named here.
 */
const KEY = theMerchantKey("test");
const asMerchant = { authorization: `Bearer ${KEY}` };
const PAY_TO = "0x0000000000000000000000000000000000000001";

/** The name the session cookie travels under on the plain-http local origin. */
const COOKIE = "agentify.session_token";
/**
 * The name it travels under wherever the site is served over https.
 *
 * The prefix is a promise the browser keeps rather than one this cabinet makes:
 * a cookie carrying it is refused unless it is Secure, set for the whole origin
 * and names no Domain, so another host under the same registrable domain can
 * neither plant a session here nor overwrite one (ADR-0009 §6).
 */
const SECURE_COOKIE = "__Host-agentify.session_token";
/** Thirty days, the lifetime a session is given from the last visit. */
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const SESSION_ENDED = "/sign-in?reason=session-ended";
/**
 * Where a person who owns no merchant starts: the scanner's answer for their
 * latest report, which sends somebody with no report back to the cabinet
 * (ADR-0026 §1). It is not the cabinet's page, so these tests read the
 * redirect and do not follow it.
 */
const LATEST_REPORT = "/report/latest";
const SESSION_ENDED_UNSAVED = "/sign-in?reason=session-ended-unsaved";

/** The person whose account every test in this file signs in as. */
const PERSON = "dmitry@example.com";
/**
 * A second person with an account on the same cabinet.
 *
 * The fixture for the case nobody plans for: a request can carry a session that
 * belongs to somebody else, and "somebody else" cannot be tested with one
 * account in the store.
 */
const OTHER = "someone@example.com";
/**
 * The code the gateway is told to accept, for the tests that register for real.
 *
 * Almost every test here signs in as an account the harness seeded, whose key
 * is one of the merchant's own — a shape no way in makes, since an account's
 * key comes from the cabinet's own press. The tests about the key a cabinet
 * holds cannot use it: the two calls about that key are refused to any other
 * kind. So they sign in and press against the real gateway, which is where a
 * real cabinet key comes from, and this is what stands in the door.
 */
const INVITATION = "the-invitation-the-gateway-accepts";

/** Somebody registering for themselves, who has no account until they do. */
const FRESH = { email: "fresh-merchant@example.com" };

/**
 * The merchant both of those accounts sign in as.
 *
 * One merchant with two people at it, which is not a shape anything sets up on
 * purpose — it is here because "somebody else's session" cannot be tested with
 * one account, and because the key on both rows is the
 * one the harness seeded, so every screen these tests read is drawn from the
 * real gateway.
 */
const THE_MERCHANT = { id: "mer_the_merchant", key: KEY };

/**
 * The cabinet's identity under test: the real component on its memory store,
 * with the account almost every test signs in as already in it.
 *
 * The rows are handed in rather than kept inside so that a test can put an
 * account into a state no door produces, and can read what the component
 * actually wrote. The few tests that need another person make that person
 * themselves instead of making every test derive three passwords.
 */
const withIdentity = async (
  config: CabinetConfig,
  postman: Postman,
): Promise<{
  identity: Identity;
  forgetMerchant: (email: string) => void;
  rows: Record<string, Record<string, unknown>[]>;
}> => {
  const rows: Record<string, Record<string, unknown>[]> = {
    cabinet_accounts: [],
    cabinet_sessions: [],
    cabinet_credentials: [],
    cabinet_verifications: [],
    cabinet_link_sends: [],
  };
  const identity = identityFor(config, { rows, postman });
  await identity.make(PERSON, THE_MERCHANT);
  const forgetMerchant = (email: string): void => {
    for (const row of rows.cabinet_accounts ?? []) {
      if (row.email === email) {
        row.merchantId = null;
        row.merchantKey = null;
      }
    }
  };
  return { identity, forgetMerchant, rows };
};

/** Session rows exposed only by the deterministic memory adapter. */
const sessionRows = (): Record<string, unknown>[] => open?.rows.cabinet_sessions ?? [];

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

/** One answer from the cabinet, as a browser would have it. */
interface Visit {
  readonly status: number;
  readonly headers: Headers;
  readonly html: string;
  /** Where a redirect points, or null where the answer is a page. */
  readonly to: string | null;
}

interface Browser {
  get(path: string): Promise<Visit>;
  post(path: string, form?: Record<string, string>): Promise<Visit>;
  /** A post of a body this cabinet's forms never send, as a scanner would. */
  postRaw(path: string, contentType: string, body: string): Promise<Visit>;
  /**
   * Signs in as a person and follows the redirect, the way a browser does.
   * The account every test in this file starts with is the default.
   *
   * The minute the door keeps between two links to one address is moved out of
   * the way first, so that a test signing a second device in — or signing the
   * same person in twice — gets a link rather than the cooldown screen. The
   * tests about the cooldown itself ask for their links directly.
   */
  signIn(email?: string): Promise<Visit>;
  /**
   * Presses the one control a signed-in person without a merchant is offered,
   * and follows where it leads (ADR-0026 §4).
   */
  makeMerchant(): Promise<Visit>;
  /** The identifier in this browser's session cookie, or null. */
  sessionToken(): string | null;
  /** The same browser sending one exact cookie header instead of its jar. */
  withRawCookie(cookie: string): Browser;
  /** The same browser claiming its page came from somewhere else. */
  from(origin: string): Browser;
  /**
   * The same browser behind something that adds headers of its own.
   *
   * A terminator in front of the cabinet is not a browser and cannot be driven
   * as one, so the headers it would add are put on the request here.
   */
  sending(headers: Record<string, string>): Browser;
  close(): Promise<void>;
}

interface Running {
  readonly harnessed: Harness;
  readonly gateway: Served;
  readonly browser: Browser;
  /**
   * Where the cabinet under test is listening.
   *
   * A test that has to name an origin needs the host and the port the cabinet
   * is actually answering on, because an origin the browser claims is compared
   * against the `Host` header of the same request.
   */
  readonly url: string;
  /** The component the cabinet under test signs people in against. */
  readonly identity: Identity;
  /**
   * Empties the two merchant columns on one account.
   *
   * What it makes is the row on the deployed server: an account written before
   * an account named the merchant it signs in for. No door in the cabinet
   * produces one, because every one of them writes the merchant in the same act
   * that writes the account.
   */
  readonly forgetMerchant: (email: string) => void;
  /** The rows the component wrote, for the two assertions that read one. */
  readonly rows: Record<string, Record<string, unknown>[]>;
  /**
   * The payout address the stand-in for that route is holding.
   *
   * The route itself is being added on another branch, so what this cabinet
   * talks to for it is not the real gateway. What these tests can hold is the
   * cabinet's half — that an address a merchant typed was sent, and that one
   * refused on the page never was. What actually goes on the wire is held in
   * `gateway.test.ts` against a server that records it.
   */
  /** Every message the cabinet handed over while this test ran. */
  readonly mails: Message[];
  /** A second browser on the same cabinet, for two people or two devices. */
  another(): Promise<Browser>;
  /** Takes the gateway away, once. One test does this on purpose. */
  stopGateway(): Promise<void>;
}

let open: Running | null = null;

/** What one test asks of the cabinet it stands up. */
interface Starting {
  readonly base?: string;
  readonly gateway?: Record<string, string>;
  readonly cabinet?: Record<string, string>;
  /**
   * How the route that makes a merchant answers.
   *
   * Stubbed rather than real for the tests that are about what the cabinet does
   * with an answer of each shape. Left alone, the real registrar goes to the
   * real gateway — which is where a real key made for a cabinet comes from, and
   * the only way to get an account row that holds one.
   */
  readonly registrar?: Registrar;
  /**
   * The real client, with some of its calls answered by the test instead.
   *
   * A decorator rather than a replacement, so that everything a test is not
   * about still goes to the real gateway. What it is for is the answers the
   * gateway will not give on command: a call that is refused, or one that
   * nothing answers at all.
   */
  readonly client?: (real: GatewayClient) => GatewayClient;
  /**
   * The real component, with some of its calls answered by the test instead.
   *
   * The same shape as the client above and for the same reason. One thing the
   * store cannot be asked for is a write that fails, and what the cabinet does
   * when the fresh key cannot be written onto a row is the case that decides
   * whether somebody is locked out of their own cabinet.
   */
  readonly identity?: (real: Identity) => Identity;
  /**
   * What the mail provider does with a message this cabinet hands it.
   *
   * Taken by default, which is what the sandbox postman answers and what a
   * provider that is up answers. A test asking for `"refused"` gets the other
   * half — the afternoon a provider will not take anything — because that is
   * the case a screen must not call a link sent.
   */
  readonly mailTakes?: Handover;
  /** A store for WooCommerce connections, for the tests that need its routes. */
  readonly wooShops?: WooShops;
}

const started = async (options: Starting = {}): Promise<Running> => {
  const harnessed = await harness({ PAY_TO_ADDRESS: PAY_TO, ...options.gateway });
  const gateway = await serve(harnessed);
  const basePath = options.base ?? "";
  const mails: Message[] = [];
  const { browser, url, identity, forgetMerchant, rows } = await visiting(
    gateway.url,
    basePath,
    mails,
    options,
  );
  let stopped = false;

  open = {
    harnessed,
    gateway,
    browser,
    url,
    identity,
    forgetMerchant,
    rows,
    mails,
    another: async () => await attachedTo(url, basePath, () => mails.at(-1), rows),
    async stopGateway() {
      if (stopped) {
        return;
      }
      stopped = true;
      await gateway.close();
      await harnessed.stop();
    },
  };
  return open;
};

/**
 * A server that accepts the connection and then says nothing, ever.
 *
 * The worst shape a gateway fails in, and the only one that costs wall time: a
 * refused connection comes back at once, while this holds the caller until the
 * caller gives up. One test points a cabinet at it to find out how long that is.
 */
let silent: Server | null = null;
const silentGateway = async (): Promise<string> => {
  const server = createServer(() => {
    // Deliberately no answer: the point is that the caller is the one that
    // has to stop waiting.
  });
  silent = server;
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the silent gateway did not take a port");
  }
  return `http://127.0.0.1:${address.port}`;
};

afterEach(async () => {
  await open?.browser.close();
  await open?.identity.close();
  await open?.stopGateway();
  open = null;
  silent?.closeAllConnections();
  silent?.close();
  silent = null;
});

/** The cabinet on a port, and a cookie jar of one. */
async function visiting(
  gatewayUrl: string,
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
  // No merchant key in the environment, which is the point: the cabinet builds
  // its client from the key on the row of whoever is signed in, so what these
  // tests drive is the real client against the real gateway with the key the
  // harness seeded (ADR-0014 §2).
  //
  // The database address is one nothing connects to, and nothing does: the
  // component under test keeps its rows in memory here. It is still required,
  // because a cabinet started without one is a cabinet that can draw a sign-in
  // form and never accept one.
  const config = loadConfig({
    GATEWAY_URL: gatewayUrl,
    DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
    AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
    PAYMENT_NETWORK: "eip155:84532",
    FACILITATOR_URL: "sandbox:scripted",
    REGISTRATION_INVITATION:
      options.gateway?.REGISTRATION_INVITATION ?? "the-invitation-the-gateway-accepts",
    ...(basePath === "" ? {} : { BASE_PATH: basePath }),
    ...(options.cabinet ?? {}),
  });
  const { identity, forgetMerchant, rows } = await withIdentity(config, async (message) => {
    mails.push(message);
    return options.mailTakes ?? "accepted";
  });
  const app = buildApp(config, {
    identity: options.identity === undefined ? identity : options.identity(identity),
    ...(options.registrar === undefined ? {} : { registrar: options.registrar }),
    ...(options.wooShops === undefined ? {} : { wooShops: options.wooShops }),
    // Built from the configured address and given the deadline it was asked
    // for, so that a test which points the cabinet somewhere else — at nothing
    // at all, or at a server that never answers — is answered the way a
    // deployment would be, and so that how long the cabinet is willing to wait
    // is its own decision and not this seam's.
    gatewayFor: (key: string, answerWithinMs?: number) => {
      const real = gatewayFor(config.gatewayUrl, key, answerWithinMs);
      return options.client === undefined ? real : options.client(real);
    },
  });
  // On the address it is called at, rather than on the wildcard: the gateway's
  // own harness says at length what a wildcard bind costs, and this cabinet is
  // called the same way from the same worker.
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
      // Closing one that is already closed is not an error. A test that stands
      // several cabinets up and takes each down as it finishes still meets the
      // sweep afterwards, and a second close that threw would fail the test for
      // tidying up after itself.
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
 * A browser pointed at a cabinet that is already listening, with a cookie jar
 * of its own.
 *
 * Separate from `visiting` because two of the tests build their own cabinet —
 * one whose gateway client answers as the test says — and everything about
 * being a browser is the same for both.
 */
async function attachedTo(
  url: string,
  basePath: string,
  latestMail: () => Message | undefined = () => undefined,
  rows: Record<string, Record<string, unknown>[]> = {},
): Promise<Browser> {
  const jar = new Map<string, string>();

  const call = async (
    method: string,
    path: string,
    form?: Record<string, string>,
    sent: {
      readonly cookie?: string;
      readonly origin?: string;
      readonly extra?: Record<string, string>;
      readonly raw?: { readonly contentType: string; readonly body: string };
    } = {},
  ): Promise<Visit> => {
    const cookie = sent.cookie ?? [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
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

    return {
      status: answered.status,
      headers: answered.headers,
      html: await answered.text(),
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
 * One request written straight onto a socket, with nothing added to it.
 *
 * `fetch` sends headers of its own — an accept, a user agent, an encoding — and
 * they count against the 16 KB of headers the runtime will read. A test about
 * how many cookies one request can carry cannot be written with it, because
 * what it would be measuring is those headers. This sends a request line, a
 * Host, the cookies, and nothing else.
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

/** Whether an agent could buy this product right now. */
const purchasable = async (gateway: Served, itemId: string): Promise<boolean> =>
  (await gateway.call("POST", `/x402/${itemId}/purchase`, { body: { params: {} } })).status === 402;

/**
 * Takes the name buyers read off the merchant every test in this file signs in
 * as.
 *
 * Through the store rather than through the route, and that is not a shortcut:
 * the route refuses to take a name away on purpose, so no door in the cabinet
 * leads back to this state. What it makes is the merchant a person has in the
 * minute after they register, which is the state the screens below exist for.
 */
const unname = async (running: Running): Promise<void> => {
  await running.harnessed.store.setServiceName(
    running.harnessed.merchant.id,
    null,
    running.harnessed.now(),
  );
};

/** What the gateway has this merchant listed as, read out of its store. */
const listedAs = async (running: Running): Promise<string | null> =>
  (await running.harnessed.store.merchantById(running.harnessed.merchant.id))?.serviceName ?? null;

/** Where the gateway would pay this merchant, read out of the same row. */
const paidInto = async (running: Running): Promise<string | null> =>
  (await running.harnessed.store.merchantById(running.harnessed.merchant.id))?.payoutWallet
    .address ?? null;

/**
 * Puts a key made for a cabinet on every account row of the merchant this file
 * signs in as, one key per row.
 *
 * The rows this file seeds hold the harness's own key, which is one of the
 * merchant's own code, and the payout wallet is set with a cabinet's key and no
 * other (ADR-0019). One per row, because a sign-in renews the key on its row
 * and forgets the one it replaced, which would leave a second row holding a
 * key the gateway no longer knows.
 */
const onACabinetKey = async (running: Running): Promise<void> => {
  for (const row of running.rows.cabinet_accounts ?? []) {
    if (row.merchantId === THE_MERCHANT.id) {
      row.merchantKey = await running.harnessed.addCabinetKey(running.harnessed.merchant.id);
    }
  }
};

/** The change of the payout wallet waiting at the gateway, or null. */
const waitingOf = async (running: Running): Promise<unknown> =>
  (
    (
      await running.gateway.call("GET", "/v0/payout-wallet", {
        headers: { authorization: `Bearer ${running.harnessed.merchant.key}` },
      })
    ).body as { pending: unknown }
  ).pending;

/** The one line of an answer that sets the session cookie of this name, if any. */
const sessionCookieIn = (answer: Visit, name: string): string | undefined =>
  answer.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));

/** The attributes of one Set-Cookie line, keyed in lower case. */
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

describe("the passwordless cabinet door", () => {
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
    expect(rows.cabinet_sessions).toStrictEqual([]);
    expect(mails).toHaveLength(2);
    expect(known.html).toContain('method="post" action="/sign-in"');
    expect(known.html).toContain('method="get" action="/sign-in"');
    expect(known.html).toContain(`name="email" type="hidden" value="${PERSON}"`);
    // A link has just gone out, so the resend carries the minute the door
    // keeps between two of them — and carries it pressable. The script greys
    // the button out; a browser that runs none is left the button it has
    // always had, and the door refuses the early press in words.
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
    // Production break: the third link spends the hour, and a page that greys
    // its resend for sixty seconds hands the button back, invites the press in
    // words, and buys the person "try again in fifty-seven minutes".
    const oldest = new Date(rows.cabinet_link_sends?.[0]?.sentAt as Date).getTime();
    const owed = Math.ceil((oldest + LINK_RATE_WINDOW_MS - Date.now()) / 1_000);
    const said = Number(waitingButton(page.html).attributes.get("data-link-wait"));
    expect(said).toBeGreaterThan(LINK_MIN_INTERVAL_MS / 1_000);
    expect(Math.abs(said - owed)).toBeLessThanOrEqual(2);
  });

  it("keeps the known address on the page and names the wait after its hourly limit", async () => {
    const { browser, mails, rows } = await started();

    // Three links an hour take at least two minutes to ask for, so the rows
    // are moved back a minute between them: what this test is about is the
    // wall at the end of the three, not the minute in front of each.
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
    // The resend stays, with the hour the server computed on it and nothing
    // disabling it: a button served disabled is one no scriptless browser can
    // ever press again, and this is the page where that would be felt.
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
    // The wait is under a minute, so the hourly sentence would be a lie, and
    // the three this address still has are untouched.
    expect(said).not.toContain("three links an hour");
    expect(said).not.toMatch(/Try again in \d+ minutes/);
    // The seconds the door computed reach the page on the button, which is
    // what counts them down, and the button is served pressable. Somebody at
    // the wrong address still has the other way out beside it.
    const resend = waitingButton(again.html);
    expect(resend.attributes.get("data-link-wait")).toBe(again.headers.get("retry-after"));
    expect(resend.attributes.has("disabled")).toBe(false);
    expect(again.html).toContain('method="post" action="/sign-in"');
    expect(again.html).toContain('method="get" action="/sign-in"');
    expect(mails).toHaveLength(1);
  });

  it("does not spend a query token on GET and opens it once on an explicit same-origin POST", async () => {
    const running = await started({ base: "/cabinet", cabinet: { COOKIE_SECURE: "true" } });
    const requested = await running.browser.post("/cabinet/sign-in", { email: PERSON });
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
    // The page names the address the press would sign in, which is what stops
    // a link for somebody else's address, sent to a victim, from signing them
    // in as that somebody without their noticing (ADR-0026 §1).
    expect(readable(landing.html)).toContain(PERSON);
    expect(running.rows.cabinet_sessions).toStrictEqual([]);

    const opened = await running.browser.from(running.url).post("/cabinet/sign-in/open", { token });
    expect(opened.status).toBe(303);
    expect(opened.to).toBe("/cabinet/cards");
    expect(opened.headers.get("cache-control")).toBe("private, no-store");
    expect(opened.headers.get("referrer-policy")).toBe("strict-origin");
    expect(sessionCookieIn(opened, SECURE_COOKIE)).toBeDefined();

    // Pressed twice in a browser that is now signed in: the person's start,
    // not a page about the link (ADR-0026 §1).
    const replay = await running.browser.from(running.url).post("/cabinet/sign-in/open", { token });
    expect(replay.status).toBe(303);
    expect(replay.to).toBe("/cabinet/cards");

    const switching = await running.browser.from(running.url).post("/cabinet/sign-out");
    expect(switching.status).toBe(303);
    expect(switching.to).toBe("/cabinet/sign-in");
    expect(running.rows.cabinet_sessions).toStrictEqual([]);
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
    expect(running.rows.cabinet_sessions).toStrictEqual([]);

    const honest = await running.browser.from(running.url).post("/sign-in/open", { token });
    expect(honest.status).toBe(303);
  });

  it("says when the provider refused the message and leaves no identity state", async () => {
    const { browser, rows, identity } = await started({ mailTakes: "refused" });

    const answered = await browser.post("/sign-in", { email: "new@example.com" });

    expect(answered.status).toBe(503);
    // The postman answers the same way for a rejection and for a timeout, and
    // a message of the second kind may have arrived, so the page may not claim
    // that nothing was sent. What it can claim is that nothing was written.
    expect(readable(answered.html)).toMatch(/could not confirm/i);
    expect(readable(answered.html)).not.toMatch(/no link was sent|nothing was sent/i);
    expect(readable(answered.html)).toMatch(/no account and no session/i);
    expect(answered.headers.getSetCookie()).toStrictEqual([]);
    expect(await identity.byEmail("new@example.com")).toBeNull();
    expect(rows.cabinet_sessions).toStrictEqual([]);
    expect(rows.cabinet_verifications).toStrictEqual([]);
    expect(rows.cabinet_link_sends).toStrictEqual([]);
  });

  it("never makes a merchant by opening a link: a person without one starts at their latest report", async () => {
    // Under Lax a link from another site arrives signed in, so opening a link
    // must not be able to make anything (ADR-0026 §4). A person who owns
    // reports and no merchant starts at the latest of them, and the scanner
    // sends somebody who owns none back to the cabinet (§1).
    const registered: string[] = [];
    const registrar: Registrar = {
      register: async () => {
        registered.push("asked");
        return { ok: true, document: { merchant_id: "mer_never", secret: "never-made" } };
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
    // Opening the cabinet by a plain navigation makes nothing either: it draws
    // the one control and names who is signed in, privately.
    const screen = await running.browser.get("/merchant");
    expect(screen.status).toBe(200);
    expect(screen.headers.get("cache-control")).toBe("private, no-store");
    expect(readable(screen.html)).toContain(FRESH.email);
    expect(screen.html).toContain('method="post" action="/merchant"');
    expect(registered).toStrictEqual([]);
  });

  it("makes the merchant and its key on the explicit press, and only a same-origin one", async () => {
    const running = await started({ gateway: { REGISTRATION_INVITATION: INVITATION } });
    await running.browser.signIn(FRESH.email);

    const forged = await running.browser.from("https://evil.example").post("/merchant");
    expect(forged.status).toBe(403);
    expect((await running.identity.byEmail(FRESH.email))?.merchant).toBeNull();

    const inside = await running.browser.makeMerchant();

    expect(inside.status).toBe(200);
    expect(inside.html).toContain('name="seller_name"');
    expect((await running.identity.byEmail(FRESH.email))?.merchant).not.toBeNull();
  });

  it("keeps the P1 session when registration fails and retries without another link", async () => {
    let available = false;
    const registrar: Registrar = {
      register: async () =>
        available
          ? {
              ok: true,
              document: { merchant_id: "mer_after_retry", secret: "the-key-after-retry" },
            }
          : { ok: false, status: 0, why: "the gateway could not be reached" },
    };
    const running = await started({ registrar });
    await running.browser.post("/sign-in", { email: FRESH.email });
    const action = actionIn(running.mails.at(-1));
    const token = action.searchParams.get("token") ?? "";
    const opened = await running.browser.from(running.url).post("/sign-in/open", { token });
    expect(opened.to).toBe(LATEST_REPORT);

    const first = await running.browser.from(running.url).post("/merchant");
    expect(first.status).toBe(503);
    expect(running.rows.cabinet_sessions).toHaveLength(1);
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
    // What the browser holds decides, never the link: the answer is the same
    // whoever the link was for, so it says nothing about that address
    // (ADR-0026 §1).
    const running = await started();
    await running.identity.make(OTHER, THE_MERCHANT);
    await running.browser.post("/sign-in", { email: OTHER });
    const theirs = actionIn(running.mails.at(-1)).searchParams.get("token") ?? "";
    const stranger = await running.another();
    await stranger.from(running.url).post("/sign-in/open", { token: theirs });
    await running.browser.signIn();
    const expired = (): string => {
      for (const row of running.rows.cabinet_verifications ?? []) {
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
    // The destination was recorded with the token when the scanner asked for
    // the link, and nothing the browser sends is read as one (ADR-0026 §1).
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
    // A report and the cabinet are two applications on one origin, and one
    // session serves both (ADR-0009 §6, ADR-0026 §2). A cookie scoped to the
    // cabinet's path would leave a person a stranger at the report, and the
    // prefix is what stops a sibling host from planting or replacing it.
    const running = await started({ base: "/cabinet", cabinet: { COOKIE_SECURE: "true" } });
    await running.browser.post("/cabinet/sign-in", { email: PERSON });
    const action = actionIn(running.mails.at(-1));

    const opened = await running.browser
      .from(running.url)
      .post("/cabinet/sign-in/open", { token: action.searchParams.get("token") ?? "" });

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
    // And the cookie opens a page that is not under the cabinet's mount point
    // as far as the cabinet is concerned: it is the same session at the root.
    expect((await running.browser.get("/cabinet/cards")).status).toBe(200);
  });

  it("sets the same cookie without the prefix or Secure on the plain-http local origin", async () => {
    // The prefix requires Secure, and a Secure cookie is never sent back over
    // plain http, so the laptop's origin gets neither rather than a session
    // nobody can use. Mounted where the stack mounts it, under /cabinet, so a
    // cookie scoped to the mount point would show here: on https the prefix
    // forces the root path whatever the cabinet asks for.
    const running = await started({ base: "/cabinet" });
    await running.browser.post("/cabinet/sign-in", { email: PERSON });
    const action = actionIn(running.mails.at(-1));

    const opened = await running.browser
      .from(running.url)
      .post("/cabinet/sign-in/open", { token: action.searchParams.get("token") ?? "" });

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
    // A person who keeps coming back does not meet the sign-in form again
    // (ADR-0009 §6). The row decides, so the row is moved, and the browser is
    // handed the renewed cookie, because a cookie left at its first lifetime
    // drops out of the browser thirty days after sign-in however often its
    // person came back.
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
    // The negative half of the one above: renewal is once a day, not a write
    // on every page, and a page that sets the cookie on every answer would be
    // a write to the sessions table on every click.
    const running = await started();
    await running.browser.signIn();
    const before = structuredClone(sessionRows());

    const visited = await running.browser.get("/cards");

    expect(visited.status).toBe(200);
    expect(sessionCookieIn(visited, COOKIE)).toBeUndefined();
    expect(sessionRows()).toStrictEqual(before);
  });

  it("clears the site-wide cookie on sign-out, with the attributes the prefix demands", async () => {
    // A clearing line the browser refuses leaves the session cookie in place:
    // a prefixed cookie is only replaced by a line that is Secure and for the
    // whole origin, and a path-scoped clear would miss a cookie set at the root.
    const running = await started({ base: "/cabinet", cabinet: { COOKIE_SECURE: "true" } });
    await running.browser.signIn();

    const out = await running.browser.from(running.url).post("/cabinet/sign-out");

    expect(out.status).toBe(303);
    const line = sessionCookieIn(out, SECURE_COOKIE);
    expect(line).toBeDefined();
    const attributes = attributesOf(line ?? "");
    expect(attributes.get("path")).toBe("/");
    expect(attributes.has("secure")).toBe(true);
    expect(new Date(attributes.get("expires") ?? "").getTime()).toBeLessThan(Date.now());
    expect(running.rows.cabinet_sessions).toStrictEqual([]);
  });
});

describe("the operator flag", () => {
  it("is moved by no request a browser can send to the cabinet", async () => {
    // Being an operator opens the operator's dashboard, and only the terminal's
    // command grants it (ADR-0026 §6). So a signed-in person sends every route
    // the cabinet has a flag of its own, as a form, as JSON and in the query,
    // and is no operator afterwards. The routes are read off the cabinet's own
    // router rather than listed here, so a route added later is asked too.
    //
    // Every handler runs with what it is sent, and most stop early: a form
    // without the fields it asks for is refused, and a route parameter is
    // filled with an identifier no card or key has, so the gateway refuses it
    // and the handler relays that. What this holds is that no handler takes
    // the flag from a request, not that every line behind those refusals ran.
    const running = await started({ wooShops: memoryWooShops() });
    await running.browser.signIn();
    const listed = buildApp(
      loadConfig({
        GATEWAY_URL: running.gateway.url,
        DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
        AUTH_SECRET: "x".repeat(44),
        PAYMENT_NETWORK: "eip155:84532",
        FACILITATOR_URL: "sandbox:scripted",
        REGISTRATION_INVITATION: INVITATION,
      }),
      { identity: running.identity, wooShops: memoryWooShops() },
    );
    const routes = (
      listed.router.stack as { route?: { path: string; methods: Record<string, boolean> } }[]
    ).flatMap(({ route }) =>
      route === undefined
        ? []
        : Object.keys(route.methods).map((method) => ({
            method,
            path: route.path.replaceAll(/:[a-z_]+/g, "x"),
          })),
    );
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
  it("lets a visitor with no session reach exactly the routes ADR-0009 §2 lists above it", async () => {
    // The list is written in the decision rather than discovered by reading
    // the routing, and this is where it is held: every route on it answers a
    // stranger without the sign-in redirect, and a route that is not on it —
    // including the report handoff that is gone — is behind the gate.
    const running = await started({ base: "/cabinet", wooShops: memoryWooShops() });
    // A browser carrying a session cookie that no longer opens anything, so
    // that the gate's answer is its own: the sign-in with the reason the
    // session ended, which no route above the gate ever answers with.
    const stranger = running.browser.withRawCookie(`${COOKIE}=made-up-identifier`);
    const gate = (answer: Visit): boolean =>
      answer.status === 303 && (answer.to ?? "").includes("reason=session-ended");

    const above: readonly [string, () => Promise<Visit>][] = [
      ["the sign-in", () => stranger.get("/cabinet/sign-in")],
      ["asking for a link", () => stranger.post("/cabinet/sign-in", { email: "" })],
      ["the sign-out", () => stranger.post("/cabinet/sign-out")],
      [
        "the page a link lands on",
        () => stranger.get(`/cabinet/sign-in/open?token=${"C".repeat(32)}`),
      ],
      ["pressing it", () => stranger.post("/cabinet/sign-in/open", { token: "C".repeat(32) })],
      ["the stylesheet", () => stranger.get("/cabinet/agentify.css")],
      ["the health probe", () => stranger.get("/cabinet/healthz")],
      [
        "the shop's callback",
        () => running.browser.postRaw("/cabinet/woocommerce/callback", "application/json", "{}"),
      ],
      ["the shop's return", () => stranger.get("/cabinet/woocommerce/return")],
    ];
    for (const [name, visit] of above) {
      const answer = await visit();
      expect(gate(answer), name).toBe(false);
      expect(answer.status, name).toBeLessThan(500);
    }

    for (const path of ["/cabinet/", "/cabinet/cards", "/cabinet/merchant", "/cabinet/settings"]) {
      expect(gate(await stranger.get(path)), path).toBe(true);
    }
    for (const path of ["/cabinet/merchant", "/cabinet/report-handoff", "/cabinet/keys"]) {
      expect(gate(await stranger.post(path)), path).toBe(true);
    }
  });
});

describe("choosing the name buyers read", () => {
  it("asks for the name on a screen of its own, with room to say what it is for", async () => {
    // The whole reason the field left the registration form. Here it can say
    // what the name does, show what one looks like, and promise that it can be
    // changed — none of which fits beside a password box, and all of which
    // decides whether what arrives is a name or "some stuff".
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    const screen = await running.browser.get("/choose-name");
    const text = readable(screen.html);

    expect(screen.status).toBe(200);
    expect(screen.html).toContain('name="seller_name"');
    // What it is for, in terms somebody who has never seen a catalogue can act
    // on: buyers read it, beside the products.
    expect(text).toMatch(/buyers/i);
    expect(text).toMatch(/name people already know/i);
    // The rule the catalogue holds it to, before anybody types rather than
    // after a refusal.
    expect(text).toMatch(/32 characters/);
    // That it can be changed, and where.
    expect(text).toMatch(/change/i);
    expect(screen.html).toContain('href="/settings"');
    // And a way past it, for somebody who has not decided.
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
    // Skipping is allowed because a name demanded before somebody can answer it
    // is a name nobody means. What is not allowed is skipping it silently: a
    // merchant whose code then publishes a card meets a refusal, and the
    // cabinet says so before that happens.
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    const cards = await running.browser.get("/cards");
    const text = readable(cards.html);

    expect(cards.status).toBe(200);
    expect(text).toMatch(/cannot go on sale/i);
    expect(cards.html).toContain('href="/settings"');
    expect(await listedAs(running)).toBeNull();
  });

  it("refuses a name the catalogue that lists it would not carry, and says the rule", async () => {
    // The catalogue's rule is thirty-two characters of ordinary keyboard
    // characters with no space at either end. A name outside it is refused by
    // the gateway with a sentence written for whoever reads an API response;
    // refused here, the person is told the rule in the words of the screen they
    // are looking at, and nothing is written.
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
    // The field can arrive empty or not arrive, and a form posted by something
    // that is not this page does the second. Both are somebody who has typed no
    // name, and the screen says so rather than writing an empty one.
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    const answered = await running.browser.post("/choose-name");

    expect(answered.status).toBe(400);
    expect(readable(answered.html)).toMatch(/name is needed/i);
    // And it still says the way past, because that is what somebody with
    // nothing to type needs.
    expect(answered.html).toContain('href="/cards"');
    expect(await listedAs(running)).toBeNull();
  });

  it("takes the space off a name rather than refusing it for one", async () => {
    // A space at the front of a form field is a typing accident, and the rule
    // that refuses it exists because a padded name survives the catalogue
    // untouched and makes two spellings of one word. Trimming it gives the
    // person the name they meant.
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    const chosen = await running.browser.post("/choose-name", {
      seller_name: "  Bright Data Plans  ",
    });

    expect(chosen.status).toBe(303);
    expect(await listedAs(running)).toBe("Bright Data Plans");
  });

  it("is behind the gate, like every other screen in the cabinet", async () => {
    const running = await started();

    const screen = await running.browser.get("/choose-name");
    const posted = await running.browser.post("/choose-name", { seller_name: "Anybody At All" });

    expect(screen.to).toBe("/sign-in");
    expect(posted.to).toBe("/sign-in");
  });
});

describe("the settings screen", () => {
  it("is reachable from every screen a merchant works on", async () => {
    // It holds the name today and it is where the next such thing goes, so a
    // merchant has to be able to find it without being sent a link.
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
    // A merchant who wants to stop being listed stops their selling, which
    // leaves their cards where they are and lets them start again. Emptying the
    // name would leave the cards on sale under nobody, so the route refuses it
    // and the screen says the thing that actually works.
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
    // Not a gap somebody should fill in later: the refusal is the rule, and a
    // button that provoked it would be a control whose whole result is a
    // refusal page.
    const { browser } = await started();
    await browser.signIn();

    const text = readable((await browser.get("/settings")).html);

    expect(text).toMatch(/cannot|never/i);
    expect(text).toMatch(/stop.*selling/i);
    // And the rule, on the page rather than only in a refusal.
    expect(text).toMatch(/32 characters/);
  });

  it("refuses a name outside the rule and leaves the one there was", async () => {
    const running = await started();
    await running.browser.signIn();

    const answered = await running.browser.post("/settings", { seller_name: "x".repeat(33) });

    expect(answered.status).toBe(400);
    // What was refused, and that nothing was written — the second half is the
    // one a merchant cannot see for themselves, and the page still shows what
    // they are actually listed under.
    expect(readable(answered.html)).toMatch(/not saved/i);
    expect(readable(answered.html)).toMatch(/printable ASCII/i);
    expect(answered.html).toContain(`value="${"x".repeat(33)}"`);
    expect(readable(answered.html)).toContain(running.harnessed.merchant.name);
    expect(await listedAs(running)).toBe(running.harnessed.merchant.name);
  });

  it("answers an emptied box with the control that does what they meant", async () => {
    // Emptying this box is a merchant trying to stop being listed. The route
    // refuses it either way, so the question is which sentence they read: the
    // rule the catalogue keeps, which is about a name they did not type, or
    // what to do instead. Told the rule, somebody tries a shorter name; told
    // about the selling switch, they find the control that leaves their cards
    // where they can put them back.
    const running = await started();
    await running.browser.signIn();

    const answered = await running.browser.post("/settings", { seller_name: "   " });

    expect(answered.status).toBe(400);
    expect(readable(answered.html)).toMatch(/stop your selling/i);
    // And not the other sentence, which is the one the mutation that found this
    // gap swapped in: both refuse, and only one of them is an answer.
    expect(readable(answered.html)).not.toMatch(/not a name the catalogue will carry/i);
    expect(await listedAs(running)).toBe(running.harnessed.merchant.name);
  });

  it("says the gateway would not answer rather than drawing a page with no name on it", async () => {
    const running = await started();
    await running.browser.signIn();
    await running.stopGateway();

    const screen = await running.browser.get("/settings");

    expect(screen.status).toBe(502);
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
   * An address of the right shape that is nobody's: the digits run 0 to 9 and
   * then the letters a to f, twice over. A fixture rather than somewhere money
   * could sensibly be sent.
   *
   * Two spellings of the same one. The lower-case form is what a block explorer
   * prints and what half the tooling in this world hands somebody; the other is
   * the mixed-case spelling a wallet displays, which is a checksum over the
   * address itself. The second is computed from the first rather than typed out
   * here, because a checksum written by hand into a fixture is a checksum that
   * can be wrong — and a wrong one would make these tests pass against a
   * gateway that had stopped checking.
   */
  const LOWER = "0x0123456789abcdef0123456789abcdef01234567";
  const AS_A_WALLET_SHOWS_IT = checksummedAddressOf(LOWER);

  it("is asked for on the settings screen", async () => {
    // The block is one line on that screen and this is what holds it there: a
    // merchant with nowhere to be paid has to be able to find the box without
    // being sent a link to it.
    const { browser } = await started();
    await browser.signIn();

    const screen = await browser.get("/settings");

    expect(screen.status).toBe(200);
    expect(screen.html).toContain('name="payout_wallet"');
    expect(readable(screen.html)).toMatch(/where your money arrives/i);
  });

  it("is saved, and the whole of it is on the page afterwards", async () => {
    const running = await started();
    await onACabinetKey(running);
    await running.browser.signIn();

    const saved = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: AS_A_WALLET_SHOWS_IT,
    });

    expect(saved.status).toBe(303);
    expect(saved.to).toBe("/settings");
    expect(await paidInto(running)).toBe(AS_A_WALLET_SHOWS_IT);
    // And read back whole rather than shortened, because the shortening is the
    // presentation under which a wrong address and the right one look the same.
    const after = await running.browser.get("/settings");
    expect(after.html.replaceAll(/<[^>]*>/g, "")).toContain(AS_A_WALLET_SHOWS_IT);
  });

  it("shows an address pasted in lower case the way the merchant's wallet shows it", async () => {
    // The spelling is the gateway's to decide and it decides on the wallet's,
    // because that is the one a person recognises without comparing character
    // by character — which on this field is the only checking anybody does. So
    // a merchant who pasted the lower-case spelling a block explorer gave them
    // reads their own wallet's spelling back, and the page never asks anybody
    // to believe that two strings are one address.
    const running = await started();
    await onACabinetKey(running);
    await running.browser.signIn();

    const saved = await running.browser.post("/settings/payout-wallet", { payout_wallet: LOWER });

    expect(saved.status).toBe(303);
    expect(await paidInto(running)).toBe(AS_A_WALLET_SHOWS_IT);
    expect((await running.browser.get("/settings")).html.replaceAll(/<[^>]*>/g, "")).toContain(
      AS_A_WALLET_SHOWS_IT,
    );
  });

  it("refuses a spelling whose capitals disagree with the rest and says which it is", async () => {
    // The failure this box exists to catch. Forty characters of the right shape
    // whose capitals do not check out mean a character in the address is wrong,
    // and a wrong address is another perfectly good one belonging to somebody
    // else. A refusal reading "that is not an address" would be untrue here and
    // would leave a merchant re-reading a spelling that looks fine.
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
    // Unchanged rather than absent: the merchant this harness seeds is already
    // being paid somewhere, and what a refusal has to leave alone is wherever
    // that is.
    expect(await paidInto(running)).toBe(before);
    const text = readable(answered.html);
    expect(text).toMatch(/capital letters/i);
    expect(text).toMatch(/not saved/i);
    expect(answered.html).toContain(`value="${mangled}"`);
  });

  it("takes the space off what was pasted rather than refusing it", async () => {
    // An address is copied out of a wallet, and a wallet hands it over with a
    // newline on the end about as often as not. Refusing that is refusing a
    // merchant who did exactly the right thing.
    const running = await started();
    await onACabinetKey(running);
    await running.browser.signIn();

    const saved = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: `  ${AS_A_WALLET_SHOWS_IT}\n`,
    });

    expect(saved.status).toBe(303);
    expect(await paidInto(running)).toBe(AS_A_WALLET_SHOWS_IT);
  });

  it("refuses an address of the wrong shape and sends nothing", async () => {
    const running = await started();
    await onACabinetKey(running);
    await running.browser.signIn();
    await running.browser.post("/settings/payout-wallet", {
      payout_wallet: AS_A_WALLET_SHOWS_IT,
    });

    const answered = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: `${AS_A_WALLET_SHOWS_IT}0`,
    });

    expect(answered.status).toBe(400);
    // What was refused, that nothing was written, and — the half a merchant
    // cannot see for themselves — where their money still goes.
    expect(readable(answered.html)).toMatch(/not saved/i);
    expect(answered.html.replaceAll(/<[^>]*>/g, "")).toContain(AS_A_WALLET_SHOWS_IT);
    expect(await paidInto(running)).toBe(AS_A_WALLET_SHOWS_IT);
  });

  it("tells an account holding a key of the merchant's own code that its key is of the wrong kind for the wallet", async () => {
    // The row of the account every test here signs in as holds the harness's
    // own key, which is one of the merchant's own code: the shape an account
    // made before accounts were checked is left in. The gateway will not let
    // that key set the wallet, nothing in the cabinet can replace it, and a
    // page saying "try again" would send the person round a loop.
    const running = await started();
    await running.browser.signIn();
    const before = await paidInto(running);

    const answered = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: AS_A_WALLET_SHOWS_IT,
    });

    expect(answered.status).toBe(403);
    const text = readable(answered.html);
    expect(text).toMatch(/wrong kind/i);
    expect(text).not.toMatch(/try again/i);
    expect(answered.html).toContain('name="payout_wallet"');
    expect(await paidInto(running)).toBe(before);
  });

  it("refuses an empty box and says what to paste into it", async () => {
    const running = await started();
    await running.browser.signIn();
    const before = await paidInto(running);

    for (const form of [{ payout_wallet: "" }, {}] as Record<string, string>[]) {
      const answered = await running.browser.post("/settings/payout-wallet", form);
      expect(answered.status).toBe(400);
      expect(readable(answered.html)).toMatch(/address is needed/i);
      // An empty box is the shape a merchant reaches for who wants to stop
      // being paid here, and it is the one this cannot do: where the money goes
      // is what it was.
      expect(await paidInto(running)).toBe(before);
    }
  });

  it("says the gateway would not answer rather than drawing a page with no address on it", async () => {
    const running = await started();
    await running.browser.signIn();
    await running.stopGateway();

    const screen = await running.browser.get("/settings");

    expect(screen.status).toBe(502);
    expect(readable(screen.html)).toMatch(/did not answer/i);
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
      expect(text, path).toMatch(/cannot go on sale/i);
    }
    // And the page it sends them to is the one that fixes it: a sentence with
    // nowhere to go is a sentence that leaves a merchant hunting.
    const settings = await running.browser.get("/settings");
    expect(settings.status).toBe(200);
    expect(settings.html).toContain('name="seller_name"');
  });

  it("is told nothing of the sort once the name is chosen", async () => {
    // A banner that never leaves is a banner nobody reads, and this one is
    // about a state a merchant can be out of in one form post.
    const running = await started();
    await publish(running.gateway, roomCard);
    await running.browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts"]) {
      const text = readable((await running.browser.get(path)).html);
      expect(text, path).not.toMatch(/cannot go on sale/i);
    }
  });

  it("reads the refusal their own code meets in the cabinet's words, not the gateway's", async () => {
    // The refusal a merchant's code gets names the route that fixes it, because
    // it is written for whoever is holding the response. A person in a cabinet
    // cannot make that call and should not be told to: the screen says what the
    // missing thing is and points at the page that sets it.
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

    // The gateway really did refuse, for this reason, in those words.
    expect(refused.status).toBe(422);
    expect(finding?.code).toBe("no_seller_name");
    expect(finding?.message).toContain("POST /v0/seller-name");
    // And the cabinet says the same thing without sending anybody to a route.
    expect(text).toMatch(/cannot go on sale/i);
    expect(cards.html).toContain('href="/settings"');
    expect(text).not.toContain("POST /v0/seller-name");
  });
});

describe("the way out to the documentation", () => {
  it("is on every screen a merchant works on, and leaves the cabinet's mount point", async () => {
    // The documentation was linked from the landing and from nowhere else, so a
    // merchant already inside the cabinet had to leave it by hand to read a
    // line of it. And it is beside the cabinet on one origin rather than under
    // it (deploy/Caddyfile): a link that took the mount point along would send
    // them to /cabinet/docs/, which is an address nothing answers.
    const { browser, gateway } = await started({ base: "/cabinet" });
    await publish(gateway, roomCard);
    await browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts", "/keys", "/settings"]) {
      const screen = await browser.get(`/cabinet${path}`);
      expect(screen.status, path).toBe(200);

      // Found by where it goes rather than by what it is called, and read for
      // the words on it. An anchor with nothing between its tags is a link
      // nobody can see or press, and would satisfy a check for the address
      // alone.
      const out = /<a[^>]+href="\/docs\/"[^>]*>([^<]+)<\/a>/.exec(screen.html);
      expect(out?.[1]?.trim(), `${path} has no readable link to the documentation`).toBeTruthy();
    }
  });
});

describe("the cards screen", () => {
  it("gives each card the whole address an agent buys it at, and it is one that works", async () => {
    // The one thing a merchant cannot work out from this screen without it:
    // where their product actually is. It is the whole address rather than an
    // identifier to assemble one from, and it carries our catalog identifier
    // rather than the merchant's own — the two are different strings, and a
    // merchant who pasted theirs into it would be handed a 404 by a gateway
    // that is working perfectly.
    const running = await started({ cabinet: { PUBLIC_BASE_URL: "https://shop.example.com" } });
    const itemId = await publish(running.gateway, roomCard);
    await running.browser.signIn();

    const screen = await running.browser.get("/cards");
    const shown = /https:\/\/shop\.example\.com(\/x402\/\S+?\/purchase)/.exec(
      readable(screen.html),
    );

    expect(shown?.[1], "the cards screen names the address").toBe(`/x402/${itemId}/purchase`);
    // And it is not a template that happens to match: an agent asking at that
    // very path is answered with the payment challenge rather than a 404.
    expect(await purchasable(running.gateway, itemId)).toBe(true);
    // Text and not a link. Pressing it asks without paying, which is answered
    // in a header with no page behind it — a merchant who clicked would read a
    // blank window as their card being broken.
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
    expect(text).toContain("selling");
  });

  it("shows every promise a card makes, not the first one it finds", async () => {
    // A card can both have its price asked at purchase and owe a delivery
    // inside a window. Showing only the first leaves the merchant reading a row
    // that never mentions the deadline they are answerable for.
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

    expect(text).toContain("not published a card yet");
    expect(screen.html).toContain('href="/docs/quickstart"');
  });

  it("puts a merchant's own text on the page as text, whatever is in it", async () => {
    // A card title is text somebody else wrote. The contract refuses markup in
    // it and not the characters markup is made of, so a title with a bracket,
    // an ampersand or a quotation mark in it must arrive on the page as those
    // characters rather than as markup — a merchant whose product is called
    // 'Tom & Jerry <"the box set">' should see their product, not a page that
    // stopped rendering halfway down the row. The merchant's own key is held
    // to no such rule, so it carries a tag.
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
    // ...and a merchant still reads their own product's name, unchanged.
    expect(readable(page)).toContain('Tom & Jerry <"the box set">');
    expect(readable(page)).toContain("a&b<c>");
  });

  it("pauses one card, and that card stops selling", async () => {
    // The promise the whole screen exists for: the state on the page and what
    // an agent's purchase runs into are the same fact.
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
    // sells and is still the only thing in the public catalog.
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
    expect(stopped).toContain("Start selling again");
    expect(await purchasable(gateway, itemId)).toBe(false);

    await browser.post("/selling/resume");

    expect(await purchasable(gateway, itemId)).toBe(true);
    expect(readable((await browser.get("/cards")).html)).toContain("Stop all selling");
  });

  it("tells a merchant which switch is holding a card off sale", async () => {
    // With everything stopped, a card the merchant did not pause themselves
    // reads paused too, and pressing resume on it would change nothing a
    // merchant can see. The screen says which switch is holding it rather than
    // offering a control that does nothing.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    await browser.post("/selling/pause");
    const html = (await browser.get("/cards")).html;

    expect(readable(html)).toContain("All selling is stopped");
    expect(html).not.toContain(">Resume<");
  });

  it("leaves a card paused when it is published again", async () => {
    // A merchant editing a price is not asking for a product they took off sale
    // to go back on it.
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
  // The promise: the control beside a card says what is holding it off sale,
  // in the same terms as the publish door that would refuse it. A card whose
  // merchant is selling and which nobody paused reads paused for one reason
  // only, that the merchant lacks something the door asks of every merchant;
  // "All selling is stopped" there is a claim about a switch nobody pressed,
  // and it sends the merchant looking for a control that changes nothing. The
  // settings the merchant sets are named and the page that sets them is
  // linked; the operator's approval, which this cabinet cannot read, is said
  // to be unread exactly where the door asks for it.
  //
  // Each merchant is registered through the cabinet's own press and never
  // approved, and its card is written straight into the gateway's store: the
  // door would refuse to publish it for the very reason the test is about,
  // and a merchant reaches this state when something is taken away or asked
  // for after their cards are published.
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
    ...ANNOUNCING,
  };
  const A_WALLET = "0x0123456789abcdef0123456789abcdef01234567";

  /** What the door refuses a card with nothing wrong with it for, about the merchant. */
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

  /** What a control names, in the door's words for the same things. */
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
            REGISTRATION_INVITATION: INVITATION,
            ...CHANNELS[channel],
            ...(channel === "live" ? LIVE_GATEWAY_ONLY : {}),
          },
          cabinet: CHANNELS[channel],
        });
        await running.browser.signIn(FRESH.email);
        expect((await running.browser.makeMerchant()).status).toBe(200);
        const merchant = (await running.identity.byEmail(FRESH.email))?.merchant;
        if (merchant == null) throw new Error("the press made no merchant");
        const asTheMerchant = { authorization: `Bearer ${merchant.key}` };
        if (hasName) {
          const listed = await running.gateway.call("POST", "/v0/seller-name", {
            body: { seller_name: "Their own shop" },
            headers: asTheMerchant,
          });
          expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        }
        if (hasWallet) {
          // Where a wallet is set: in the cabinet's Settings, by the person
          // signed in, since no key of the merchant's own code may set one.
          const saved = await running.browser.post("/settings/payout-wallet", {
            payout_wallet: A_WALLET,
          });
          expect(saved.status, saved.html).toBe(303);
        }
        const door = await theDoorSays(running.gateway, merchant.key);
        if (hasWallet) {
          // The fixture took: a wallet saved is a wallet the door has.
          expect(door).not.toContain(MERCHANT_FINDINGS.NO_PAYOUT_WALLET);
        }
        await running.harnessed.store.publishCard(merchant.id, roomCard, running.harnessed.now());

        const screen = await running.browser.get("/cards");
        const cell = /<td class="control"[^>]*>([\s\S]*?)<\/td>/.exec(screen.html)?.[1] ?? "";
        const control = readable(cell);

        expect(screen.status).toBe(200);
        if (door.length === 0) {
          // Nothing stands in the way, so the card is on sale and the control
          // is the merchant's own switch.
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
          expect(control).toMatch(/cannot tell/i);
        }
      });
    }
  }
});

describe("a merchant who has left", () => {
  // Nothing in the pilot sets this, so it is reached through the store — the
  // same reason `sellingFor`'s departed branch is tested directly. What is
  // asserted is the page, because the gateway was fixed in round one and the
  // fold that undoes the fix lives here.
  it("is not offered a button that puts them back on sale", async () => {
    const { browser, gateway, harnessed } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    await harnessed.store.setSelling(harnessed.merchant.id, "departed");

    const page = (await browser.get("/cards")).html;
    const text = readable(page);

    expect(text).toContain("left");
    // No selling control of any kind, not merely not the resume one: offering
    // "stop all selling" to a merchant who has already gone is the same
    // confusion wearing the other label, and both were reachable from one fold.
    expect(page).not.toContain("/selling/resume");
    expect(page).not.toContain("/selling/pause");
    expect(text).not.toContain("Start selling again");
    expect(text).not.toContain("Stop all selling");
    // And it does not tell them their accepted orders are playing out, which is
    // what a pause means and a departure does not.
    expect(text).not.toContain("play out as usual");
    expect(text).toContain("closed with you");
  });

  it("is told what the gateway said, not that the gateway is down", async () => {
    // The gateway answers 409 with a reason. Rendered as "the gateway did not
    // answer", a merchant goes and checks a service that is running.
    const { browser, gateway, harnessed } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    await harnessed.store.setSelling(harnessed.merchant.id, "departed");

    const refused = await browser.post("/selling/resume");

    expect(refused.status).toBe(409);
    const text = readable(refused.html);
    expect(text).toContain("this merchant has left");
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
    // The sale is over, so it is not in the open list — and the empty list says
    // so rather than looking like a screen that failed to load.
    expect(openOnly).toContain("Nothing is open");
    expect(openOnly).toContain("Every order you have is finished");
  });

  it("does not tell a merchant nothing is owed while an order is still running", async () => {
    // The sentence this pins was wrong twice before. An order under way has, in
    // the asynchronous mode, already taken the buyer's money against goods that
    // have not gone out — so "none of them is owed money or goods by you" is a
    // claim the code cannot make. What it can say is scoped to the two endings
    // it actually counts.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, esimCard);
    await buyOverHttp(harnessed, gateway, itemId, { onOrder: () => ({ accepted: {} }) });
    await browser.signIn();

    const text = readable((await browser.get("/orders?open=true")).html);

    expect(text).toContain("in progress");
    expect(text).not.toContain("owed money or goods");
    expect(text).toContain("None of them owes a refund");
  });

  it("says which orders it cannot show at all", async () => {
    // A purchase that closed before anybody named a price for it is absent from
    // this list by construction — the row every order is drawn in carries the
    // price it sold at. Absence that is never mentioned is the truncation the
    // fifth gate asks about.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    const text = readable((await browser.get("/orders")).html);

    expect(text).toContain("closed before anybody named a price");
    expect(text).toContain("Nothing was charged for them");
  });

  it("says there are no orders rather than showing an empty table", async () => {
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    expect(readable((await browser.get("/orders")).html)).toContain("No orders yet");
  });

  it("calls out an order that owes a refund, and says what the merchant does about it", async () => {
    // The one open state that costs the merchant money. A screen that listed it
    // among the rest would leave a debt to be noticed rather than shown.
    const { browser, gateway, harnessed } = await started({
      gateway: { DEFAULT_ASYNC_FULFILLMENT_MS: "40" },
    });
    const itemId = await publish(gateway, {
      ...esimCard,
      fulfill_deadline_seconds: undefined,
    });
    // The money moves at the purchase in this mode; the merchant takes the
    // order on and then lets the delivery window run out.
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
    // And nowhere on the page is the wire's own word for it. `refund_due` is
    // what a program branches on; a merchant reads a sentence.
    expect(text).not.toContain("refund_due");
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

    expect(text).toContain("goods were not released to the buyer");
    // The order is still open, which is the whole of what a merchant has to
    // know here: nothing is owed and nothing is theirs to do. What can still
    // happen to it — a fresh authorization on the same purchase, and the stored
    // goods released without a second fulfillment call — is the portal's, and
    // this page links there. What must never appear is the suggestion that the
    // buyer start again, which would deliver twice.
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
    // Both moments, which is the whole reason a receipt carries two of them.
    // "Price set" and not "Bought": the moment is when we fixed the price for
    // the sale, and on a card whose price is checked at the purchase the buyer
    // pays some time after that.
    expect(text).toContain("Price set");
    expect(text).toContain("Price true as of");
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    // And the moment the money actually moved, which is neither of those two
    // and is the column a merchant matches wallet transfers against.
    // Counted rather than named, because a header with no cell under it would
    // satisfy a check that only looked for the word: a receipt row carries
    // three moments, and dropping one leaves two.
    expect(text).toContain("Paid");
    const row = text.slice(text.indexOf("rcp_"));
    expect(row.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/g)).toHaveLength(3);
    // And the summary above the table, which counts what it can stand behind.
    expect(text).toContain("Delivered 1 of 1 receipt");
  });

  it("marks money that was never real as what it is", async () => {
    // Stage one marks every order as a test, so today this is every row on the
    // screen. A ledger of payments that never happened, laid out as a ledger of
    // payments, is the worst thing this page could be.
    const { browser, gateway, harnessed } = await started({
      cabinet: { FACILITATOR_URL: "https://x402.org/facilitator" },
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
    // The mark is on the sum itself as well as in the sentence above the
    // table. The sentence alone stops carrying it the moment one real payment
    // lands beside the tests, which is exactly when telling them apart starts
    // to matter.
    expect(receipts).toContain("80.00 USD test");
    expect(orders).toContain("80.00 USD test");
    // And it never calls the summary a record of takings.
    expect(receipts).not.toContain("paid in USD");
  });

  it("counts nothing it cannot count, and says what is missing instead", async () => {
    // This gateway writes a receipt only when goods are released, so a purchase
    // that has been paid for and not delivered has none. Any tile counting
    // those would read nought forever — and a nought is a positive claim that
    // there is none, printed on the screen a merchant reads for money they are
    // owed. The page says so in words and names where those orders are.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    const text = readable((await browser.get("/receipts")).html);

    expect(text).not.toContain("Refund due");
    expect(text).not.toContain("In progress");
    expect(text).not.toContain("nothing outstanding");
    // The sentence itself, not only the explanation under it. A page that says
    // nothing is missing and then explains what is missing has still told a
    // merchant, in the line they will actually read, that this is the money.
    expect(text).toContain("This is not the whole of the money");
    expect(text).toContain("has no receipt yet");
    expect(text).toContain("Both are on Orders");
  });

  it("does not claim a receipt appears when the money moves", async () => {
    // The sentence this replaces was falsified by the money path itself: in the
    // asynchronous mode the payment executes at the purchase and the receipt is
    // written only when the goods go out, so a merchant told otherwise looks
    // for a payment on a page that cannot show it yet.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, esimCard);
    await buyOverHttp(harnessed, gateway, itemId, { onOrder: () => ({ accepted: {} }) });
    await browser.signIn();

    const text = readable((await browser.get("/receipts")).html);

    // The money moved at the purchase and there is no receipt for it.
    expect((await gateway.call("GET", "/v0/receipts", { headers: asMerchant })).body).toStrictEqual(
      {
        receipts: [],
      },
    );
    expect(text).not.toContain("the moment a payment goes through");
    expect(text).toContain("released");
    // And the orders screen does show it, which is where the receipts page says
    // to look.
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
    // Amounts are exact decimal strings on the wire precisely so that nothing
    // turns a price into a float. A total computed on this page would be the
    // one number on the screen that had been through one.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, roomCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await browser.signIn();

    const text = readable((await browser.get("/receipts")).html);

    expect(text).not.toMatch(/total/i);
    // The currencies present are a fact; a sum of them would be the one number
    // on the screen that had been through a float. "Priced" rather than "paid",
    // because in stage one none of it was paid with real money.
    expect(text).toContain("priced in USD");
  });
});

describe("the keys screen", () => {
  /**
   * The key the cabinet's own calls are made with, which is on no row here.
   *
   * The gateway answers a cabinet's `GET /v0/keys` with the keys the merchant
   * issued for their own code and names this one as `this_call` beside them —
   * an identifier that matches nothing in the list. So it is an identifier
   * here and not a row, which is what the screen is drawn against.
   */
  const CABINET_KEY = "key_the_cabinet_is_using";
  /** A key something is calling with, which is the ordinary row. */
  const NIGHTLY: MerchantKey = {
    id: "key_the_nightly_job",
    label: "the nightly job",
    created_at: "2026-08-20T09:00:00.000Z",
    last_used_at: "2026-08-27T02:15:00.000Z",
    disabled_at: null,
  };
  /** A key with no call recorded against it, which is two situations at once. */
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

  /** The three key routes answered by the test, the rest by the real gateway. */
  const withKeys = (
    listed: readonly MerchantKey[] = [NIGHTLY, ANOTHER, REVOKED],
  ): {
    readonly disabled: string[];
    readonly issued: string[];
    readonly client: (real: GatewayClient) => GatewayClient;
  } => {
    const disabled: string[] = [];
    const issued: string[] = [];
    const keys: MerchantKeyList = { keys: [...listed], this_call: CABINET_KEY };
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
    // ADR-0010 made a key a row so that one can be revoked without touching any
    // other. A list that quietly dropped the revoked ones would answer "which
    // key did I turn off last week" with silence, on the screen where that is
    // the question somebody has.
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
    // Every row here is a key the merchant issued for their own code, and the
    // key this cabinet calls with is not one of them — the gateway lists it
    // nowhere and names it beside the list instead. So there is no row this
    // screen has to leave a blank against: a control missing from one of them
    // would be a key the merchant could not revoke from the only page that
    // revokes keys.
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const page = (await browser.get("/keys")).html;

    expect(page).toContain(`/keys/${NIGHTLY.id}/disable`);
    expect(page).toContain(`/keys/${ANOTHER.id}/disable`);
    // And the identifier the gateway named beside the list is not treated as a
    // row: nothing on the page is drawn from it.
    expect(page).not.toContain(CABINET_KEY);
  });

  it("offers no control at all against a key that is already revoked", async () => {
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const page = (await browser.get("/keys")).html;

    expect(page).not.toContain(`/keys/${REVOKED.id}/disable`);
  });

  /**
   * What one key's row says in the column whose header this matches.
   *
   * Read through the header rather than by counting cells, so a column added
   * beside this one does not quietly move what is being read.
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
    // The column the screen is worth opening for: which of these keys is safe
    // to revoke. A key something is calling with says when, in the format every
    // other instant on these screens is written in.
    //
    // The empty one is where this screen can do harm. The gateway did not check
    // whether anybody has called with that key — it wrote down the calls it
    // saw — and a key older than the writing carries the same blank as a key
    // nobody has ever used. Nothing on the wire tells the two apart, so the
    // words must not either. Which words they are is a person's choice; that
    // they claim only a missing record is the promise, and "never" is the word
    // this cell reaches for when it forgets which of the two it may say.
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const page = (await browser.get("/keys")).html;
    const called = inColumn(page, NIGHTLY.id, /last/i);
    const quiet = inColumn(page, ANOTHER.id, /last/i);

    expect(called).toBe("2026-08-27 02:15:00 UTC");
    expect(quiet).not.toBe("");
    expect(quiet).toMatch(/record/i);
    expect(quiet).not.toMatch(/never/i);
    // And it is not the day the key was made wearing this column's hat. That is
    // the one instant the screen has to hand when it has no call to show, and
    // putting it here would be a date a merchant reads as a call — the exact
    // lie the migration refused to write into the row.
    expect(quiet).not.toBe(inColumn(page, ANOTHER.id, /made/i));
  });

  it("says under the table that an empty last call is two situations", async () => {
    // The words the removed field was carrying. A merchant reading "No calls
    // recorded" beside a key they issued in June has to be able to find out
    // that we began recording this recently and that their oldest keys show
    // the same thing either way — otherwise the honest phrase in the cell is
    // read as the confident one, which is where it started.
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const text = readable((await browser.get("/keys")).html);

    expect(text).toMatch(/began recording|started recording/i);
    expect(text).toMatch(/cannot tell you which|which it is/i);
  });

  it("issues a key, shows its secret once, and says that is the only time", async () => {
    // The same promise the command makes and for the same reason: nothing keeps
    // a readable copy, so a merchant who does not copy it has to issue another.
    // Saying so on the page is the difference between that being a nuisance and
    // being a surprise.
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
    // And it is gone from every page after it: the list is drawn from documents
    // that do not carry a secret at all.
    expect((await browser.get("/keys")).html).not.toContain(SECRET);
  });

  it("refuses to issue a key with no name, without asking the gateway", async () => {
    // A key with no name is a key nobody can tell from another, on the screen
    // whose whole job is telling them apart before revoking one.
    const keys = withKeys();
    const { browser } = await started({ client: keys.client });
    await browser.signIn();

    const refused = await browser.post("/keys", { label: "   " });

    expect(refused.status).toBe(400);
    expect(readable(refused.html)).toMatch(/name/i);
    expect(keys.issued).toStrictEqual([]);
  });

  it("disables one key and comes back to the list", async () => {
    // Answered with a redirect rather than a page, like every other switch
    // here, so that a merchant who reloads does not press it again.
    const keys = withKeys();
    const { browser } = await started({ client: keys.client });
    await browser.signIn();

    const off = await browser.post(`/keys/${ANOTHER.id}/disable`);

    expect(keys.disabled).toStrictEqual([ANOTHER.id]);
    expect(off.status).toBe(303);
    expect(off.to).toBe("/keys");
  });

  it("writes down who issued a key and who revoked one, and neither secret", async () => {
    // Every action that changes something names the person who did it. Issuing and revoking a key are two of the most consequential, and the
    // secret itself must not travel with the sentence — a log goes places the
    // database does not.
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
    // A key's name is one line — the contract refuses a line break in it, and
    // the cabinet asks that rule before it logs or sends anything — so a name
    // carrying a newline and a plausible sentence after it is refused rather
    // than put into the one record of who did what, in this cabinet's voice.
    // What a name may still carry is a character that changes how the line
    // around it is drawn, such as a right-to-left override, and that is shown
    // rather than obeyed.
    const said: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...parts) => said.push(parts.map(String).join(" ")));
    try {
      const keys = withKeys();
      const { browser } = await started({ client: keys.client });
      await browser.signIn();

      const refused = await browser.post("/keys", {
        label: "a worker\n[cabinet] someone.else@example.com stopped all selling",
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
    // The rules about which keys can be switched off live in the route, and the
    // screen drawing a control is a courtesy rather than the guard. A merchant
    // who reaches the address by hand — for a key that is another merchant's,
    // or one that never existed — is told what the gateway answered rather than
    // being shown a page that says nothing happened. Against the real gateway,
    // so the sentence on the page is the gateway's own and not a test's idea of
    // it.
    const { browser } = await started();
    await browser.signIn();

    const refused = await browser.post("/keys/key_nobody_has/disable");

    expect(refused.status).toBe(404);
    expect(readable(refused.html)).toContain("there is no such key");
  });

  it("draws a working screen for a merchant who has issued no keys of their own", async () => {
    // The first screen every merchant registered through the form sees. The
    // cabinet does not sign in with a key from this list and never has one
    // here, so an empty list is the ordinary state of somebody who has not put
    // Agentify into their own code yet — and a page telling them their own
    // starting state cannot happen is a page that has lied to every new
    // merchant. Against the real gateway, because "the list is empty" is the
    // gateway's answer and not this test's.
    const { browser } = await started({ gateway: { REGISTRATION_INVITATION: INVITATION } });
    await browser.signIn(FRESH.email);
    await browser.makeMerchant();

    const seen = await browser.get("/keys");
    const text = readable(seen.html);

    expect(seen.status).toBe(200);
    expect(text).not.toMatch(/cannot happen/i);
    // A screen and not a dead end: the one control that gets a merchant out of
    // this state is on it.
    expect(seen.html).toContain('action="/keys"');
    // And it does not count rows that are not there as though some of them
    // worked.
    expect(text).not.toMatch(/\b0 of the 0\b/);
  });
});

describe("what every screen says about the address", () => {
  it("carries the signed-in address and a sign-out in the header bar of every working screen", async () => {
    // ADR-0026 §3: when a person is signed in, the header of the cabinet's
    // pages carries their address and a sign-out, as the scanner's header
    // does, so the site reads as one product with one session.
    const { browser } = await started();
    await browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts", "/keys", "/settings"]) {
      const answered = await browser.get(path);
      // A page carrying a person's address is never stored by a shared cache
      // (ADR-0026 §3).
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
   * A cabinet whose gateway answers however this test says.
   *
   * The three paths below cannot be reached through a real gateway: it cannot
   * be made to turn away a key it has just accepted, and it cannot be made to
   * answer in a shape its own contract refuses. `buildApp` takes the client as
   * a parameter for exactly this, and what is asserted is the page the merchant
   * lands on — the seam is scaffolding, not the subject.
   */
  const cabinetAnswering = async (
    reply: () => Promise<Answer<never>>,
  ): Promise<{ browser: Browser; close: () => Promise<void> }> => {
    const answer = async () => await reply();
    const config = loadConfig({
      GATEWAY_URL: "http://127.0.0.1:1",
      DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
      AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "sandbox:scripted",
      REGISTRATION_INVITATION: "the-existing-gateway-process-secret",
    });
    const messages: Message[] = [];
    const { identity, rows } = await withIdentity(config, async (message) => {
      messages.push(message);
      return "accepted";
    });
    const app = buildApp(config, {
      identity,
      gatewayFor: () =>
        ({
          cards: answer,
          pauseCard: answer,
          setSelling: answer,
          orders: answer,
          receipts: answer,
          sellerName: answer,
          setSellerName: answer,
          payoutWallet: answer,
          // The two the sign-in makes about this cabinet's own key answer the
          // same way as everything else here. A merchant whose gateway is
          // refusing every call is refused these too, and what the tests below
          // are about is the page they land on afterwards — so the sign-in that
          // gets them there has to survive it.
          issueCabinetKey: answer,
          forgetCabinetKey: answer,
        }) as never,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      browser: await attachedTo(`http://127.0.0.1:${port}`, "", () => messages.at(-1), rows),
      close: async () => {
        await identity.close();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
      },
    };
  };

  it("does not sign a person out when it is the cabinet's own key the gateway refuses", async () => {
    // The key is the cabinet's configuration now, not the person's password
    // (ADR-0014 §2). Signing them out over a 401 would send them to type a
    // password that cannot fix it, and they would land straight back here — a
    // loop with no way out and nothing said about the actual fault.
    const { browser, close } = await cabinetAnswering(async () => ({
      ok: false,
      status: 401,
      why: "this call is behind the merchant's key",
    }));
    try {
      const met = await browser.signIn();

      expect(met.status).toBe(502);
      const text = readable(met.html);
      expect(text).toMatch(/key/i);
      expect(text).not.toContain("Sign in");
      // Still signed in: the person is fine, the cabinet is not.
      expect(browser.sessionToken()).not.toBeNull();
      expect(met.headers.getSetCookie().join(" ")).not.toContain(`${COOKIE}=;`);
    } finally {
      await close();
    }
  });

  it("does not tell a merchant nothing was changed when it cannot know that", async () => {
    // A call that reached the gateway, did what it was asked, and answered in a
    // shape the contract does not recognise lands on the error page. The pause
    // has already happened; a page saying otherwise would send the merchant to
    // press it again.
    const { browser, close } = await cabinetAnswering(async () => {
      throw new Error("the answer was not a document this contract knows");
    });
    try {
      await browser.signIn();

      const answered = await browser.post("/selling/pause");

      expect(answered.status).toBe(500);
      const text = readable(answered.html);
      expect(text).toContain("Something in the cabinet is broken");
      expect(text).not.toContain("Nothing was changed");
    } finally {
      await close();
    }
  });

  it("says there is no such page rather than answering an address with nothing", async () => {
    // Only to somebody who is signed in. A stranger is told nothing about which
    // addresses exist here (ADR-0009 §2), which is the test above this one.
    const { browser } = await started();
    await browser.signIn();

    const answered = await browser.get("/nowhere");

    expect(answered.status).toBe(404);
    expect(readable(answered.html)).toContain("There is no such page");
  });

  it("treats a cookie it cannot read as nobody being signed in", async () => {
    // A cookie value that is not valid percent-encoding used to throw past
    // every route onto the error page — whose only control leads to a page that
    // throws again, with the cookie HttpOnly and no way to clear it from there.
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
    // A page on a sibling subdomain can set a cookie of this name on a broader
    // path, and the browser then sends two of them. The cabinet can only clear
    // the one on its own path, so a rule that refused on the mere presence of a
    // second would lock the merchant out for good — every redirect and every
    // fresh sign-in would meet the planted cookie again, and anybody able to
    // set a cookie could take away the control that stops their selling.
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
    // There is no cap on how many values under this name are considered, and
    // there must not be: a browser sends cookies of one name longest-path first
    // and then oldest first, so somebody able to plant them could push the
    // merchant's own past a cap and lock them out of the control that stops
    // their selling. A cap anywhere below what a request can actually carry
    // would pass a test built to a smaller number, so this one is built to the
    // runtime's own ceiling.
    //
    // That ceiling is why the request is written onto a socket by hand. Node
    // stops reading a request's headers at 16 KB; one cookie of this name and
    // shape is 99 bytes and the separator adds two, and a request carrying
    // nothing but a request line and a Host header buys 161 of them — measured
    // rather than worked out, and the arithmetic agrees. `fetch` sends headers
    // of its own — an accept, a user agent, an encoding — and buys fewer, so
    // what it would measure is those headers.
    //
    // What this costs is not what it used to. The old arrangement asked the
    // database about every value at once, in one query; the component looks a
    // session up one identifier at a time, and there is no batch to ask. What
    // stands in front of that is its signature: a value under this name that
    // was not signed with this cabinet's secret is refused before the store is
    // read at all, so a pile of planted junk is a pile of comparisons and not a
    // pile of queries. `identity.db-test.ts` measures that against a real
    // database, which is the only place a query can be counted honestly.
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
    // front of their own.
    expect(most.status).toBe(200);
    expect(most.body).toContain(PERSON);

    // And one more than that is not the cabinet's problem: the runtime refuses
    // to read the headers at all, so nothing here ever sees it.
    const tooMany = await overASocket(url, "/cards", carrying(162));

    expect(tooMany.status).toBe(431);
  });

  it("is one person's cabinet when both live cookies are that person's", async () => {
    // What a change of mount point leaves in a browser: the cookie from the old
    // path and the cookie from the new one, both this person's and both alive.
    // There is no ambiguity in that to refuse, and refusing it would end a
    // session the merchant is sitting in for a reason that is ours.
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
    // And neither session was ended on the way: both still work on their own.
    expect((await browser.withRawCookie(`${COOKIE}=${mine}`).get("/cards")).status).toBe(200);
    expect((await browser.withRawCookie(`${COOKIE}=${also}`).get("/cards")).status).toBe(200);
  });

  it("ends both sessions rather than choosing when they belong to two people", async () => {
    // The case where the ambiguity actually matters: working inside a session
    // somebody else opened would put the wrong person on the one record of who
    // stopped the selling. Nobody is signed in.
    //
    // And the sessions are ended, which is the half that decides whether this
    // rule is safe to have. The cabinet cannot take a cookie out of a browser —
    // a cookie set for a broader domain or a broader path survives everything
    // this process can send — so a rule that only refused would meet the
    // planted session again on every redirect and every fresh sign-in, and the
    // merchant would never reach the control that stops their selling again.
    // Ending them means the planted value stops being a session, and the next
    // sign-in works.
    const { browser, another, identity } = await started();
    await identity.make(OTHER, THE_MERCHANT);
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
    // Neither is a session any more, so the plant is spent rather than waiting.
    expect((await browser.withRawCookie(`${COOKIE}=${mine}`).get("/cards")).to).toBe(SESSION_ENDED);
    expect((await browser.withRawCookie(`${COOKIE}=${theirs}`).get("/cards")).to).toBe(
      SESSION_ENDED,
    );
    // And the merchant gets back in, which is the whole point of ending them:
    // the dead cookie is still in the browser and no longer decides anything.
    const back = await browser.signIn();
    expect(back.status).toBe(200);
    const carrying = await browser
      .withRawCookie(`${COOKIE}=${theirs}; ${COOKIE}=${browser.sessionToken() ?? ""}`)
      .get("/cards");
    expect(carrying.status).toBe(200);
    expect(readable(carrying.html)).toContain(PERSON);
  });

  it("turns away a form post that came from another site", async () => {
    // The session this form rides on can stop all selling. SameSite=Strict is
    // the main lock; this is the second, because SameSite is scoped to the
    // registrable domain and a sibling subdomain is "same site".
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();

    const forged = await browser.from("https://evil.example.com").post("/selling/pause");

    expect(forged.status).toBe(403);
    expect(await purchasable(gateway, itemId)).toBe(true);
  });

  it("lets a merchant in whatever the terminator in front of it says about the scheme", async () => {
    // The failure this pins happened on the first real deployment, and it made
    // the site unusable: a browser signing in at the public HTTPS origin was
    // told its form came from somewhere else. The check used to build the
    // origin it expected out of `X-Forwarded-Proto`, so whatever is in front
    // decided whether a merchant could sign in, and when that header did not
    // say what the browser said, every form post on the site was refused — the
    // sign-in included, which is a cabinet nobody can get into.
    //
    // The sign-in is what this drives for exactly that reason: it is the post
    // that has to work before any other one can. Each case below is a shape
    // that header can arrive in, and none of them may keep a merchant out.
    const { browser, url } = await started();
    const asHttps = `https://${new URL(url).host}`;
    const credentials = { email: PERSON };

    const behindTls = await browser
      .sending({ origin: asHttps, "x-forwarded-proto": "https" })
      .post("/sign-in", credentials);
    expect(behindTls.status).toBe(202);

    // The one that was actually broken: an https origin with nothing in the
    // request saying so. This is a terminator that sets no forwarded header,
    // and it used to be the refusal that locked the site.
    const nothingForwarded = await browser
      .sending({ origin: asHttps })
      .post("/sign-in", credentials);
    expect(nothingForwarded.status).toBe(202);

    // Run on its own with no terminator at all, which is how it is developed
    // and how every test here drives it.
    const onItsOwn = await browser
      .sending({ origin: `http://${new URL(url).host}` })
      .post("/sign-in", credentials);
    expect(onItsOwn.status).toBe(202);

    // A chain that terminates TLS early and disagrees with itself end to end.
    const throughAChain = await browser
      .sending({ origin: asHttps, "x-forwarded-proto": "https, http" })
      .post("/sign-in", credentials);
    expect(throughAChain.status).toBe(202);

    // And the scheme disagreeing outright, which the earlier version refused
    // and this one does not. What that costs is written where the check is: a
    // page on the http origin of the same host cannot carry a session anyway,
    // because the cookie is Secure wherever the cabinet is served over https.
    const overHttp = await browser
      .sending({ origin: `http://${new URL(url).host}`, "x-forwarded-proto": "https" })
      .post("/sign-in", credentials);
    expect(overHttp.status).toBe(202);
  });

  it("still refuses a form from another host, whatever it claims about the scheme", async () => {
    // The negative control for the test above. Loosening the check to the host
    // must not loosen it to everybody: this is the reason the check exists at
    // all, because SameSite is scoped to the registrable domain and a sibling
    // subdomain is "same site" to it.
    const { browser, url } = await started();
    const credentials = { email: PERSON };

    for (const origin of [
      "https://evil.example.com",
      // A sibling subdomain, which SameSite would let through.
      `https://elsewhere.${new URL(url).hostname}`,
      // The host as a prefix of a longer one, which a text comparison that
      // used `startsWith` would wave through.
      `https://${new URL(url).hostname}.evil.example.com`,
      // An opaque origin, which a sandboxed document sends.
      "null",
    ]) {
      const forged = await browser.sending({ origin }).post("/sign-in", credentials);
      expect(forged.status, origin).toBe(403);
      expect(readable(forged.html), origin).toContain("did not come from the cabinet");
    }
  });

  it("writes down what it compared, because the other person it refuses is honest", async () => {
    // This refusal reaches two people. One is guessing, and the page tells them
    // nothing on purpose. The other is a merchant who did nothing wrong and now
    // cannot sign in, and until this line existed there was no way to tell the
    // two apart — the check turned an honest browser away on the live site and
    // the only evidence anywhere was a screenshot somebody sent.
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
      // Both halves of the comparison, because either one alone leaves the
      // reader guessing which of the two was wrong.
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
    // one of them means the merchant should do something.
    const { browser, gateway, stopGateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    await stopGateway();

    const answered = await browser.get("/cards");

    expect(answered.status).toBe(502);
    expect(readable(answered.html)).toContain("The gateway did not answer");
  });
});

describe("a session that is ended while somebody is looking at a page", () => {
  it("stops the open tab from doing anything, and does not do what it asked", async () => {
    // The reason a session is a row at all (ADR-0009 §6). Before this, ending
    // one meant rotating the merchant's key — which also stops the merchant's
    // own code, in the same instant.
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
    // The negative control is the fact rather than the answer: the switch the
    // tab pressed did not move.
    expect(await purchasable(gateway, itemId)).toBe(true);
    expect((await browser.get("/cards")).to).toBe("/sign-in");
  });

  it("leaves the person's other session alone", async () => {
    // One session at a time is the promise. Ending every one of them at once is
    // what the merchant key already did, and it is what this replaces.
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
    // Thirty days from the last visit. The cookie in the browser is untouched
    // and still carries a good signature; what has run out is the row, and the
    // row is what decides.
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

describe("what the cabinet writes down about entry", () => {
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

describe("the key the cabinet signs in with", () => {
  /**
   * A merchant who registered for themselves, whose row holds a real key made
   * for a cabinet.
   *
   * Every other account in this file was seeded with the harness's own key,
   * which is one of the merchant's own — a shape no way in makes, and one the
   * gateway refuses both of these calls to. So these tests sign in and press,
   * against the real gateway, and what comes back onto the row is the real
   * thing.
   */
  const aRegisteredMerchant = async (over: Starting = {}): Promise<Running> => {
    const running = await started({
      ...over,
      gateway: { REGISTRATION_INVITATION: INVITATION, ...over.gateway },
    });
    await running.browser.signIn(FRESH.email);
    const made = await running.browser.makeMerchant();
    if (made.status !== 200) {
      throw new Error(`the passwordless entry did not go through: ${made.status}`);
    }
    return running;
  };

  /** The key the cabinet would call as this person with, off their row. */
  const keyOnTheRowOf = (email: string): string => {
    const row = (open?.rows.cabinet_accounts ?? []).find((one) => one.email === email);
    const key = row?.merchantKey;
    if (typeof key !== "string" || key === "") {
      throw new Error(`there is no account for ${email} with a key on it`);
    }
    return key;
  };

  /**
   * Whether the gateway still takes that key, asked of the gateway itself.
   *
   * Not "is it on a row" and not "did the cabinet think it worked": a key is
   * alive or dead at the gateway, and that is the fact both halves of this turn
   * on — the one that got somebody in has to work, and the one before it has to
   * have stopped.
   */
  const theGatewayTakes = async (key: string): Promise<boolean> =>
    (await gatewayFor(open?.gateway.url ?? "", key).keys()).ok;

  /** Everything the process said while `during` ran. */
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

  it("writes a key made a moment ago onto the row, over the one that was there", async () => {
    // ADR-0014 §2. A copy of this cabinet's database is a set of keys, and this
    // is what decides how long they are worth having: until the person they
    // belong to signs in again.
    const { another } = await aRegisteredMerchant();
    const before = keyOnTheRowOf(FRESH.email);

    const device = await another();
    const written = await said(async () => {
      await device.signIn(FRESH.email);
    });

    const now = keyOnTheRowOf(FRESH.email);
    expect(now).not.toBe(before);
    // And it is a key, not a string that looks like one: the gateway takes it.
    expect(await theGatewayTakes(now)).toBe(true);
    // Neither of them is written down anywhere on the way. ADR-0014 §2 makes
    // the row the one place this value lives, and a sign-in that put a working
    // key into the log would be the credential loose in the one place a
    // database is not — a log goes to a terminal, a file, whatever collects it.
    expect(written).not.toContain(before);
    expect(written).not.toContain(now);
  });

  it("renews the key at the first request of a day on a live session, and forgets the old one", async () => {
    // ADR-0014 §2. A session lasts thirty days from the last visit, and without
    // a daily renewal a key copied out of this database would last as long as
    // its person kept coming back. The first request of a day is the one that
    // moves the session's end, and it is the one that replaces the key.
    const { browser } = await aRegisteredMerchant();
    const before = keyOnTheRowOf(FRESH.email);
    const aDayAndAnHourAgo = Date.now() - 25 * 60 * 60 * 1_000;
    for (const session of sessionRows()) {
      session.expiresAt = new Date(aDayAndAnHourAgo + THIRTY_DAYS_SECONDS * 1_000);
    }

    const visited = await browser.get("/cards");

    // The page is drawn, which means it was drawn with the key that works.
    expect(visited.status).toBe(200);
    const now = keyOnTheRowOf(FRESH.email);
    expect(now).not.toBe(before);
    expect(await theGatewayTakes(now)).toBe(true);
    expect(await theGatewayTakes(before)).toBe(false);
  });

  it("renews the key when the first reading of a day is the scanner's question about a cookie", async () => {
    // A person who spends the day on reports is on a live session too, and the
    // scanner's question is where that session is read (ADR-0026 §2). A day's
    // first reading that did not renew the key would leave it to live as long
    // as the person kept visiting only reports.
    const running = await aRegisteredMerchant();
    const before = keyOnTheRowOf(FRESH.email);
    const secret = "d".repeat(49);
    const internal = buildReportIdentityApp(
      secret,
      running.identity,
      keyRenewal(running.identity, (key, within) => gatewayFor(running.gateway.url, key, within)),
    ).listen(0, "127.0.0.1");
    await new Promise<void>((ready) => internal.once("listening", ready));
    const { port } = internal.address() as AddressInfo;
    const ask = async (renew: boolean) =>
      await fetch(`http://127.0.0.1:${port}${REPORT_IDENTITY_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({
          operation: "session",
          cookie: `${COOKIE}=${running.browser.sessionToken() ?? ""}`,
          renew,
        }),
      });
    try {
      const aDayAndAnHourAgo = Date.now() - 25 * 60 * 60 * 1_000;
      for (const session of sessionRows()) {
        session.expiresAt = new Date(aDayAndAnHourAgo + THIRTY_DAYS_SECONDS * 1_000);
      }

      expect((await ask(false)).status).toBe(200);
      expect(keyOnTheRowOf(FRESH.email)).toBe(before);

      expect((await ask(true)).status).toBe(200);
      // The scanner is answered first and the key is renewed after, so a slow
      // gateway never costs the browser its renewed cookie.
      await vi.waitFor(() => expect(keyOnTheRowOf(FRESH.email)).not.toBe(before));
      const now = keyOnTheRowOf(FRESH.email);
      expect(now).not.toBe(before);
      expect(await theGatewayTakes(now)).toBe(true);
      await vi.waitFor(async () => expect(await theGatewayTakes(before)).toBe(false));
    } finally {
      await new Promise<void>((done) => internal.close(() => done()));
    }
  });

  it("leaves the key alone on a second request inside the same day", async () => {
    const { browser } = await aRegisteredMerchant();
    const before = keyOnTheRowOf(FRESH.email);

    expect((await browser.get("/cards")).status).toBe(200);
    expect((await browser.get("/orders")).status).toBe(200);

    expect(keyOnTheRowOf(FRESH.email)).toBe(before);
    expect(await theGatewayTakes(before)).toBe(true);
  });

  it("takes the key that was on the row away, and spares the one that replaced it", async () => {
    // Forgetting the old key is the half that makes the replacement worth
    // anything: a key left behind at every sign-in is a pile of live
    // credentials nobody is holding. What it must never take is the key that
    // is now on the row.
    const { another } = await aRegisteredMerchant();
    const before = keyOnTheRowOf(FRESH.email);

    const device = await another();
    await device.signIn(FRESH.email);

    expect(await theGatewayTakes(before)).toBe(false);
    expect(await theGatewayTakes(keyOnTheRowOf(FRESH.email))).toBe(true);
  });

  it("leaves the browser that was already signed in able to go on working", async () => {
    // Two devices, one account. The key is read off the row on every request
    // rather than kept anywhere, so the session that was open before the swap
    // reaches the gateway with the key the swap wrote — it does not have to
    // notice that anything happened.
    const { browser, another } = await aRegisteredMerchant();

    const device = await another();
    await device.signIn(FRESH.email);

    const seen = await browser.get("/keys");
    expect(seen.status).toBe(200);
  });

  it("lets a person in on the key they had when no fresh one could be made", async () => {
    // The first of the three steps, cut. Nothing was made, so nothing is
    // written and nothing is forgotten: they sign in as they always did, and
    // the gateway being unwell is not allowed to be a locked door.
    const { another } = await aRegisteredMerchant({
      client: (real) => ({
        ...real,
        issueCabinetKey: async () => ({ ok: false, status: 0, why: "nothing answered" }),
      }),
    });
    const before = keyOnTheRowOf(FRESH.email);

    const device = await another();
    const inside = await device.signIn(FRESH.email);

    expect(inside.status).toBe(200);
    expect(keyOnTheRowOf(FRESH.email)).toBe(before);
    expect(await theGatewayTakes(before)).toBe(true);
  });

  it("clears up after itself, and not after the sign-in that won, when the write is lost", async () => {
    // The second step, lost rather than broken, which is what a sign-in beaten
    // to the row by another one meets. The key on the row belongs to whoever
    // won and must not be touched; the key this sign-in made is on no row and
    // can never reach one, so it is exactly what this sign-in has to put beyond
    // use. Getting this backwards is the whole locked-out failure: forget the
    // key on the row and its owner has nothing left that works.
    const madeHere: string[] = [];
    const { another } = await aRegisteredMerchant({
      identity: (real) => ({ ...real, replaceMerchantKey: async () => "not-matched" }),
      client: (real) => ({
        ...real,
        issueCabinetKey: async () => {
          const made = await real.issueCabinetKey();
          if (made.ok) {
            madeHere.push(made.document);
          }
          return made;
        },
      }),
    });
    const before = keyOnTheRowOf(FRESH.email);

    const device = await another();
    const inside = await device.signIn(FRESH.email);

    expect(inside.status).toBe(200);
    expect(keyOnTheRowOf(FRESH.email)).toBe(before);
    expect(await theGatewayTakes(before)).toBe(true);
    // And the key it made and could not use is gone rather than left alive for
    // nobody.
    expect(madeHere).toHaveLength(1);
    expect(await theGatewayTakes(madeHere[0] ?? "")).toBe(false);
    // The screens really are drawn, which is the same fact from the other side:
    // the cabinet reaches the gateway with what is on the row.
    expect((await device.get("/keys")).status).toBe(200);
  });

  it("keeps the fresh key when forgetting the old one is the step that failed", async () => {
    // The third step, cut. The row names the key that was just made and it
    // works; the old one is still alive, which is one credential nobody holds
    // and nothing will come back for — the price of a call that cannot reach
    // anybody else's key, and cheaper than the lockout that price buys off.
    const { another } = await aRegisteredMerchant({
      client: (real) => ({
        ...real,
        forgetCabinetKey: async () => ({ ok: false, status: 0, why: "nothing answered" }),
      }),
    });
    const before = keyOnTheRowOf(FRESH.email);

    const device = await another();
    const inside = await device.signIn(FRESH.email);

    expect(inside.status).toBe(200);
    const now = keyOnTheRowOf(FRESH.email);
    expect(now).not.toBe(before);
    expect(await theGatewayTakes(now)).toBe(true);
  });

  it("revokes neither key when the conditional write outcome is unknown", async () => {
    const issued: string[] = [];
    const { another } = await aRegisteredMerchant({
      identity: (real) => ({
        ...real,
        replaceMerchantKey: async (...asked: Parameters<Identity["replaceMerchantKey"]>) => {
          await real.replaceMerchantKey(...asked);
          return "unknown";
        },
      }),
      client: (real) => ({
        ...real,
        issueCabinetKey: async () => {
          const made = await real.issueCabinetKey();
          if (made.ok) issued.push(made.document);
          return made;
        },
      }),
    });
    const before = keyOnTheRowOf(FRESH.email);
    const device = await another();

    const written = await said(async () => {
      expect((await device.signIn(FRESH.email)).status).toBe(200);
    });

    expect(issued).toHaveLength(1);
    expect(keyOnTheRowOf(FRESH.email)).toBe(issued[0]);
    expect(await theGatewayTakes(before)).toBe(true);
    expect(await theGatewayTakes(issued[0] ?? "")).toBe(true);
    expect(written).toMatch(/could not establish whether/i);
    expect(written).not.toContain(before);
    expect(written).not.toContain(issued[0] ?? "missing fresh key");
  });

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

  it("signs a person in with the gateway not there at all, and writes down why", async () => {
    // Nothing about signing in belongs to the gateway: the link, the session
    // and the row are all this cabinet's. A person shut out of their
    // own account because a service they never asked about is down would be
    // this replacement costing more than it buys. The line in the log is how
    // anybody finds out the key has stopped being replaced.
    const { browser, mails, url } = await started({
      cabinet: { GATEWAY_URL: "http://127.0.0.1:1" },
    });

    const posted: Visit[] = [];
    const written = await said(async () => {
      await browser.post("/sign-in", { email: PERSON });
      const action = actionIn(mails.at(-1));
      posted.push(
        await browser.from(url).post(action.pathname, {
          token: action.searchParams.get("token") ?? "",
        }),
      );
    });

    expect(posted[0]?.status).toBe(303);
    expect(keyOnTheRowOf(PERSON)).toBe(KEY);
    expect(written).toMatch(/key/i);
    expect(written).not.toContain(PERSON);
    // And what it says about it is never the key itself.
    expect(written).not.toContain(KEY);
  });

  /**
   * One sign-in, stopped at a step until the test lets it go.
   *
   * Two of these are what makes a race a test rather than a hope: the two
   * sign-ins below are made to interleave at exactly the moment that decides
   * whether anybody is locked out, instead of being started together and
   * watched.
   */
  interface Step {
    readonly reached: Promise<void>;
    readonly arrive: () => void;
    readonly go: Promise<void>;
    readonly release: () => void;
  }

  const aStep = (): Step => {
    let arrive: () => void = () => undefined;
    let release: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const go = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { reached, arrive: () => arrive(), go, release: () => release() };
  };

  it("leaves a working key on the row when one sign-in runs inside another", async () => {
    // The second interleaving, and the one a conditional write alone does not
    // reach. The first sign-in wins the row and is then held between writing
    // and putting its old key beyond use. The second signs in inside that gap:
    // it reads the key the first just wrote, gets one of its own, and wins its
    // own write honestly, because by then the row does hold what it read. If
    // the first is able to reach anything but the key in its own hand, it takes
    // away the key the second has just written — and the account is left naming
    // something the gateway has forgotten, with no way back in but a terminal.
    //
    // Its own timeout, and shorter than the file's: the two sign-ins are held
    // in front of each other on purpose, so an arrangement that never lets one
    // of them go fails by waiting rather than by an assertion. The gateway is
    // in this process, so ten seconds is not a slow machine — it is a deadlock.
    const first = aStep();
    let held = false;
    const { another } = await aRegisteredMerchant({
      client: (real) => ({
        ...real,
        forgetCabinetKey: async () => {
          if (!held) {
            held = true;
            first.arrive();
            await first.go;
          }
          return await real.forgetCabinetKey();
        },
      }),
    });

    const a = await another();
    const b = await another();

    // The first device signs in and stops with the row already moved onto its
    // fresh key, holding the old one and not yet done with it.
    const signingInA = a.signIn(FRESH.email);
    await first.reached;

    // The second signs in from end to end inside that gap.
    await b.signIn(FRESH.email);

    first.release();
    await signingInA;

    expect(await theGatewayTakes(keyOnTheRowOf(FRESH.email))).toBe(true);
  }, 10_000);

  it("leaves a working key on the row when two sign-ins race for it", async () => {
    // Two devices, or a form posted twice. Both sign-ins read the same key off
    // the row, so both believe they are replacing it. Only one can, and the
    // other must not go on as though it had: a sign-in that wrote nothing and
    // then put the row's key beyond use would leave the account holding
    // something the gateway has forgotten. Nothing after that helps — every
    // screen answers 502, and signing in again asks for a fresh key with the
    // one being refused, so the way back in is a terminal.
    //
    // What is asserted is not who won. It is the only thing anybody is locked
    // out by: the key the row names opens the gateway's door.
    //
    // Its own timeout, and shorter than the file's, for the reason the test
    // beside it has one: the two sign-ins are held in front of each other on
    // purpose, so an arrangement that never lets one of them go fails by
    // waiting rather than by an assertion. The gateway is in this process, so
    // ten seconds is not a slow machine — it is a deadlock.
    const first = aStep();
    const second = aStep();
    let stopped = 0;
    const stopHere = async (): Promise<void> => {
      const mine = stopped === 0 ? first : second;
      stopped += 1;
      mine.arrive();
      await mine.go;
    };

    const { another } = await aRegisteredMerchant({
      identity: (real) => ({
        ...real,
        replaceMerchantKey: async (...asked: Parameters<Identity["replaceMerchantKey"]>) => {
          await stopHere();
          return await real.replaceMerchantKey(...asked);
        },
      }),
    });

    const a = await another();
    const b = await another();

    // The first device signs in, asks the gateway for a key of its own, and
    // stops in front of the row.
    const signingInA = a.signIn(FRESH.email);
    await first.reached;

    // The second signs in while the row still says what the first read. It gets
    // a key of its own too, and stops in the same place.
    const signingInB = b.signIn(FRESH.email);
    await second.reached;

    // The first goes through: it moves the row onto its key and puts the key it
    // arrived with beyond use.
    first.release();
    await signingInA;

    // And now the second writes.
    second.release();
    await signingInB;

    expect(await theGatewayTakes(keyOnTheRowOf(FRESH.email))).toBe(true);
  }, 10_000);

  it("does not call a key written when there was no account to write it onto", async () => {
    // What forgetting a key is allowed to happen after. The store takes a write for a
    // row it does not have and changes nothing — no throw, nothing to notice —
    // and a caller that read that as "written" would go on to forget the key
    // the row still names, taking away the only one that works. So the answer
    // is read back from what the write returned rather than from its silence.
    const { identity } = await started();

    expect(await identity.replaceMerchantKey("no-such-account", KEY, "a-key-long-enough")).toBe(
      "not-matched",
    );
  });

  it("refuses the write when the row stopped holding the key that was read off it", async () => {
    // The write and the choice of which key this sign-in has finished with are
    // one act, and this is where they are joined: the row moves from the key
    // that was read to the fresh one, or it does not move at all. Two sign-ins
    // holding the same read cannot both win, so the one that loses knows the
    // key it is done with is its own — which is the whole of what keeps it from
    // taking away the winner's.
    const { identity } = await started();
    const person = await identity.byEmail(PERSON);

    const won = await identity.replaceMerchantKey(person?.id ?? "", KEY, "the-first-fresh-key");
    const lost = await identity.replaceMerchantKey(person?.id ?? "", KEY, "the-second-fresh-key");

    expect(won).toBe("replaced");
    expect(lost).toBe("not-matched");
    // And the loser really did not write: the row still holds the winner's key
    // rather than the last one that was tried.
    expect(keyOnTheRowOf(PERSON)).toBe("the-first-fresh-key");
  });

  it("lets a person in when the gateway answers something the contract refuses", async () => {
    // The third way this can go wrong, and the only one that arrives as a
    // throw: the client holds every answer to the contract's schema, so a
    // gateway answering a key document with no key in it raises rather than
    // returning a refusal. `gateway.test.ts` holds that it raises; this holds
    // that a person signing in never finds out.
    const { another } = await aRegisteredMerchant({
      client: (real) => ({
        ...real,
        issueCabinetKey: async () => {
          throw new Error("the answer was not a document this contract knows");
        },
      }),
    });
    const before = keyOnTheRowOf(FRESH.email);

    const device = await another();
    const inside = await device.signIn(FRESH.email);

    expect(inside.status).toBe(200);
    expect(keyOnTheRowOf(FRESH.email)).toBe(before);
    expect(await theGatewayTakes(before)).toBe(true);
  });

  it("does not spend a screen's worth of waiting on a gateway that says nothing", async () => {
    // The worst case: the connection is accepted and then held open. A screen
    // gets ten seconds before the cabinet gives up, because somebody is looking
    // at it and would rather wait than reload. A sign-in is not that — the two
    // calls behind it are the cabinet looking after its own credential, and
    // nobody asked for them — so the wait is its own, and shorter.
    const { browser, mails, url } = await started({
      cabinet: { GATEWAY_URL: await silentGateway() },
    });

    await browser.post("/sign-in", { email: PERSON });
    const action = actionIn(mails.at(-1));
    const began = Date.now();
    const posted = await browser.from(url).post(action.pathname, {
      token: action.searchParams.get("token") ?? "",
    });
    const took = Date.now() - began;

    expect(posted.status).toBe(303);
    expect(took).toBeLessThan(9_000);
  }, 30_000);
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
  // On the live deployment a replacement wallet is announced to every account
  // naming the merchant and waits forty-eight hours (ADR-0019). The message
  // says the change takes effect only if the wallet screen shows it, so the
  // screen has to show it — the address that waits and the moment — and has
  // to be where the change is cancelled, by a person signed in, with one
  // press.
  const LIVE_CABINET = {
    PAYMENT_NETWORK: "eip155:8453",
    FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  };
  const LIVE_GATEWAY = {
    ...LIVE_CABINET,
    CDP_API_KEY_ID: "key-id",
    CDP_API_KEY_SECRET: "key-secret",
    ...ANNOUNCING,
  };
  const WAITING = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
  /** A third address, for a change that lands in between. */
  const OVERTAKING = "0x0000000000000000000000000000000000000007";

  /**
   * What the cancel form on a settings screen sends: every field it carries,
   * as the page was drawn. A browser posts what the page it was showing held,
   * which is the point of the form carrying the change it showed.
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

  /** What the box's own form sends besides the address, as the page was drawn. */
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

  /**
   * A cabinet in front of a live gateway. A live door refuses a key carrying
   * the test prefix, which is what this file's accounts hold, so every test
   * here puts a cabinet key that gateway made on the rows before signing in.
   */
  const live = async (options: Starting = {}): Promise<Running> =>
    await started({ ...options, gateway: LIVE_GATEWAY, cabinet: LIVE_CABINET });

  /**
   * A replacement asked for from another session of the cabinet, on a key of
   * its own: the session somebody forgot to sign out of, or never owned.
   */
  const aChangeWaits = async (running: Running): Promise<void> => {
    const elsewhere = await running.harnessed.addCabinetKey(running.harnessed.merchant.id);
    const asked = await running.gateway.call("POST", "/v0/payout-wallet", {
      body: { payout_wallet: WAITING },
      headers: { authorization: `Bearer ${elsewhere}` },
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
  };

  /** The address a payment request names right now, as the gateway answers it. */
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

  it("shows the address waiting, the moment it takes effect, and a control to cancel it", async () => {
    const running = await live();
    await onACabinetKey(running);
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
    await onACabinetKey(running);
    await running.browser.signIn();

    const screen = await running.browser.get("/settings");

    expect(screen.html).not.toContain('action="/settings/payout-wallet/cancel"');
  });

  it("cancels with one press, keeps the session that pressed, and signs every other session of the merchant out", async () => {
    const running = await live();
    await running.identity.make(OTHER, THE_MERCHANT);
    await onACabinetKey(running);
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
    // A session the person did not press from may be the one that asked for
    // the change, so it ends — theirs on another device, and every other
    // account's at the merchant.
    expect((await otherDevice.get("/settings")).to).toMatch(/^\/sign-in/);
    expect((await partner.get("/cards")).to).toMatch(/^\/sign-in/);
  });

  it("signs nobody out when the gateway would not cancel", async () => {
    // A real refusal from the real gateway: another change is recorded between
    // the gateway reading the wallet for this cancel and writing it, so the
    // cancel is refused as raced and nothing it asked for is written.
    const running = await live();
    await onACabinetKey(running);
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
    // The press that matters most: the unwanted change has just landed. It is
    // not cancelled — nothing can take it back at once — and the page must not
    // say it was; what it can do is sign every other session out and say how
    // the old address comes back.
    const said: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...parts) => said.push(parts.map(String).join(" ")));
    try {
      const running = await live();
      await onACabinetKey(running);
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
    // The narrower race: the cabinet read the change as waiting, and it took
    // effect before the gateway got the cancel. Asking for the old address is
    // then a change back, which waits and is announced — and the page and the
    // log say that rather than that anything was cancelled.
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
      await onACabinetKey(running);
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
    await onACabinetKey(running);
    await running.browser.signIn();
    await aChangeWaits(running);

    const pressed = await running.browser
      .from("https://elsewhere.example")
      .post("/settings/payout-wallet/cancel");

    expect(pressed.status).toBe(403);
    expect(await waitingNow(running)).not.toBeNull();
  });

  it("cancels a waiting change when the address paid now is typed in, and signs the others out", async () => {
    // The same act as the cancel control, reached through the box: the
    // gateway reads the address that applies now as a cancel. A cancel that
    // left the session which asked for the change signed in would leave it
    // free to ask again, and a page or a log that called it a change would
    // tell the person something else happened.
    const said: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...parts) => said.push(parts.map(String).join(" ")));
    try {
      const running = await live();
      // Paid at an address with letters in it, so the one typed back can be
      // in the other spelling a wallet may be written in, as a person pastes
      // it out of a block explorer.
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
      await onACabinetKey(running);
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

  it("tells an account holding a key of the merchant's own code that its key is of the wrong kind to cancel", async () => {
    const running = await live();
    for (const row of running.rows.cabinet_accounts ?? []) {
      if (row.merchantId === THE_MERCHANT.id) row.merchantKey = theMerchantKey("live");
    }
    await running.browser.signIn();
    await aChangeWaits(running);

    const pressed = await running.browser.post(
      "/settings/payout-wallet/cancel",
      fromTheScreen(await running.browser.get("/settings")),
    );

    expect(pressed.status).toBe(403);
    expect(readable(pressed.html)).toMatch(/wrong kind/i);
    expect(readable(pressed.html)).not.toMatch(/try again/i);
    expect(await waitingNow(running)).toMatchObject({ payout_wallet: WAITING });
  });

  it("says a change that took effect before the old address was typed back took effect, and signs the others out", async () => {
    // The box on a page drawn while a change waited, used after it took
    // effect: typing the address the page showed as paid is the same act as
    // pressing Cancel there, and has to be answered the same way rather than
    // as a new change that leaves the other sessions signed in.
    const said: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...parts) => said.push(parts.map(String).join(" ")));
    try {
      const running = await live();
      await onACabinetKey(running);
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
    await onACabinetKey(running);
    await running.browser.signIn();
    const otherDevice = await running.another();
    await otherDevice.signIn();

    const pressed = await running.browser.post("/settings/payout-wallet/cancel");

    expect(pressed.to).toBe("/settings");
    expect((await otherDevice.get("/settings")).status).toBe(200);
  });
});

describe("signing out every other device", () => {
  // The answer to a session that is not the owner's, wherever it was left
  // open (ADR-0026 §3, ADR-0019). It reaches this account's sessions and no
  // other account's, touches no key, and needs no wallet change to be waiting.

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
    // Opening a link from a browser already signed in replaces its session
    // rather than adding one beside it, so the count is of other places.
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
    await running.identity.make(OTHER, THE_MERCHANT);
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

describe("the wallet screen a message links to", () => {
  it("is where an ordinary sign-in lands a person who arrived signed out", async () => {
    // The message links plainly to the wallet screen and carries no token, so
    // a person reading it on a device with no session signs in the ordinary
    // way — and has to land on the screen the message sent them to.
    const running = await started();

    const arrived = await running.browser.get("/settings");
    expect(arrived.to).toBe("/sign-in?destination=settings");

    const requested = await running.browser.post("/sign-in", {
      email: PERSON,
      destination: "settings",
    });
    expect(requested.status).toBe(202);
    const found = /(https?:\/\/\S+)/.exec(running.mails.at(-1)?.body ?? "")?.[1] ?? "";
    const opened = await running.browser.post(new URL(found).pathname, {
      token: new URL(found).searchParams.get("token") ?? "",
    });
    expect(opened.to).toBe("/settings");
  });
});

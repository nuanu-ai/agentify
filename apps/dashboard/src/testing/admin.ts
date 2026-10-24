/**
 * The operator's workspace served over HTTP for its tests: the real gateway on
 * memory adapters with the operator's memory reader over its store, the real
 * sign-in component over its memory rows, and the pages compiled from source,
 * mounted under `/dashboard` as a deployment mounts them. A browser keeps its
 * cookies, marks every form it posts with the address it is signed in as, as
 * a page drawn for that address would, and follows nothing by itself.
 */

import type { AddressInfo } from "node:net";
import { memoryOperatorReader, type OperatorReader } from "@agentify/gateway/operator";
import { type Harness, harness } from "@agentify/gateway/testing";
import { memoryJournal } from "../admin/journal.js";
import { type DashboardConfig, loadConfig } from "../config.js";
import { DRAWN_FOR } from "../drawn-for.js";
import { type Identity, identityFor } from "../identity.js";
import type { Handover, Message } from "../mail.js";
import { buildApp } from "../server.js";
import { flagRow } from "./account-rows.js";
import { rewindLinkSends } from "./link-sends.js";
import { testPages } from "./pages.js";
import { TEST_AUTH_SECRET } from "./secrets.js";

export const ADMIN_BASE = "/dashboard";

/** The channels a test can open the workspace on. */
const CHANNELS = {
  test: { PAYMENT_NETWORK: "eip155:84532", FACILITATOR_URL: "sandbox:scripted" },
  live: {
    PAYMENT_NETWORK: "eip155:8453",
    FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  },
} as const;

interface Visit {
  readonly status: number;
  readonly headers: Headers;
  readonly html: string;
  /** Where a redirect leads; null where the answer is a page. */
  readonly to: string | null;
}

interface AdminBrowser {
  /** A path under the dashboard's prefix, without it. */
  get(path: string): Promise<Visit>;
  post(path: string, form?: Record<string, string>): Promise<Visit>;
}

export interface AdminServed {
  readonly harnessed: Harness;
  readonly identity: Identity;
  readonly config: DashboardConfig;
  /** The sign-in component's memory rows, for a test that puts a session in a state no route makes. */
  readonly rows: Record<string, Record<string, unknown>[]>;
  readonly mails: readonly Message[];
  /** A browser with no session. */
  visitor(): AdminBrowser;
  /** A browser signed in by a mailed link as `email`, its account made first where it has none. */
  signedIn(email: string, as?: Readonly<{ operator?: boolean }>): Promise<AdminBrowser>;
  /** Moves the moment every open session was signed in back by `ms`, as if it was signed in then. */
  ageSessions(ms: number): void;
  close(): Promise<void>;
}

export async function adminServed(
  options: Readonly<{
    channel?: keyof typeof CHANNELS;
    /** A decorator, for a test about an identity that fails; the rest goes to the real one. */
    identity?: (real: Identity) => Identity;
    /** A decorator, for a test about an operator's read that fails; the rest goes to the real one. */
    reader?: (real: OperatorReader) => OperatorReader;
    /** More of the dashboard's configuration, such as the channel's first operator. */
    environment?: Readonly<Record<string, string>>;
    /** What the mail provider answers a message; it takes every one where absent. */
    handOver?: (message: Message) => Handover;
  }> = {},
): Promise<AdminServed> {
  const channel = CHANNELS[options.channel ?? "test"];
  // The live channel's facilitator takes no request without credentials; these
  // reach nobody, since the harness's facilitator is scripted.
  const harnessed = await harness({
    ...channel,
    ...(options.channel === "live"
      ? { CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: "key-secret" }
      : {}),
  });
  const config = loadConfig({
    DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
    AUTH_SECRET: TEST_AUTH_SECRET,
    BASE_PATH: ADMIN_BASE,
    ...channel,
    ...options.environment,
  });
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
      return options.handOver?.(message) ?? "accepted";
    },
    journal: harnessed.store,
  });
  const served = options.identity === undefined ? identity : options.identity(identity);
  const app = buildApp(config, {
    pages: await testPages(),
    gateway: harnessed.gateway,
    identity: served,
    admin: {
      reader: (options.reader ?? ((real) => real))(memoryOperatorReader(harnessed.store)),
      journal: memoryJournal(harnessed.store),
      accounts: served,
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const browserOf = (who: string | null) => {
    const jar = new Map<string, string>();
    const call = async (method: string, path: string, form?: Record<string, string>) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
      const marked = form === undefined || who === null ? form : { [DRAWN_FOR]: who, ...form };
      const answered = await fetch(`${url}${ADMIN_BASE}${path}`, {
        method,
        redirect: "manual",
        headers: {
          ...(cookie === "" ? {} : { cookie }),
          ...(marked === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
        },
        ...(marked === undefined ? {} : { body: new URLSearchParams(marked).toString() }),
      });
      for (const line of answered.headers.getSetCookie()) {
        const pair = line.split(";")[0] ?? "";
        const at = pair.indexOf("=");
        if (at === -1) continue;
        const name = pair.slice(0, at).trim();
        const value = pair.slice(at + 1).trim();
        if (value === "") jar.delete(name);
        else jar.set(name, value);
      }
      return {
        status: answered.status,
        headers: answered.headers,
        html: await answered.text(),
        to: answered.headers.get("location"),
      };
    };
    return {
      jar,
      browser: {
        get: (path: string) => call("GET", path),
        post: (path: string, form: Record<string, string> = {}) => call("POST", path, form),
      } satisfies AdminBrowser,
    };
  };

  return {
    harnessed,
    identity,
    config,
    rows,
    mails,
    visitor: () => browserOf(null).browser,
    async signedIn(email, as = {}) {
      if ((await identity.byEmail(email)) === null) {
        const merchant = await harnessed.addMerchant(`Merchant of ${email}`);
        await identity.make(email, merchant.id);
      }
      flagRow(rows, email, as.operator === true);
      rewindLinkSends(rows);
      await identity.requestLink(email, "default", { client: "192.0.2.10" });
      const link = new URL(/(https?:\/\/\S+)/.exec(mails.at(-1)?.body ?? "")?.[1] ?? "");
      const opened = await identity.openLink(link.searchParams.get("token") ?? "");
      if (opened.status !== "opened") throw new Error("the test's sign-in link did not open");
      const { jar, browser } = browserOf(email);
      for (const line of opened.setCookies) {
        const pair = line.split(";")[0] ?? "";
        const at = pair.indexOf("=");
        if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
      }
      return browser;
    },
    ageSessions(ms) {
      for (const row of rows.dashboard_sessions ?? []) {
        row.createdAt = new Date(new Date(row.createdAt as Date).getTime() - ms);
      }
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await identity.close();
      await harnessed.stop();
    },
  };
}

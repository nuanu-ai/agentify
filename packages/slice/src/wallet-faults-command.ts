/**
 * A browser on the real dashboard in which Coinbase Wallet's window is a
 * stand-in that refuses, answers malformed, never answers, or answers after
 * the page gave up, as whoever sits at it chooses.
 *
 * The dashboard is not touched: its pages, its scripts and the Coinbase code
 * in them run as they are served. What changes is what the browser gives the
 * page. Every request to Coinbase's window address is answered with the
 * stand-in (`wallet-window.js`), every request to any other host but the
 * dashboard's is refused, and every other host name resolves to nothing, so
 * nothing in this browser reaches Coinbase or any other wallet service.
 *
 * After each answer the window gives, and whenever Enter is pressed, the
 * command prints a reading: what the page says beside its buttons, what the
 * payout wallet box holds, what Coinbase's code keeps in the page's storage,
 * and what the Settings page shows saved when loaded afresh.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { getAddress, isAddress } from "viem";

/** Where @base-org/account opens Coinbase Wallet's window. */
const COINBASE_WINDOW = new URL("https://keys.coinbase.com/connect");

/** Where Coinbase's code keeps the account it connected and its session keys. */
const SDK_STORE = "base-acc-sdk.store";

const TAKES = {
  "--dashboard":
    "the dashboard's address, http or https, with its base path and no query, such as http://localhost:8080/dashboard",
  "--address":
    "the EVM address the stand-in gives as the wallet's, one you hold, since a press of Save records it",
} as const;
type Flag = keyof typeof TAKES;

interface Plan {
  readonly dashboard: URL;
  readonly address: string;
}

type Read =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly why: string };

const isFlag = (token: string): token is Flag => Object.hasOwn(TAKES, token);

const refused = (why: string): Read => ({ ok: false, why });

/** The two flags, each refused in one sentence naming it. */
export const readPlan = (argv: readonly string[]): Read => {
  const given = new Map<Flag, string>();
  for (let at = 0; at < argv.length; at += 2) {
    const token = argv[at] ?? "";
    const value = argv[at + 1];
    if (!isFlag(token)) {
      const shown = token.startsWith("--") ? `"${token.replace(/=.*/s, "=…")}"` : "a bare value";
      return refused(
        `Expected --dashboard or --address, each followed by its value after a space, and got ${shown}.`,
      );
    }
    if (value === undefined || value.startsWith("--")) {
      return refused(`${token} needs a value after it: ${TAKES[token]}.`);
    }
    if (given.has(token)) return refused(`${token} is given twice.`);
    given.set(token, value);
  }
  for (const flag of Object.keys(TAKES) as Flag[]) {
    if (!given.has(flag)) return refused(`${flag} is required: ${TAKES[flag]}.`);
  }
  const named = given.get("--dashboard") ?? "";
  const dashboard = URL.canParse(named) ? new URL(named) : null;
  if (dashboard !== null && (dashboard.username !== "" || dashboard.password !== "")) {
    return refused("--dashboard must not carry a user name or password.");
  }
  if (
    dashboard === null ||
    (dashboard.protocol !== "http:" && dashboard.protocol !== "https:") ||
    dashboard.search !== "" ||
    dashboard.hash !== ""
  ) {
    return refused(`--dashboard takes ${TAKES["--dashboard"]}, and the value given is not one.`);
  }
  if (dashboard.origin === COINBASE_WINDOW.origin) {
    return refused("--dashboard names Coinbase's window, which this browser answers itself.");
  }
  const address = given.get("--address") ?? "";
  if (!isAddress(address)) {
    return refused(
      `--address takes ${TAKES["--address"]}: 0x and 40 hexadecimal characters, in one case or with a correct checksum.`,
    );
  }
  return { ok: true, plan: { dashboard, address: getAddress(address) } };
};

/**
 * What this browser does with a request: the dashboard's origin is reached,
 * Coinbase's window address is answered by the stand-in, and everything else
 * is refused before it leaves.
 */
export const destinationOf = (
  url: string,
  dashboard: URL,
): "dashboard" | "stand-in" | "refused" => {
  const asked = URL.canParse(url) ? new URL(url) : null;
  if (asked === null) return "refused";
  if (asked.origin === dashboard.origin) return "dashboard";
  if (asked.origin === COINBASE_WINDOW.origin && asked.pathname === COINBASE_WINDOW.pathname) {
    return "stand-in";
  }
  return "refused";
};

const HERE = dirname(fileURLToPath(import.meta.url));

const windowPage = (address: string, script: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wallet stand-in</title>
<style>
  body { font: 15px/1.45 system-ui, sans-serif; margin: 0; padding: 16px; background: #fff8e6; color: #222; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  h2 { font-size: 15px; margin: 0 0 4px; font-family: ui-monospace, monospace; }
  p { margin: 0 0 8px; overflow-wrap: anywhere; }
  .buttons { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  button { font: inherit; padding: 4px 10px; }
  .request { border-top: 1px solid #c9b98f; padding-top: 10px; margin-top: 10px; }
  .state { font-weight: 600; }
</style>
</head>
<body data-address="${address}">
<header>
<h1>Stand-in for Coinbase Wallet's window</h1>
<p>Served by <code>pnpm wallet-faults</code> in place of keys.coinbase.com. Nothing here is Coinbase's: it holds no wallet, signs nothing and sends nothing beyond this browser. As the wallet it gives ${address}.</p>
<div class="buttons">
<button type="button" id="close">Close, as a person closes it</button>
<button type="button" id="vanish">Vanish without a word</button>
</div>
</header>
<main id="requests">Waiting for the page to ask something.</main>
<script>${script}</script>
</body>
</html>
`;

/** One stand-in event, as the window writes it to its console. */
interface WindowEvent {
  readonly kind: string;
  readonly [field: string]: unknown;
}

const lineFor = (event: WindowEvent): string | null => {
  const n = `#${String(event.number)} ${String(event.method)}`;
  switch (event.kind) {
    case "loaded":
      return `window: opened by ${String(event.origin)}`;
    case "introduced":
      return `window: the page introduced itself as ${String(event.sdk)}`;
    case "handshake":
      return `window: handshake answered, session ${String(event.session)}`;
    case "routine":
      return `window: ${n} to chain ${String(event.chain)} answered at once`;
    case "asked":
      return `window: ${n} asked in session ${String(event.session)}${
        event.detail === "" ? "" : `, ${String(event.detail)}`
      }; waiting for a choice in the window`;
    case "held":
      return `window: ${n} held; the page has been told nothing`;
    case "answered":
      return `window: ${n} ${event.late === true ? "held, then " : ""}${String(event.said)}`;
    case "closing":
      return "window: closing as a person closes it, telling the page";
    case "vanishing":
      return "window: vanishing without telling the page";
    case "unknown-session":
      return `window: request #${String(event.number)} came under a session this window never agreed, and stays unanswered`;
    case "unrecognised":
      return "window: the page sent a message this window does not recognise";
    case "orphan":
      return "window: opened by something other than the dashboard's button, and answers nothing";
    case "failed":
      return `window: could not handle a message: ${String(event.why)}`;
    default:
      return null;
  }
};

/** Events after which the page may have something new to say. */
const READ_AFTER = new Set(["answered", "closing", "vanishing"]);

const firstLine = (thrown: unknown): string =>
  (thrown instanceof Error ? thrown.message : String(thrown)).split("\n")[0] ?? "";

/** What Coinbase's code keeps in the page's storage, named, never with a key's value. */
const sdkStoreOf = async (page: Page): Promise<string> => {
  let kept: string | null;
  try {
    kept = await page.evaluate((name) => localStorage.getItem(name), SDK_STORE);
  } catch (thrown) {
    return `not read (${firstLine(thrown)})`;
  }
  if (kept === null) return "nothing stored";
  try {
    const { state } = JSON.parse(kept) as {
      state?: { account?: { accounts?: unknown }; keys?: Record<string, unknown> };
    };
    const accounts = Array.isArray(state?.account?.accounts) ? state.account.accounts : [];
    const keys = Object.entries(state?.keys ?? {})
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([name]) => name);
    return [
      accounts.length === 0 ? "no account" : `account ${accounts.map(String).join(", ")}`,
      keys.length === 0 ? "no session keys" : `session keys kept (${keys.join(", ")})`,
    ].join(", ");
  } catch {
    return "a value that is not the JSON Coinbase's code writes";
  }
};

/**
 * The payout wallet as the Settings page is drawn by the server when asked
 * afresh with this browser's cookies, without opening a tab: what is saved
 * and what waits to replace it, each address whole. An answer that is not
 * Settings, or has no payout wallet section, is said to be unread rather than
 * read as nothing saved. This request is made from Node rather than the
 * browser, so it follows no redirect: one could lead off the dashboard.
 */
const savedOf = async (context: BrowserContext, settings: URL): Promise<string> => {
  try {
    const answered = await context.request.get(settings.href, {
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    const elsewhere = answered.headers().location;
    if (elsewhere !== undefined) {
      return `not read: the dashboard sent this browser to ${new URL(elsewhere, settings).pathname} instead`;
    }
    if (!answered.ok()) return `not read: the dashboard answered ${answered.status()}`;
    const html = await answered.text();
    const section = html.indexOf(">Payout wallet</h2>");
    if (section === -1) return "not read: the page has no Payout wallet section";
    const shown = html
      .slice(section)
      .split('<div class="saved">')
      .slice(1)
      .map((block) => {
        const label = /<div class="label">([^<]*)<\/div>/.exec(block)?.[1] ?? "unlabelled";
        const spans = /<div class="address">(.*?)<\/div>/s.exec(block)?.[1] ?? "";
        return `${label.toLowerCase()} ${spans.replace(/<[^>]*>/g, "")}`;
      });
    return shown.length === 0 ? "no payout wallet saved" : shown.join("; ");
  } catch (thrown) {
    return `not read (${firstLine(thrown)})`;
  }
};

const saidOn = async (page: Page): Promise<string[]> =>
  (await page.locator("[role=status]").allInnerTexts()).map((said) => said.trim()).filter(Boolean);

const boxOn = async (page: Page): Promise<string> => {
  const box = page.locator("#payout_wallet");
  return (await box.count()) === 0
    ? "no payout wallet box on this page"
    : `"${await box.inputValue()}"`;
};

export interface WalletFaults {
  readonly browser: Browser;
  readonly context: BrowserContext;
  /** The tab the dashboard opened in, whose words and storage the readings are of. */
  readonly page: Page;
  /** Prints a reading now and resolves once it is printed. */
  read(): Promise<void>;
  close(): Promise<void>;
}

const time = (): string => new Date().toISOString().slice(11, 19);

/**
 * Opens the browser on the dashboard's Settings page with the stand-in in
 * place and the gate shut. `headless` is for a run nobody watches.
 */
export async function openWalletFaults(
  plan: Plan,
  say: (line: string) => void,
  headless = false,
): Promise<WalletFaults> {
  const script = await readFile(join(HERE, "wallet-window.js"), "utf8");
  const page = windowPage(plan.address, script);
  const { dashboard } = plan;
  const settings = new URL(`${dashboard.pathname.replace(/\/+$/, "")}/settings`, dashboard.origin);
  const out = (line: string) => say(`${time()} ${line}`);

  const browser = await chromium.launch({
    headless,
    // Every host name but the dashboard's resolves to nothing, so a request
    // the routes below did not see still reaches no one.
    args: [`--host-resolver-rules=EXCLUDE ${dashboard.hostname}, MAP * ~NOTFOUND`],
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const refusedHosts = new Set<string>();
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    const destination = destinationOf(url, dashboard);
    if (destination === "dashboard") return route.continue();
    if (destination === "stand-in") {
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: page });
    }
    const host = URL.canParse(url) ? new URL(url).host : url.slice(0, 40);
    if (!refusedHosts.has(host)) {
      refusedHosts.add(host);
      out(`gate: refused a request to ${host}; this browser reaches only the dashboard`);
    }
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket(/.*/, (socket) => {
    if (destinationOf(socket.url().replace(/^ws/, "http"), dashboard) === "dashboard") {
      socket.connectToServer();
    } else {
      out(`gate: refused a WebSocket to ${new URL(socket.url()).host}`);
      void socket.close();
    }
  });

  const dashboardTab = await context.newPage();
  let reading = Promise.resolve();
  const read = (): Promise<void> => {
    reading = reading.then(async () => {
      const said = await saidOn(dashboardTab).catch(() => [] as string[]);
      const lines = [
        "reading",
        `  the page says: ${said.length === 0 ? "nothing beside its buttons" : said.join(" | ")}`,
        `  the payout wallet box holds: ${await boxOn(dashboardTab).catch(() => "not read")}`,
        `  Coinbase's storage in the page: ${await sdkStoreOf(dashboardTab)}`,
        `  Settings, loaded afresh: ${await savedOf(context, settings)}`,
      ];
      out(lines.join("\n"));
    });
    return reading;
  };

  context.on("console", (message) => {
    const from = message.page()?.url() ?? "";
    if (destinationOf(from, dashboard) !== "stand-in") return;
    const text = message.text();
    if (!text.startsWith("stand-in ")) return;
    let event: WindowEvent;
    try {
      event = JSON.parse(text.slice("stand-in ".length)) as WindowEvent;
    } catch {
      return;
    }
    const line = lineFor(event);
    if (line !== null) out(line);
    if (READ_AFTER.has(event.kind)) setTimeout(() => void read(), 1_500);
  });

  // What the page says beside its buttons, printed as it changes.
  let lastSaid = "";
  const watching = setInterval(() => {
    saidOn(dashboardTab).then(
      (said) => {
        const now = said.join(" | ");
        if (now !== lastSaid && now !== "") out(`page: ${now}`);
        lastSaid = now;
      },
      () => undefined,
    );
  }, 250);
  // A press of a form, Save among them, posts and loads a page: what it
  // recorded is read once that page has loaded.
  let posted = false;
  dashboardTab.on("request", (request) => {
    if (request.isNavigationRequest() && request.method() === "POST") posted = true;
  });
  dashboardTab.on("load", () => {
    if (!posted) return;
    posted = false;
    setTimeout(() => void read(), 500);
  });

  out(
    `opening ${settings.href} in a browser where Coinbase Wallet's window is a stand-in giving ${plan.address}; every other host is refused`,
  );
  await dashboardTab.goto(settings.href);
  return {
    browser,
    context,
    page: dashboardTab,
    read,
    close: async () => {
      clearInterval(watching);
      await reading.catch(() => undefined);
      await browser.close();
    },
  };
}

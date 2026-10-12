/**
 * Pages are built from strings with no template engine, so there is no
 * automatic escaping: everything that reaches a page goes through `escaped`.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS, type SurfaceMode } from "@agentify/core";
import type { DashboardDestination } from "./dashboard-entry.js";
import { DRAWN_FOR } from "./drawn-for.js";
import { moment } from "./words.js";

/** Escapes the five characters that are not text in HTML. */
export const escaped = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * Applied to the whole page rather than written into each form, so a new form
 * carries it without anybody remembering to. A form that ends up without it is
 * refused by the gate, so a miss shows as a form that does not work rather than
 * one that works for whoever is signed in.
 *
 * `autocomplete="off"` because Firefox restores a hidden field's old value on
 * reload, which would put the first address back into a page redrawn for
 * somebody else.
 */
const drawnFor = (who: string, html: string): string =>
  html.replaceAll(/<form\b[^>]*>/gi, (tag) =>
    /\smethod\s*=\s*["']?post\b/i.test(tag)
      ? `${tag}<input type="hidden" name="${DRAWN_FOR}" value="${escaped(who)}" autocomplete="off">`
      : tag,
  );

/**
 * Each tab is also a destination the sign-in returns to, so a tab cannot be
 * added that the sign-in forgets.
 */
export type Tab = "cards" | Exclude<DashboardDestination, "default" | "woocommerce">;

export interface Chrome {
  readonly mode: SurfaceMode;
  /** "" when mounted at the root of its origin. */
  readonly base: string;
  /**
   * On every page, so a merchant with two people can tell whose screen this is
   * before pressing the control that stops all their selling.
   */
  readonly who: string;
  /** Every interactive session is confirmed by the link that opened it. */
  readonly confirmed: boolean;
  /** Null on a page that is none of the tabs. */
  readonly tab: Tab | null;
  readonly title: string;
  /** The site's front page unless named. */
  readonly home?: string;
  /** Absent where the screen did not read the card list, which says it. */
  readonly selling?: { readonly text: string; readonly tone: string };
  /**
   * True draws the line at the top saying nothing can go on sale, with the page
   * that fixes it. Absent where the screen did not ask the gateway: settings
   * itself.
   */
  readonly unnamed?: boolean;
  readonly body: string;
}

const TABS: readonly [Tab, string][] = [
  ["cards", "Cards"],
  ["orders", "Orders"],
  ["receipts", "Receipts"],
  ["integrations", "Integrations"],
  ["keys", "API keys"],
  ["settings", "Settings"],
];

const surface = (mode: SurfaceMode): string => {
  const words = SURFACE_WORDS[mode];
  return words === null
    ? `<div ${SURFACE_MARKER_ATTRIBUTE}="${escaped(mode)}"></div>`
    : `<div class="stack-note" ${SURFACE_MARKER_ATTRIBUTE}="${escaped(mode)}"><div class="container"><p class="surface-words">${escaped(words)}</p></div></div>`;
};

export const brandLockup = (home = "/"): string =>
  `<a class="brand" href="${escaped(home)}" aria-label="Agentify home"><img class="brand-mark" src="/assets/agentify-mark.svg" alt="" width="30" height="30"><span>Agentify</span></a>`;

/**
 * The three addresses are absolute and carry no base path: the documentation
 * and the scanner live at the root of the same origin, beside the dashboard.
 * Run on its own the dashboard has none of them, and the links 404 until Caddy
 * assembles the shared origin.
 */
const FOOT = `  <footer class="foot">
    <div class="foot-inner container">
      ${brandLockup("/")}
      <nav class="foot-links" aria-label="Agentify">
        <a href="/docs/">Documentation</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
      </nav>
      <span class="foot-copy">© 2026 Agentify</span>
    </div>
  </footer>
`;

const sections = (chrome: Chrome): string =>
  `${TABS.map(([tab, label], index) =>
    tab === chrome.tab
      ? `<span class="here" aria-current="page"><i>${index + 1}</i>${label}</span>`
      : `<a href="${escaped(chrome.base)}/${tab}"><i>${index + 1}</i>${label}</a>`,
  ).join("")}`;

/**
 * A details element, so it opens and closes with no script. Who is signed in
 * and the way out stay in the top bar at every width, so the menu does not
 * repeat them.
 */
const narrowMenu = (chrome: Chrome): string => `<details class="app-menu">
        <summary aria-label="Menu"><span></span><span></span><span></span></summary>
        <div class="app-menu-panel">
          <nav class="app-menu-sections" aria-label="Dashboard sections">${sections(chrome)}</nav>
          <a class="app-menu-docs" href="/docs/">Open the docs →</a>
        </div>
      </details>`;

/**
 * The fonts are linked from the shared origin, where Caddy serves them. Run on
 * its own the dashboard has no /styles, the link 404s and the fallback stack in
 * the tokens carries the page, which is why every family names a full one.
 */
export const page = (chrome: Chrome): string => {
  // The heading is drawn once, in the top bar.
  const heading = /<h1>([\s\S]*?)<\/h1>/.exec(chrome.body);
  const body = heading === null ? chrome.body : chrome.body.replace(heading[0], "");
  const title = heading?.[1] ?? escaped(chrome.title);
  return drawnFor(
    chrome.who,
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped(chrome.title)} — Agentify</title>
<link rel="icon" href="/assets/agentify-mark-heavy.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles/fonts.css">
<link rel="stylesheet" href="${escaped(chrome.base)}/agentify.css">
</head>
<body>
<div class="page">
  <div class="app-shell">
    <aside class="app-sidebar">
      <div class="app-sidebar-brand">${brandLockup(chrome.home ?? "/")}<span>SELLER DASHBOARD</span></div>
      <nav class="tabs" aria-label="Dashboard sections">${sections(chrome)}</nav>
      <div class="sidebar-help"><span>Need help?</span><a href="/docs/">Open the docs →</a></div>
      ${narrowMenu(chrome)}
    </aside>
    <div class="app-workspace">
      ${
        // The stack notice heads the workspace rather than the window: a band
        // above the full-height sticky sidebar would push its foot below the
        // first screen.
        surface(chrome.mode)
      }
      <header class="top"><div class="top-inner">
        <h1 class="top-title">${title}</h1>
        ${chrome.selling === undefined ? "" : state(chrome.selling)}
${accountRow(chrome.base, chrome.who)}      </div></header>
      <main class="app-content">
        ${chrome.unnamed === true ? unnamedNote(chrome.base) : ""}${body}
      </main>
    </div>
  </div>
${FOOT}</div>
</body>
</html>
`,
  );
};

/**
 * A long address is cut, with the whole of it in the title, so the bar never
 * runs off a phone.
 */
const accountRow = (base: string, who: string): string => `      <div class="account">
        <a class="who" href="${escaped(base)}/settings" title="${escaped(who)}">${escaped(who)}</a>
        <form class="inline" method="post" action="${escaped(base)}/sign-out">
          <button type="submit">Sign out</button>
        </form>
      </div>
`;

/**
 * Says the consequence (a card the merchant's code publishes is refused) and
 * points at the page that fixes it, because the API's refusal names a route,
 * which is the wrong sentence for somebody looking at a page. It goes once the
 * name is chosen.
 */
const unnamedNote = (base: string): string => `  <div class="callout">
    <div class="what">You cannot publish products until you choose the seller name buyers will see.</div>
    <div class="why">A card without a seller name is refused. <a href="${escaped(base)}/settings">Choose a seller name in Settings</a>.</div>
  </div>
`;

/**
 * The pages in front of the gate, and the few behind it outside the dashboard's
 * frame. None carries a script.
 */
export const bare = (
  base: string,
  title: string,
  body: string,
  mode: SurfaceMode,
  who: string | null,
): string => {
  const drawn = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped(title)} — Agentify</title>
<link rel="icon" href="/assets/agentify-mark-heavy.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles/fonts.css">
<link rel="stylesheet" href="${escaped(base)}/agentify.css">
</head>
<body>
${surface(mode)}
${body}
</body>
</html>
`;
  // Asked of every caller, so a screen behind the gate cannot forget it: null
  // for the pages in front of the gate and for pages with no form that posts.
  return who === null ? drawn : drawnFor(who, drawn);
};

/**
 * The only way a page prints an instant; no screen imports `moment` itself. UTC
 * to the second, allowed to wrap between date and time and nowhere else, with
 * nothing added to the text, so a copied moment is the moment. The two halves
 * sit in one span of their own, because where a table row is drawn as a block
 * Chrome and WebKit drop a space between two spans directly inside a cell.
 */
export const when = (iso: string): string => {
  const text = moment(iso);
  const [date, ...time] = text.split(" ");
  return time.length === 0
    ? escaped(text)
    : `<span class="when"><span>${escaped(date ?? "")}</span> <span>${escaped(time.join(" "))}</span></span>`;
};

export const state = (word: { readonly text: string; readonly tone: string }): string =>
  `<span class="state ${word.tone}"><span class="dot"></span>${escaped(word.text)}</span>`;

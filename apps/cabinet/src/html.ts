/**
 * Building a page out of strings, and the escaping that makes that safe.
 *
 * There is no template engine here because ADR-0005 §4 asks for no build step
 * and three lists do not need one. What that trades away is the engine's
 * automatic escaping, so the escaping is the first thing in this file and
 * everything that reaches a page goes through it. A merchant's own card title
 * is not hostile input in any interesting sense, but it is text somebody else
 * wrote, and a title containing a `<` would otherwise silently break the page
 * it appears on.
 */

import { SURFACE_MARKER_ATTRIBUTE, type SurfaceMode } from "@agentify/core";
import { moment } from "./words.js";

/** Text on its way into a page, with the five characters that are not text. */
export const escaped = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Which of the screens with navigation on them is being looked at. */
export type Tab = "cards" | "orders" | "receipts" | "integrations" | "keys" | "settings";

export interface Chrome {
  /** Which of the three things this stack is, so every page names it. */
  readonly mode: SurfaceMode;
  /** Where the cabinet is mounted, "" when it is at the root of its origin. */
  readonly base: string;
  /**
   * The address of the person signed in.
   *
   * On every page, in the corner, because a merchant with two people has to be
   * able to tell whose screen this is before pressing the control that stops
   * all their selling.
   *
   * It links to the settings, where the account it names is described. Pressing
   * your own name means "show me my account" and opens that page directly.
   */
  readonly who: string;
  /**
   * Whether anybody has shown they can read mail sent to that address. The
   * identity fact remains available to callers, while every interactive
   * passwordless session is confirmed by the link that opened it.
   */
  readonly confirmed: boolean;
  /** The tab to mark as the current one; null on a page that is none of them. */
  readonly tab: Tab | null;
  readonly title: string;
  /** Where the logo in the sidebar leads; the site's front page unless named. */
  readonly home?: string;
  /**
   * The merchant's own selling word, for the light in the corner.
   *
   * Absent on a screen that is not about selling, which is the keys. The word
   * comes from the card list, and fetching one on a page that draws no cards
   * would be a call to the gateway whose only purpose is a coloured dot — on
   * the one screen a merchant is most likely to be reading because something
   * about their keys has gone wrong.
   */
  readonly selling?: { readonly text: string; readonly tone: string };
  /**
   * Whether this merchant has still chosen no name for buyers to read.
   *
   * True draws the line at the top of the page saying nothing of theirs can go
   * on sale, with the page that fixes it. Absent where the screen did not ask
   * the gateway — the keys, for the reason given above the selling word, and
   * the settings itself, which is the answer rather than a place to be told
   * about the question.
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

/** Keep the deployment marker available to runtime checks without drawing
 * environment copy inside the cabinet UI. */
const surface = (mode: SurfaceMode): string =>
  `<div ${SURFACE_MARKER_ATTRIBUTE}="${escaped(mode)}" hidden></div>`;

/** The same compact lockup on the public site, the cabinet and every auth page. */
export const brandLockup = (home = "/"): string =>
  `<a class="brand" href="${escaped(home)}" aria-label="Agentify home"><img class="brand-mark" src="/assets/agentify-mark.svg" alt="" width="30" height="30"><span>Agentify</span></a>`;

/**
 * The band at the foot of every working screen.
 *
 * One row and three things in it: the lockup, the three places outside the
 * cabinet a signed-in merchant has the same need for as any visitor, and the
 * copyright. It is the scanner's footer in colour and in type — ink rather than
 * paper, the mark inverse, the small print in the monospaced face — and not in
 * shape: the scanner's four columns of link groups carry a marketing site, and
 * a console with five tabs has nothing to put in them.
 *
 * It also settles where the documentation goes. The link used to ride in the
 * bar, where it had to argue at length that it was not a sixth tab; in a footer
 * it plainly is not one, and the argument goes with it.
 *
 * The three addresses are absolute and carry no base path: ADR-0005 §1 puts the
 * documentation at /docs and the scanner's own pages at the root of the same
 * origin, beside the cabinet rather than under it. Run on its own the cabinet
 * has none of them and all three 404, exactly as /styles/fonts.css does, and
 * for the same reason: the shared origin is Caddy's to assemble.
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

/**
 * One whole page.
 *
 * The stylesheet is linked rather than inlined so that a merchant moving
 * between the four screens fetches it once, and so that the one visual
 * language ADR-0005 §6 asks for is one file rather than four copies.
 *
 * The faces are linked separately, from the shared origin, because they are
 * woff2 files Caddy serves out of the visual package and their addresses are
 * relative to that directory. Behind Caddy this resolves and the pages are set in Schibsted Grotesk;
 * run on its own the cabinet has no /styles, the link 404s and the fallback
 * stack in the tokens carries the page — which is what a fallback stack is for,
 * and why every family here names a full one.
 */
/**
 * The numbered sections, the same list in the sidebar and in the narrow menu.
 */
const sections = (chrome: Chrome): string =>
  `${TABS.map(([tab, label], index) =>
    tab === chrome.tab
      ? `<span class="here" aria-current="page"><i>${index + 1}</i>${label}</span>`
      : `<a href="${escaped(chrome.base)}/${tab}"><i>${index + 1}</i>${label}</a>`,
  ).join("")}${
    // The showcase of rare states exists on the laptop stand only, so the
    // link to it is drawn there and nowhere else.
    chrome.mode === "sandbox"
      ? `<a class="tabs-states" href="${escaped(chrome.base)}/states">Rare states</a>`
      : ""
  }`;

/**
 * The menu behind the burger on a phone and a tablet, where there is no room
 * for the sidebar. A details element, so it opens without a script; the script
 * below adds closing from outside and on Escape and swaps the button's label.
 * The sidebar's own list, help box and account row are hidden at these widths,
 * so only one of the two navigations is ever on the screen.
 */
const narrowMenu = (chrome: Chrome): string => `<details class="app-menu">
        <summary aria-label="Open menu" data-label="Close menu"><span></span><span></span><span></span></summary>
        <div class="app-menu-panel">
          <nav class="app-menu-sections" aria-label="Dashboard sections">${sections(chrome)}</nav>
          <a class="app-menu-docs" href="/docs/">Open the docs →</a>
          <div class="app-menu-account">
            <small>${escaped(chrome.who)}</small>
            <a href="${escaped(chrome.base)}/settings">Settings</a>
            <form class="inline" method="post" action="${escaped(chrome.base)}/sign-out">
              <button type="submit">Sign out</button>
            </form>
          </div>
        </div>
      </details>`;

export const page = (chrome: Chrome): string => {
  // The screen's own heading is drawn once, in the bar at the top, rather than
  // a second time above the content.
  const heading = /<h1>([\s\S]*?)<\/h1>/.exec(chrome.body);
  const body = heading === null ? chrome.body : chrome.body.replace(heading[0], "");
  const title = heading?.[1] ?? escaped(chrome.title);
  return `<!doctype html>
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
${surface(chrome.mode)}
  <div class="app-shell">
    <aside class="app-sidebar">
      <div class="app-sidebar-brand">${brandLockup(chrome.home ?? "/")}<span>SELLER DASHBOARD</span></div>
      <nav class="tabs" aria-label="Dashboard sections">${sections(chrome)}</nav>
      <div class="sidebar-help"><span>Need help?</span><a href="/docs/">Open the docs →</a></div>
      ${accountRow(chrome.base, chrome.who)}
      ${narrowMenu(chrome)}
    </aside>
    <div class="app-workspace">
      <header class="top"><div class="top-inner">
        <h1 class="top-title">${title}</h1>
        ${chrome.selling === undefined ? "" : state(chrome.selling)}
      </div></header>
      <main class="app-content">
        ${chrome.unnamed === true ? unnamedNote(chrome.base) : ""}${body}
      </main>
    </div>
  </div>
${FOOT}</div>
${ACCOUNT_MENU_CLOSES}
</body>
</html>
`;
};

/**
 * Who is signed in, and how to stop being them.
 *
 * Under the content rather than in the bar, which is where the scanner puts the
 * same two things (apps/web/app/report/[scanId]/report.module.css, `.account`).
 * An address is a label and not a destination: in the bar it read as a fifth
 * tab, and it pushed the one item up there that genuinely is status — the
 * selling light — out to the far edge behind three things that are not.
 *
 * It is still a link, and it still leads to the settings, because pressing your
 * own name means "show me my account" and the account is on that page.
 */
const accountRow = (base: string, who: string): string => `  <details class="account">
    <summary aria-label="Account menu">
      <span class="account-avatar">${escaped(who.slice(0, 1).toUpperCase())}</span>
      <span class="who"><b>Account</b><small>${escaped(who)}</small></span>
      <span class="account-more" aria-hidden="true">•••</span>
    </summary>
    <div class="account-menu">
      <a href="${escaped(base)}/settings">Settings</a>
      <a class="account-docs" href="/docs/">Documentation</a>
      <form class="inline" method="post" action="${escaped(base)}/sign-out">
        <button type="submit">Sign out</button>
      </form>
    </div>
  </details>
`;

/**
 * A details element opens and closes only on its own summary, so a menu left
 * open stays open over the page. A press anywhere outside it and the Escape key
 * close it, the way every other menu a person has used behaves.
 */
const ACCOUNT_MENU_CLOSES = `<script>
(() => {
  const menus = document.querySelectorAll("details.account, details.app-menu");
  document.addEventListener("click", (event) => {
    for (const menu of menus) {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const menu of menus) {
      if (!menu.open) continue;
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
  const burger = document.querySelector("details.app-menu > summary");
  if (burger === null) return;
  const labels = [burger.getAttribute("aria-label"), burger.dataset.label];
  burger.parentElement.addEventListener("toggle", (event) => {
    burger.setAttribute("aria-label", labels[event.target.open ? 1 : 0]);
  });
})();
</script>`;

/**
 * The line at the top of every working screen while no name is set.
 *
 * It says the consequence rather than the setting, because the consequence is
 * the part a merchant can feel: a card their code publishes is refused, and
 * without this line the refusal arrives in their own logs with nothing in the
 * cabinet to explain it. The refusal they would read there ends by naming the
 * route that lifts it, which is the right sentence for whoever is holding an
 * API response and the wrong one for somebody looking at a page — so this says
 * the same thing and points at the page that does it instead.
 *
 * It goes once the name is chosen. A line that never leaves is a line nobody
 * reads, and this one is about a state one form post ends.
 */
const unnamedNote = (base: string): string => `  <div class="callout">
    <div class="what">You cannot publish products until you choose the seller name buyers will see.</div>
    <div class="why">A card without a seller name is refused. <a href="${escaped(base)}/settings">Choose a seller name in Settings</a>.</div>
  </div>
`;

/**
 * A page with no navigation, for a merchant who is not signed in yet.
 *
 * There were two of these: one that carried the theme script and one for the
 * pages whose behaviour has to be complete without JavaScript. With the theme
 * gone there is no script on any of them, so the two were the same page written
 * twice.
 */
export const bare = (base: string, title: string, body: string, mode: SurfaceMode): string =>
  `<!doctype html>
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

/**
 * An instant as a page prints it, and the only way a page prints one.
 *
 * The words are `moment`'s, in UTC to the second. The markup lets the moment
 * wrap between its date and its time and nowhere else — left to itself a
 * browser breaks "2026-09-23" after a hyphen — and adds nothing to the text,
 * so a copied moment is the moment. The two halves sit inside one span of
 * their own: where a table row is drawn as a block its cells are drawn as
 * small tables, and Chrome and WebKit drop a space standing between two spans
 * directly inside one, so the date and the time ran together.
 *
 * Three screens printed a moment as plain text beside this and each of them
 * broke that way on a phone, which is why no screen imports `moment` itself.
 */
export const when = (iso: string): string => {
  const text = moment(iso);
  const [date, ...time] = text.split(" ");
  return time.length === 0
    ? escaped(text)
    : `<span class="when"><span>${escaped(date ?? "")}</span> <span>${escaped(time.join(" "))}</span></span>`;
};

/** A cell holding an instant, in a column as narrow as the moment on two lines. */
export const momentCell = (iso: string): Cell => ({ kind: "quiet moment", html: when(iso) });

/** A state with its dot, the way every one of the three screens draws one. */
export const state = (word: { readonly text: string; readonly tone: string }): string =>
  `<span class="state ${word.tone}"><span class="dot"></span>${escaped(word.text)}</span>`;

/** One cell of a table: what it shows, and the class that says what kind of value it is. */
export interface Cell {
  readonly html: string;
  readonly kind?: string;
}

/** One row: its cells in the order of the columns, and the class the row is marked with. */
export interface Row {
  readonly mark?: string;
  readonly cells: readonly Cell[];
}

/**
 * A table with a row for every entry, or one line saying there are none.
 *
 * Every cell carries the head of its column. Where the frame is too narrow for
 * the columns, a row is drawn as a block of labelled values rather than a line
 * the page has to be scrolled sideways to read, and the labels are these — the
 * same words as the heads, so the two cannot say different things.
 */
export const table = (
  columns: readonly string[],
  rows: readonly Row[],
  nothing: string,
): string => {
  if (rows.length === 0) {
    return `<div class="scroller"><p class="empty">${escaped(nothing)}</p></div>`;
  }
  const cell = (one: Cell, head = ""): string =>
    `<td${one.kind === undefined ? "" : ` class="${one.kind}"`}${head === "" ? "" : ` data-label="${escaped(head)}"`}>${one.html}</td>`;
  const row = (one: Row): string =>
    `<tr${one.mark === undefined ? "" : ` class="${one.mark}"`}>
${one.cells.map((each, at) => cell(each, columns[at])).join("\n")}
</tr>`;
  return `<div class="scroller"><table>
<thead><tr>${columns.map((column) => `<th>${escaped(column)}</th>`).join("")}</tr></thead>
<tbody>${rows.map(row).join("")}</tbody>
</table></div>`;
};

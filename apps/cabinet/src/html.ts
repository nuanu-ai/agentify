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

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS, type SurfaceMode } from "@agentify/core";

/** Text on its way into a page, with the five characters that are not text. */
export const escaped = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Which of the screens with navigation on them is being looked at. */
export type Tab = "cards" | "orders" | "receipts" | "keys" | "settings";

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
  readonly tab: Tab;
  readonly title: string;
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
  ["keys", "API Keys"],
  ["settings", "Settings"],
];

/** Every page names its mode and warns only where there is something to warn about. */
const surface = (mode: SurfaceMode): string => {
  const words = SURFACE_WORDS[mode];
  return words === null
    ? `<div ${SURFACE_MARKER_ATTRIBUTE}="${escaped(mode)}"></div>`
    : `<div class="stack-note" ${SURFACE_MARKER_ATTRIBUTE}="${escaped(mode)}"><div class="container"><p class="surface-words">${escaped(words)}</p></div></div>`;
};

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
export const page = (chrome: Chrome): string => `<!doctype html>
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
  <header class="top">
    <div class="top-inner container">
      <div class="bar-left">
        ${brandLockup("/")}
        <nav class="tabs" aria-label="Your cabinet">${TABS.map(([tab, label]) =>
          tab === chrome.tab
            ? `<span class="here" aria-current="page">${label}</span>`
            : `<a href="${escaped(chrome.base)}/${tab}">${label}</a>`,
        ).join("")}</nav>
      </div>
      ${chrome.selling === undefined ? "" : state(chrome.selling)}
    </div>
  </header>
  <div class="container">
${chrome.unnamed === true ? unnamedNote(chrome.base) : ""}${chrome.body}
${accountRow(chrome.base, chrome.who)}  </div>
${FOOT}</div>
</body>
</html>
`;

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
const accountRow = (base: string, who: string): string => `  <div class="account">
    <a class="who" href="${escaped(base)}/settings">${escaped(who)}</a>
    <form class="inline" method="post" action="${escaped(base)}/sign-out">
      <button type="submit">Sign out</button>
    </form>
  </div>
`;

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
    <div class="what">Your products cannot go on sale until you choose the name buyers see beside them.</div>
    <div class="why">A card published while this is unset is refused, because it would be offered for sale with no seller on it. <a href="${escaped(base)}/settings">Choose the name in your settings</a>.</div>
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
export const bare = (
  base: string,
  title: string,
  body: string,
  mode: SurfaceMode,
): string => `<!doctype html>
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

/** A state with its dot, the way every one of the three screens draws one. */
export const state = (word: { readonly text: string; readonly tone: string }): string =>
  `<span class="state ${word.tone}"><span class="dot"></span>${escaped(word.text)}</span>`;

/** A table with a row for every entry, or one line saying there are none. */
export const table = (
  columns: readonly string[],
  rows: readonly string[],
  nothing: string,
): string =>
  rows.length === 0
    ? `<div class="scroller"><p class="empty">${escaped(nothing)}</p></div>`
    : `<div class="scroller"><table>
<thead><tr>${columns.map((column) => `<th>${escaped(column)}</th>`).join("")}</tr></thead>
<tbody>${rows.join("")}</tbody>
</table></div>`;

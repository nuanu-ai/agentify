/** The two pages the string gate and the not-found answer draw. */

import type { SurfaceMode } from "@agentify/core";
import { bare, brandLockup, escaped, page } from "./html.js";
import type { Viewer } from "./viewer.js";

/**
 * In the dashboard's own frame: the person is still in their dashboard, and the
 * logo and the one button lead back to the cards.
 */
export const notFoundScreen = (viewer: Viewer): string =>
  page({
    mode: viewer.mode,
    base: viewer.base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: null,
    title: "There is no such page",
    home: `${viewer.base}/cards`,
    body: `
  <div class="lede">
    <div>
      <h1>There is no such page</h1>
      <p>The link may have a typo or be out of date. Every section of your dashboard is in the menu.</p>
    </div>
  </div>
  <div class="connect-actions">
    <a class="button button-primary" href="${escaped(viewer.base)}/cards">Back to the dashboard</a>
  </div>
`,
  });

/**
 * Nothing the form sent was done. It says the page could not be matched rather
 * than that it was drawn for somebody else, because an old tab pressed by its
 * own owner gets this too. It names the address signed in now, never the one
 * the form claimed, and is a bare page because the person now signed in may own
 * no merchant.
 */
export const notDrawnForYouScreen = (
  base: string,
  mode: SurfaceMode,
  who: string,
  start: string,
): string =>
  bare(
    base,
    "Nothing was changed",
    `<div class="gate">
${brandLockup("/")}
<div class="gate-card">
  <h1>Nothing was changed</h1>
  <p>What you pressed was not done, because the page it came from could not be matched to the address signed in on this browser now, <strong>${escaped(who)}</strong>. Open the screen again to make the change as this address.</p>
  <a class="button button-primary" href="${escaped(start)}">Continue</a>
</div>
</div>`,
    mode,
    null,
  );

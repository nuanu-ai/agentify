/**
 * The account part of settings. Its one control ends every other session of
 * this account and keeps this one; it touches no other account and no key.
 */

import { SIGN_OUT_EVERY_OTHER_DEVICE } from "./control-labels.js";
import { escaped } from "./html.js";
import type { Viewer } from "./screens.js";

export const accountSettings = (viewer: Viewer): string => `
  <div class="lede">
    <div>
      <h2>The account you sign in with</h2>
      <p>${escaped(
        `You sign in as ${viewer.who}. A one-time link sent to this address is how you get back into your dashboard.`,
      )}</p>
      <p class="quiet">There is no way to change the address itself yet.</p>
    </div>
    <form class="inline" method="post" action="${escaped(viewer.base)}/sign-out">
      <button class="button button-secondary" type="submit">Sign out</button>
    </form>
  </div>
  <form class="issue" method="post" action="${escaped(viewer.base)}/settings/sign-out-others">
    <p class="quiet">${escaped(
      `Ends every session of ${viewer.who} except this one, on any device. Each of them needs a new link to sign in again.`,
    )}</p>
    <button class="button button-secondary" type="submit">${escaped(SIGN_OUT_EVERY_OTHER_DEVICE)}</button>
    ${viewer.accountNotice === undefined ? "" : `<p role="status">${escaped(viewer.accountNotice)}</p>`}
  </form>
`;

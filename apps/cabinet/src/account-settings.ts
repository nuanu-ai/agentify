/**
 * The account half of settings under passwordless cabinet identity.
 *
 * It carries the one control that reaches this account's other sessions:
 * signing out every other device (ADR-0026 §3). The header's sign-out ends
 * this browser's session and leaves the others alone; this one ends the others
 * and keeps this one, which is what somebody wants who left a session open on
 * a device they no longer hold, or suspects somebody else is signed in as
 * them. It ends this account's sessions and no other account's, and touches no
 * key; each device it signs out signs in again with a link sent to this
 * address.
 */

import { escaped } from "./html.js";
import type { Viewer } from "./screens.js";

export const accountSettings = (viewer: Viewer): string => `
  <div class="lede">
    <div>
      <h2>The account you sign in with</h2>
      <p>${escaped(
        `You sign in as ${viewer.who}. A one-time link sent to this address is the way back into your cabinet.`,
      )}</p>
      <p class="quiet">There is no way to change the address itself yet.</p>
    </div>
  </div>
  <form class="issue" method="post" action="${escaped(viewer.base)}/settings/sign-out-others">
    <p class="quiet">${escaped(
      `Ends every session of ${viewer.who} except this one, on any device. Each of them needs a new link to sign in again.`,
    )}</p>
    <button class="button button-secondary" type="submit">Sign out every other device</button>
    ${viewer.accountNotice === undefined ? "" : `<p role="status">${escaped(viewer.accountNotice)}</p>`}
  </form>
`;

/**
 * The account half of settings under passwordless cabinet identity.
 *
 * Two lines: who is signed in and how they get back, and the limit. The limit
 * is the fifth gate here — a settings page that shows an address and offers no
 * control reads as a control somebody forgot to build, and "not yet" is a
 * different answer from "not possible".
 */

import { escaped } from "./html.js";
import type { Viewer } from "./screens.js";

export const accountSettings = (viewer: Viewer): string => `
  <div class="lede">
    <div>
      <h2>Account</h2>
      <p>${escaped(
        `Signed in as ${viewer.who}. A one-time link to this address is the way back in.`,
      )}</p>
      <p class="quiet">The address cannot be changed yet.</p>
    </div>
  </div>
`;

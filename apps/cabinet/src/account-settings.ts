/** The account half of settings under passwordless cabinet identity. */

import { escaped } from "./html.js";
import type { Viewer } from "./screens.js";

export const accountSettings = (viewer: Viewer): string => `
  <div class="lede">
    <div>
      <h2>The account you sign in with</h2>
      <p>${escaped(
        `You sign in as ${viewer.who}. A one-time link sent to this address is the way back into your cabinet.`,
      )}</p>
      <p class="quiet">There is no password. There is no way to change the address itself yet.</p>
    </div>
  </div>
`;

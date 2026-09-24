/** The account half of settings under passwordless cabinet identity. */

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
`;

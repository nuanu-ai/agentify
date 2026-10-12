/**
 * The screen a person signed in without a merchant reaches: the one control
 * that makes a merchant. The sign-in itself is drawn by React Router
 * (`app/screens/sign-in.tsx`).
 */

import type { SurfaceMode } from "@agentify/core";
import { bare, brandLockup, escaped } from "./html.js";

/**
 * Only the same-origin press makes the merchant; a press that did not make one
 * leaves the person here, signed in, to press again.
 */
export const merchantSetupScreen = (
  base: string,
  mode: SurfaceMode,
  email: string,
  unavailable = false,
): string =>
  bare(
    base,
    "Open a seller dashboard",
    `<div class="gate">
${brandLockup("/")}
<div class="gate-card">
  <h1>Open a seller dashboard</h1>
  <p>You are signed in as <strong>${escaped(email)}</strong>.</p>
  ${
    unavailable
      ? `<p class="problem">Your seller dashboard was not opened because of a fault on our side. You are still signed in, so pressing again needs no new link.</p>`
      : `<p>A seller dashboard is where your engineer publishes what you sell to agents and where the orders arrive. Nothing is made until you press the button.</p>`
  }
  <form method="post" action="${escaped(base)}/merchant">
    <button class="button button-primary" type="submit">Open my seller dashboard</button>
  </form>
  <form method="post" action="${escaped(base)}/sign-out">
    <button class="button button-secondary" type="submit">Sign out</button>
  </form>
</div>
</div>`,
    mode,
    email,
  );

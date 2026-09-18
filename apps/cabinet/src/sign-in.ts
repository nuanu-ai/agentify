/**
 * The cabinet's one public door: an address and a one-time link.
 *
 * Asking for a link never says whether the address is new or already belongs
 * to a merchant. Opening the URL only draws a form. The token is spent by the
 * explicit POST from that form, so a mail preview cannot sign anybody in.
 */

import type { SurfaceMode } from "@agentify/commerce-core";
import { bare, bareWithoutScript, brandLockup, escaped } from "./html.js";

export const signInScreen = (
  base: string,
  mode: SurfaceMode,
  destination: "default" | "settings" = "default",
  problem?: string,
): string =>
  bare(
    base,
    "Sign in",
    `<div class="gate">
<form method="post" action="${escaped(base)}/sign-in">
  <h1>${brandLockup("/")}</h1>
  <p>Enter your email address. We will send one link that signs you in or makes your cabinet when you open it.</p>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" autofocus required>
  ${destination === "settings" ? '<input type="hidden" name="destination" value="settings">' : ""}
  <button class="primary" type="submit">Send me a sign-in link</button>
  ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  <p class="quiet">The link works once and expires after one hour. There is no password to remember or reset.</p>
</form>
</div>`,
    mode,
  );

/** The non-enumerating answer after an accepted request or an hourly limit. */
export const linkRequestedScreen = (
  base: string,
  mode: SurfaceMode,
  email: string,
  destination: "default" | "settings",
  retryAfterSeconds?: number,
): string => {
  const minutes =
    retryAfterSeconds === undefined ? null : Math.max(1, Math.ceil(retryAfterSeconds / 60));
  const retry =
    minutes === null
      ? '<p class="quiet">If nothing arrives, check your spam folder, then send another link from this page.</p>'
      : `<p class="problem">No new link was sent. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.</p>`;

  return bare(
    base,
    "Check your mail",
    `<div class="gate">
<form method="post" action="${escaped(base)}/sign-in">
  <h1>${brandLockup("/")}</h1>
  <p>If a message can be sent to that address, a sign-in link is on its way. It works once and expires after one hour.</p>
  ${retry}
  <p class="quiet">You can request up to three links for one address in one hour. We answer every address the same way.</p>
  <input name="email" type="hidden" value="${escaped(email)}">
  ${destination === "settings" ? '<input type="hidden" name="destination" value="settings">' : ""}
  <button type="submit">Send another link</button>
</form>
</div>`,
    mode,
  );
};

/** An honest provider outage: no message was accepted and no account was made. */
export const mailUnavailableScreen = (base: string, mode: SurfaceMode): string =>
  bare(
    base,
    "Mail is unavailable",
    `<div class="gate">
<form method="get" action="${escaped(base)}/sign-in">
  <h1>${brandLockup("/")}</h1>
  <p>We could not hand your sign-in message to the mail provider. No account or session was made. Please try again in a moment.</p>
  <button type="submit">Try again</button>
</form>
</div>`,
    mode,
  );

/** The no-script GET target in the message. */
export const openLinkScreen = (base: string, token: string, mode: SurfaceMode): string =>
  bareWithoutScript(
    base,
    "Open your cabinet",
    `<div class="gate">
<form method="post" action="${escaped(base)}/sign-in/open">
  <h1>${brandLockup("/")}</h1>
  <p>Confirm that you want to open your cabinet in this browser.</p>
  <input type="hidden" name="token" value="${escaped(token)}">
  <button class="primary" type="submit">Open my cabinet</button>
</form>
</div>`,
    mode,
  );

/** One refusal for a malformed, expired, wrong-purpose, or already-used link. */
export const refusedLinkScreen = (base: string, mode: SurfaceMode): string =>
  bareWithoutScript(
    base,
    "That link does not work",
    `<div class="gate">
<form method="get" action="${escaped(base)}/sign-in">
  <h1>${brandLockup("/")}</h1>
  <p>That link does not work. It may have expired or already been used. Ask for a fresh link.</p>
  <button class="primary" type="submit">Ask for another link</button>
</form>
</div>`,
    mode,
  );

/** The authenticated P1 state after the gateway did not attach a merchant. */
export const merchantSetupScreen = (base: string, mode: SurfaceMode, unavailable = false): string =>
  bare(
    base,
    "Finish setting up your cabinet",
    `<div class="gate">
<form method="post" action="${escaped(base)}/merchant">
  <h1>${brandLockup("/")}</h1>
  <p>Your email is confirmed and you are signed in. Your merchant${
    unavailable ? " could not be made because the gateway did not answer" : " is not attached yet"
  }.</p>
  <p class="quiet">Trying again uses this signed-in session. You do not need another email.</p>
  <button class="primary" type="submit">Try again</button>
</form>
<form method="post" action="${escaped(base)}/sign-out">
  <button type="submit">Sign out</button>
</form>
</div>`,
    mode,
  );

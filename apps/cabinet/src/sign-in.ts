/**
 * The cabinet's one public door: an address and a one-time link.
 *
 * Asking for a link never says whether the address is new or already belongs
 * to a merchant. Opening the URL only draws a form. The token is spent by the
 * explicit POST from that form, so a mail preview cannot sign anybody in.
 */

import type { SurfaceMode } from "@agentify/commerce-core";
import type { CabinetDestination } from "./cabinet-entry.js";
import { bare, brandLockup, escaped } from "./html.js";

const destinationInput = (destination: CabinetDestination): string =>
  destination === "default"
    ? ""
    : `<input type="hidden" name="destination" value="${escaped(destination)}">`;

export const signInScreen = (
  base: string,
  mode: SurfaceMode,
  destination: CabinetDestination = "default",
  problem?: string,
  email = "",
): string =>
  bare(
    base,
    "Sign in",
    `<div class="gate">
${brandLockup("/")}
<form class="gate-card" method="post" action="${escaped(base)}/sign-in">
  <h1>Sign in</h1>
  <p>Enter your email address. We will send one link that signs you in or makes your cabinet when you open it.</p>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" value="${escaped(email)}" autocomplete="email" autocapitalize="off" spellcheck="false" autofocus required>
  ${destinationInput(destination)}
  <button class="button button-primary" type="submit">Send me a sign-in link</button>
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
  destination: CabinetDestination,
  retryAfterSeconds?: number,
): string => {
  const minutes =
    retryAfterSeconds === undefined ? null : Math.max(1, Math.ceil(retryAfterSeconds / 60));
  const outcome =
    minutes === null
      ? `<p>If a message can be sent to <strong>${escaped(email)}</strong>, a sign-in link is on its way. It works once and expires after one hour.</p>
  <p class="quiet">If nothing arrives, check your spam folder, then send another link from this page.</p>`
      : `<p>No new link was sent to <strong>${escaped(email)}</strong>.</p>
  <p class="problem">Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.</p>`;

  return bare(
    base,
    minutes === null ? "Check your mail" : "Try again later",
    `<div class="gate">
${brandLockup("/")}
<div class="gate-card">
  <h1>${minutes === null ? "Check your mail" : "Try again later"}</h1>
  ${outcome}
  <p class="quiet">You can request up to three links for one address in one hour. We answer every address the same way.</p>
  <form method="post" action="${escaped(base)}/sign-in">
    <input name="email" type="hidden" value="${escaped(email)}">
    ${destinationInput(destination)}
    <button class="button button-primary" type="submit">Send another link</button>
  </form>
  <form method="get" action="${escaped(base)}/sign-in">
    ${destinationInput(destination)}
    <button class="button button-secondary" type="submit">Use a different email</button>
  </form>
</div>
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
${brandLockup("/")}
<form class="gate-card" method="get" action="${escaped(base)}/sign-in">
  <h1>Mail is unavailable</h1>
  <p>We could not hand your sign-in message to the mail provider. No account or session was made. Please try again in a moment.</p>
  <button class="button button-primary" type="submit">Try again</button>
</form>
</div>`,
    mode,
  );

/** The no-script GET target in the message. */
export const openLinkScreen = (base: string, token: string, mode: SurfaceMode): string =>
  bare(
    base,
    "Open your cabinet",
    `<div class="gate">
${brandLockup("/")}
<form class="gate-card" method="post" action="${escaped(base)}/sign-in/open">
  <h1>Open your cabinet</h1>
  <p>Confirm that you want to open your cabinet in this browser.</p>
  <input type="hidden" name="token" value="${escaped(token)}">
  <button class="button button-primary" type="submit">Open my cabinet</button>
</form>
</div>`,
    mode,
  );

/** One refusal for a malformed, expired, wrong-purpose, or already-used link. */
export const refusedLinkScreen = (
  base: string,
  mode: SurfaceMode,
  signedIn?: { readonly email: string; readonly destination: "cards" | "merchant" },
): string => {
  const recovery =
    signedIn === undefined
      ? "<p>Ask for a fresh link.</p>"
      : `<p>You are already signed in as ${escaped(signedIn.email)}.</p>
  <p><a class="button button-primary" href="${escaped(base)}/${signedIn.destination}">Open your cabinet</a></p>
  <p class="quiet">Use a different email only if you meant to switch accounts.</p>`;
  const another = signedIn === undefined ? "Ask for another link" : "Use a different email";

  return bare(
    base,
    "That link does not work",
    `<div class="gate">
${brandLockup("/")}
<div class="gate-card">
  <h1>That link does not work</h1>
  <p>It may have expired or already been used.</p>
  ${recovery}
  <form method="get" action="${escaped(base)}/sign-in">
    <button class="button button-secondary" type="submit">${another}</button>
  </form>
</div>
</div>`,
    mode,
  );
};

/** The authenticated P1 state after the gateway did not attach a merchant. */
export const merchantSetupScreen = (base: string, mode: SurfaceMode, unavailable = false): string =>
  bare(
    base,
    "Finish setting up your cabinet",
    `<div class="gate">
${brandLockup("/")}
<div class="gate-card">
  <h1>Finish setting up your cabinet</h1>
  <p>Your email is confirmed and you are signed in. Your merchant${
    unavailable ? " could not be made because the gateway did not answer" : " is not attached yet"
  }.</p>
  <p class="quiet">Trying again uses this signed-in session. You do not need another email.</p>
  <form method="post" action="${escaped(base)}/merchant">
    <button class="button button-primary" type="submit">Try again</button>
  </form>
  <form method="post" action="${escaped(base)}/sign-out">
    <button class="button button-secondary" type="submit">Sign out</button>
  </form>
</div>
</div>`,
    mode,
  );

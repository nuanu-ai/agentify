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
  <p>Enter your email address and we will send you a sign-in link.</p>
  <label for="email">Email address</label>
  <input id="email" name="email" type="email" value="${escaped(email)}" autocomplete="email" autocapitalize="off" spellcheck="false" autofocus required>
  ${destinationInput(destination)}
  <button class="button button-primary" type="submit">Send me a sign-in link</button>
  ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  <p class="quiet">Every sign-in gets its own link. It opens once and expires an hour after it is sent, so there is nothing to keep and no password to remember.</p>
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
      ? `<p>A sign-in link is on its way to <strong>${escaped(email)}</strong>. It opens once and expires an hour after it is sent.</p>
  <p class="quiet">If nothing arrives, look in your spam folder, then send another link from this page.</p>`
      : `<p>No new link was sent to <strong>${escaped(email)}</strong>. One email address gets three links an hour, and this one has had its three.</p>
  <p class="problem">Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.</p>`;

  return bare(
    base,
    minutes === null ? "Check your mail" : "Try again later",
    `<div class="gate">
${brandLockup("/")}
<div class="gate-card">
  <h1>${minutes === null ? "Check your mail" : "Try again later"}</h1>
  ${outcome}
  <form method="post" action="${escaped(base)}/sign-in">
    <input name="email" type="hidden" value="${escaped(email)}">
    ${destinationInput(destination)}
    <button class="button button-primary" type="submit">Send another link</button>
  </form>
  <form method="get" action="${escaped(base)}/sign-in">
    ${destinationInput(destination)}
    <button class="button button-secondary" type="submit">Use a different address</button>
  </form>
</div>
</div>`,
    mode,
  );
};

/**
 * A handover that failed, said without claiming to know what became of it.
 *
 * The postman answers "refused" both for a provider that rejected the message
 * and for one that never answered inside the timeout, and a message of the
 * second kind may well have been delivered. What this cabinet does know is
 * that it cannot confirm the send and that the attempt wrote nothing down.
 */
export const mailUnavailableScreen = (base: string, mode: SurfaceMode): string =>
  bare(
    base,
    "We could not confirm your sign-in link went out",
    `<div class="gate">
${brandLockup("/")}
<form class="gate-card" method="get" action="${escaped(base)}/sign-in">
  <h1>We could not confirm your sign-in link went out</h1>
  <p>Something failed while the message was going out, and we cannot tell whether it reached you. Nothing was created on this attempt — no account and no session. Try again in a moment, and if nothing arrives, check that the email address is spelled right.</p>
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
  const heading = signedIn === undefined ? "That link no longer works" : "You are already signed in";
  const recovery =
    signedIn === undefined
      ? `<p>A sign-in link opens once and expires an hour after it is sent. This one no longer opens anything.</p>
  <p>Nothing is lost: access belongs to your email address, not to any one link. Ask for a new one.</p>`
      : `<p>This link has already done its work, and you are signed in as ${escaped(signedIn.email)}.</p>
  <p><a class="button button-primary" href="${escaped(base)}/${signedIn.destination}">Open your cabinet</a></p>
  <p class="quiet">Every link opens once, so the next time you sign in, ask for a new one.</p>`;
  // Somebody already signed in cannot be sent to the sign-in form: that route
  // reads their session and redirects them back into the cabinet. Ending the
  // session is the only control here that can put them at another address.
  const another =
    signedIn === undefined
      ? `<form method="get" action="${escaped(base)}/sign-in">
    <button class="button button-secondary" type="submit">Ask for another link</button>
  </form>`
      : `<form method="post" action="${escaped(base)}/sign-out">
    <button class="button button-secondary" type="submit">Sign out and use another address</button>
  </form>`;

  return bare(
    base,
    heading,
    `<div class="gate">
${brandLockup("/")}
<div class="gate-card">
  <h1>${heading}</h1>
  ${recovery}
  ${another}
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
  <p>You are signed in${
    unavailable
      ? ", but your cabinet could not be finished because of a fault on our side"
      : ", and your cabinet is not finished yet"
  }. Nothing is lost.</p>
  <p class="quiet">You are still signed in, so Try again does not need another link.</p>
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

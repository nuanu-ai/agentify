/**
 * Asking for a link never says whether the address is new or already belongs to
 * a merchant. Opening the link only draws a form; the token is spent by the
 * POST from that form, so a mail preview cannot sign anybody in.
 */

import type { SurfaceMode } from "@agentify/core";
import type { DashboardDestination, LinkWall } from "./dashboard-entry.js";
import { bare, brandLockup, escaped } from "./html.js";

const destinationInput = (destination: DashboardDestination): string =>
  destination === "default"
    ? ""
    : `<input type="hidden" name="destination" value="${escaped(destination)}">`;

/**
 * A problem is a refusal of something the person did and is drawn under the
 * box. A reason is why they are on this page at all, such as an expired
 * session, and is the card's first line in the ordinary voice: drawn red under
 * an empty box it would read as a fault in a box nobody has typed in.
 */
export const signInScreen = (
  base: string,
  mode: SurfaceMode,
  destination: DashboardDestination = "default",
  problem?: string,
  email = "",
  reason?: string,
): string =>
  bare(
    base,
    "Sign in",
    `<div class="gate">
${brandLockup("/")}
<form class="gate-card" method="post" action="${escaped(base)}/sign-in">
  <h1>Sign in</h1>
  ${reason === undefined ? "" : `<p>${escaped(reason)}</p>`}
  <p>Enter your email address and we will send you a sign-in link.</p>
  <label for="email">Email address</label>
  <input id="email" name="email" type="email" value="${escaped(email)}" autocomplete="email" autocapitalize="off" spellcheck="false" autofocus required>
  ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  ${destinationInput(destination)}
  <button class="button button-primary" type="submit">Send me a sign-in link</button>
  <p class="quiet">Every sign-in gets its own link. It opens once and expires an hour after it is sent, so there is nothing to keep and no password to remember.</p>
  <p class="quiet">New to Agentify? Use this same form. Once the link signs you in, one button opens your seller dashboard.</p>
</form>
</div>`,
    mode,
    null,
  );

/**
 * Accepted carries a key of its own rather than the absence of a limit, so a
 * forgotten field cannot read as good news. The limit is named rather than
 * inferred from the seconds, because a minute (a link already sent) and an hour
 * (an allowance spent) need different sentences.
 */
export type LinkAnswer =
  | Readonly<{ sent: true; seconds: number }>
  | Readonly<{ wall: LinkWall; seconds: number }>;

const counted = (amount: number, unit: string): string =>
  `${amount} ${unit}${amount === 1 ? "" : "s"}`;

/**
 * Below this the button counts seconds, above it whole minutes. Ninety seconds
 * is above every one-minute wait and below any hourly wait long enough to walk
 * away from.
 */
const SECONDS_WORTH_WATCHING = 90;

/**
 * The sentence and the button show the same number and must round the same way,
 * or the page argues with itself.
 */
const waitInWords = (seconds: number): string =>
  seconds > SECONDS_WORTH_WATCHING
    ? counted(Math.ceil(seconds / 60), "minute")
    : counted(Math.max(1, Math.ceil(seconds)), "second");

/**
 * The page works without it: the button is served pressable and this takes it
 * away, because nothing can lift a `disabled` attribute where the script did
 * not run, and a button served disabled would be dead for the person most in
 * need of it. It reads the wait from the button's own attribute, so nothing in
 * it comes from anybody's input, and counts against a deadline because a
 * background tab's timers are throttled.
 */
const COUNTDOWN = `<script>
(() => {
  const button = document.querySelector("[data-link-wait]");
  if (button === null) return;
  const seconds = Number(button.getAttribute("data-link-wait"));
  if (!(seconds > 0)) return;
  const label = button.textContent;
  const until = Date.now() + seconds * 1000;
  const draw = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(tick);
      button.disabled = false;
      button.textContent = label;
      return;
    }
    button.textContent =
      label +
      (left > ${SECONDS_WORTH_WATCHING}
        ? " (" + Math.ceil(left / 60) + " min)"
        : " (" + left + " s)");
  };
  button.disabled = true;
  const tick = setInterval(draw, 1000);
  draw();
})();
</script>`;

/**
 * Never says whether the address is known. The resend is on every version of
 * the page: an accepted request cannot know the message arrived, and a refused
 * one must leave something to come back to; a refusal only changes whether it
 * can be pressed yet. Only the hourly page prints its wait in words, because a
 * person leaves the page for it.
 *
 * The minute's page may say only what the rate row holds: not where the earlier
 * link leads, since it may have been asked for elsewhere, and not delivery,
 * since the provider's side is unknown here. It says a link went to this
 * address.
 */
export const linkRequestedScreen = (
  base: string,
  mode: SurfaceMode,
  email: string,
  destination: DashboardDestination,
  answer: LinkAnswer,
): string => {
  const wall = "wall" in answer ? answer.wall : null;
  const heading = wall === "hourly" ? "Try again later" : "Check your mail";
  // A wait longer than the counted seconds can only be the hourly limit, so on
  // the page for a link that went out, inviting another send would mean most of
  // an hour's wait.
  const afterTheSend =
    answer.seconds > SECONDS_WORTH_WATCHING
      ? "If nothing has arrived in a minute, look in your spam folder. That was the last of this address's three links for the hour, so the next one waits for the hour to turn over."
      : "If nothing has arrived in a minute, look in your spam folder, then send another link from this page.";
  const outcome =
    wall === null
      ? `<p>A sign-in link is on its way to <strong>${escaped(email)}</strong>. It opens once and expires an hour after it is sent.</p>
  <p class="quiet">${afterTheSend}</p>`
      : wall === "interval"
        ? `<p>No new link was sent to <strong>${escaped(email)}</strong>. A sign-in link went to this address less than a minute ago.</p>
  <p class="quiet">Look for it in your inbox and your spam folder. The link opens wherever it was requested, which may not be this page. One address gets one link a minute, so you can ask for another as soon as the minute is up.</p>`
        : `<p>No new link was sent to <strong>${escaped(email)}</strong>. One email address gets three links an hour, and this one has had its three.</p>
  <p class="problem">Try again in ${waitInWords(answer.seconds)}.</p>`;

  return bare(
    base,
    heading,
    `<div class="gate">
${brandLockup("/")}
<div class="gate-card">
  <h1>${heading}</h1>
  ${outcome}
  <form method="post" action="${escaped(base)}/sign-in">
    <input name="email" type="hidden" value="${escaped(email)}">
    ${destinationInput(destination)}
    <button class="button button-secondary" type="submit" data-link-wait="${Math.max(0, Math.ceil(answer.seconds))}">Send another link</button>
  </form>
  <form method="get" action="${escaped(base)}/sign-in">
    ${destinationInput(destination)}
    <button class="button button-secondary" type="submit">Use a different address</button>
  </form>
</div>
${COUNTDOWN}
</div>`,
    mode,
    null,
  );
};

/**
 * "Refused" covers both a provider that rejected the message and one that did
 * not answer in time, and the second may have delivered it. What is known is
 * that the send cannot be confirmed and nothing was written.
 */
export const mailUnavailableScreen = (base: string, mode: SurfaceMode): string =>
  bare(
    base,
    "We could not confirm your sign-in link went out",
    `<div class="gate">
${brandLockup("/")}
<form class="gate-card" method="get" action="${escaped(base)}/sign-in">
  <h1>We could not confirm your sign-in link went out</h1>
  <p>Something went wrong while sending the email, so we do not know whether it was delivered. No account or session was created. Try again, and check that the email address is correct.</p>
  <button class="button button-primary" type="submit">Try again</button>
</form>
</div>`,
    mode,
    null,
  );

/**
 * Drawing it spends nothing; the press does. The address is shown because a
 * link for somebody else's address, sent to a victim, would otherwise sign them
 * in as that somebody without their noticing.
 */
export const openLinkScreen = (
  base: string,
  token: string,
  email: string,
  mode: SurfaceMode,
): string =>
  bare(
    base,
    "Sign in",
    `<div class="gate">
${brandLockup("/")}
<form class="gate-card" method="post" action="${escaped(base)}/sign-in/open">
  <h1>Sign in</h1>
  <p>This link signs <strong>${escaped(email)}</strong> in on this browser.</p>
  <input type="hidden" name="token" value="${escaped(token)}">
  <button class="button button-primary" type="submit">Sign in as ${escaped(email)}</button>
  <p class="quiet">If that is not your address, close this page. Nothing happens unless the button is pressed.</p>
</form>
</div>`,
    mode,
    null,
  );

/**
 * Drawn only for a browser with no live session, so it names nobody and says
 * nothing about whose the link was.
 */
export const refusedLinkScreen = (base: string, mode: SurfaceMode): string =>
  bare(
    base,
    "That link no longer works",
    `<div class="gate">
${brandLockup("/")}
<div class="gate-card">
  <h1>That link no longer works</h1>
  <p>A sign-in link opens once and expires an hour after it is sent. This one no longer opens anything.</p>
  <p>Nothing is lost: access belongs to your email address, not to any one link. Ask for a new one.</p>
  <form method="get" action="${escaped(base)}/sign-in">
    <button class="button button-secondary" type="submit">Ask for another link</button>
  </form>
</div>
</div>`,
    mode,
    null,
  );

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

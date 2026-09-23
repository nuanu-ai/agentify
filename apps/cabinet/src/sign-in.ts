/**
 * The cabinet's one public door: an address and a one-time link.
 *
 * Asking for a link never says whether the address is new or already belongs
 * to a merchant. Opening the URL only draws a form. The token is spent by the
 * explicit POST from that form, so a mail preview cannot sign anybody in.
 */

import type { SurfaceMode } from "@agentify/core";
import type { CabinetDestination, LinkWall } from "./cabinet-entry.js";
import { bare, brandLockup, escaped } from "./html.js";

const destinationInput = (destination: CabinetDestination): string =>
  destination === "default"
    ? ""
    : `<input type="hidden" name="destination" value="${escaped(destination)}">`;

/**
 * The sign-in form, with what went wrong and why the person is here kept apart.
 *
 * A problem is a refusal of something they did — an address of the wrong
 * shape, a change that was lost — and is drawn as one, under the box. A reason
 * is why they are looking at this page at all, such as a session that ran its
 * course, and is the card's first line in the ordinary voice: drawn red under
 * an empty box it reads as a fault in a box nobody has typed in yet, which is
 * the opposite of what that sentence is for.
 */
export const signInScreen = (
  base: string,
  mode: SurfaceMode,
  destination: CabinetDestination = "default",
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
</form>
</div>`,
    mode,
  );

/**
 * What the door answered, as the screen needs it: a wait, and which wall.
 *
 * Every answer carries a wait, because every answer leaves one: a refusal's is
 * the wall it hit, and an accepted request's is the wall in front of the next
 * link. Which arm this is has a key of its own rather than a key missing,
 * because "accepted" written as the absence of a wall is a shape where a
 * forgotten field reads as good news.
 *
 * The wall is named rather than inferred from the seconds, because the two
 * refusals are waits of different orders and the sentences that explain them
 * have nothing in common: a minute is a link already gone out, an hour is an
 * allowance spent. A screen given seconds alone would have to guess.
 */
export type LinkAnswer =
  | Readonly<{ sent: true; seconds: number }>
  | Readonly<{ wall: LinkWall; seconds: number }>;

const counted = (amount: number, unit: string): string =>
  `${amount} ${unit}${amount === 1 ? "" : "s"}`;

/**
 * How long a wait is still one somebody watches a number tick away.
 *
 * Below it the button counts seconds, above it whole minutes. The waits this
 * page draws are of two orders — the interval is a minute, waited out in front
 * of the screen, and a spent hourly allowance can be most of an hour, which
 * nobody sits through — so the line has to fall between them. Ninety seconds
 * is above every interval wait and below any hourly one long enough to walk
 * away from, and a seconds counter that runs for half an hour is a stopwatch
 * rather than a control.
 */
const SECONDS_WORTH_WATCHING = 90;

/**
 * A wait in words, by the rule the button counts it down with.
 *
 * Both readings of the same number are on the page at once, so they cannot be
 * allowed to round differently: a sentence saying "try again in 2 minutes"
 * over a button saying "(61 s)" is a page arguing with itself, and a person
 * reading it believes whichever is worse for them.
 */
const waitInWords = (seconds: number): string =>
  seconds > SECONDS_WORTH_WATCHING
    ? counted(Math.ceil(seconds / 60), "minute")
    : counted(Math.max(1, Math.ceil(seconds)), "second");

/**
 * The cabinet's one script: the resend button waiting its wait out.
 *
 * ADR-0009 §3 — the page works without it. The button is served pressable and
 * this takes it away; a browser that runs nothing is left with exactly the
 * button that was there before, the press reaches the door, and the door
 * refuses it in words. It cannot be the other way round: nothing on a page
 * whose script did not run can lift a `disabled` attribute, so a button served
 * disabled would be dead in the browser of the one person who most needs it —
 * somebody who cannot get into their cabinet and has just been told to wait.
 *
 * So the whole of it is taking a button away and giving it back. It reads the
 * wait from the button's own attribute rather than being written per request,
 * which is why nothing here is interpolated from anybody's input and why there
 * is one copy of these bytes for every page. It counts against a deadline
 * rather than trusting its own ticks, because a background tab's timers are
 * throttled and a counter built on them hands the button back late.
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
 * The non-enumerating answer to a request for a link, accepted or refused.
 *
 * The resend is on all three versions of this page. An accepted request needs
 * it because the one thing this page cannot know is whether the message
 * arrived; a refused one needs it because a page that answers a refusal by
 * removing the control leaves somebody who has just been told to wait with
 * nothing to come back to when the wait is over. What the refusal changes is
 * not whether the button is there but whether it can be pressed yet, and that
 * is what the script above says with a number the person can watch run out.
 * Both versions keep the way out for somebody who mistyped their address.
 *
 * Only the hourly page prints its wait in words as well. Its wait is one a
 * person leaves the page for, so the number has to survive being carried away;
 * the minute's does not, and a number printed into that sentence would be
 * wrong before the sentence was read, so that page says the rule instead and
 * leaves the counting to the button.
 *
 * What the interval page may say is bounded by what the rate row holds, which
 * is an address hash, a purpose and a time. Not the destination: the link
 * already gone out may have been asked for somewhere else in the cabinet and
 * opens where it was asked for, so this page cannot tell somebody it is the
 * link they just asked for. And not delivery: the door hands a message to a
 * provider and learns nothing after that, so "on its way" is a claim about
 * somebody else's system. The page says a link went to this address, which is
 * what the row knows.
 */
export const linkRequestedScreen = (
  base: string,
  mode: SurfaceMode,
  email: string,
  destination: CabinetDestination,
  answer: LinkAnswer,
): string => {
  const wall = "wall" in answer ? answer.wall : null;
  const heading = wall === "hourly" ? "Try again later" : "Check your mail";
  // A wait longer than the one a person watches can only be the hourly wall:
  // the interval is a minute from a send a moment old. So on the page for a
  // link that did go out, a long wait is this address's three spent, and the
  // invitation to send another from this page would be an invitation to wait
  // most of an hour for the button under it.
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
  <p class="quiet">Look for it in your inbox and your spam folder. It opens wherever it was asked for, which may not be here; one address gets one link a minute, so you can ask for another as soon as that minute is up.</p>`
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
  const heading =
    signedIn === undefined ? "That link no longer works" : "You are already signed in";
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

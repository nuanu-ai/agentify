/**
 * The two screens the name buyers read is chosen on: the one a merchant meets
 * straight after their merchant is attached, and the settings page it is
 * changed on afterwards.
 *
 * Skipping is allowed on the first of the two screens, because a name demanded
 * before somebody can answer it is a name nobody means. What is not allowed is
 * skipping it silently: until a name is set, publishing a card is refused, and
 * every screen a merchant works on says so with a way to fix it.
 *
 * Neither screen recites the rule before anybody types. The box carries it, in
 * `maxlength`, `pattern` and a `title` the browser shows on a refusal, and the
 * words are kept for the person who broke it. Dmitry read the settings page on
 * 2026-09-21 and said three paragraphs about a seller name is not what an
 * e-commerce admin looks like; a form that recites its own validation is the
 * first of the three to go, because almost nobody who reads it needs it.
 *
 * Neither screen fetches anything or decides anything, which is what lets a
 * test read the page a merchant would be looking at.
 */

import { ServiceNameSchema } from "@nuanu-ai/agentify-contracts";
import { accountSettings } from "./account-settings.js";
import { bare, brandLockup, escaped, page } from "./html.js";
import { payoutWalletBlock } from "./payout-wallet.js";
import type { Viewer } from "./screens.js";
import { wooSettingsBlock } from "./woo-screens.js";

/**
 * What the box holds a name to, for the browser rather than for the reader.
 *
 * The rule itself is the contract's `ServiceNameSchema`, applied by asking it
 * rather than by writing the pattern out again in code. What is written out
 * here is the browser's half of it: printable ASCII, at most thirty-two of
 * them, and the `title` a browser shows when the box refuses. The schema's own
 * rule about spaces at the ends is deliberately not in the pattern — the route
 * trims those rather than refusing them, and a box that refused a trailing
 * space would be the browser stopping a name the server would have taken.
 */
export const NAME_BOX =
  'maxlength="32" pattern="[ -~]{1,32}" title="1 to 32 printable ASCII characters"';

/**
 * What somebody is told whose name the catalogue would not carry.
 *
 * This is where the rule now lives in words: the screens no longer print it,
 * so a refusal that only said "that will not do" would leave somebody guessing
 * at a limit nothing on the page had named. The second half is what the person
 * cannot see for themselves — that nothing was written.
 *
 * The name is checked here as well as at the gateway so that this is what comes
 * back rather than the gateway's own refusal, which is written for whoever is
 * reading an API response and names a route rather than a page.
 */
export const NAME_REFUSED =
  "Use 1 to 32 characters of printable ASCII (Latin letters, numbers, spaces or common punctuation)" +
  " with no space at either end. Your name was not saved.";

/** What somebody who pressed the button with an empty box is told, first time. */
export const NAME_NEEDED =
  "A name is needed here. If you have not settled on one yet, leave this for now with the link" +
  " below and come back to it in your settings.";

/**
 * What somebody is told who tries to empty the name they already have.
 *
 * The route refuses it, and that is a rule rather than a gap in the screen. A
 * card on sale with nobody named beside it reaches a buyer inside a request to
 * pay somebody the request does not name, which is the thing this whole field
 * exists to stop. Coming off sale is a different act with a different control,
 * and it is the one that does what somebody emptying this box actually wants:
 * it leaves the cards where they are, so a merchant can put them back.
 */
export const NAME_CANNOT_BE_TAKEN_AWAY =
  "This name cannot be empty while you have a merchant. To come off sale, stop your selling on the" +
  " Cards screen; your cards stay there until you resume.";

/** What is wrong with a name somebody typed, in a sentence, or null. */
export const whatIsWrongWithTheName = (name: string): string | null =>
  ServiceNameSchema.safeParse(name).success ? null : NAME_REFUSED;

/**
 * The screen a merchant lands on the moment their account exists.
 *
 * Drawn with no navigation because it is the last step of first-time setup
 * rather than a page inside the cabinet. The way out is a link and not a hidden
 * field: whoever skips goes to their cards, which is where the same fact is
 * waiting for them with the page that fixes it.
 *
 * One sentence of instruction, the box, the button, the way past. What the
 * name is for is the one thing a merchant cannot work out from the label, and
 * it is a line rather than a paragraph.
 */
export const chooseNameScreen = (
  base: string,
  mode: Viewer["mode"],
  problem?: string,
  typed = "",
): string =>
  bare(
    base,
    "The name your products are sold under",
    `<div class="gate">
${brandLockup("/")}
<form class="gate-card" method="post" action="${escaped(base)}/choose-name">
  <h1>Choose your seller name</h1>
  <p>Buyers see this name beside your products.</p>
  <label for="seller_name">Seller name</label>
  <input id="seller_name" name="seller_name" type="text" autocomplete="organization" ${NAME_BOX} value="${escaped(typed)}" autofocus required>
  ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  <button class="button button-primary" type="submit">Use this name</button>
  <p class="quiet">You can change it later in <a href="${escaped(base)}/settings">Settings</a>.</p>
  <p class="quiet">Not decided yet? <a href="${escaped(base)}/cards">Leave it for now</a>.</p>
</form>
</div>`,
    mode,
  );

/**
 * The cabinet's settings, which hold four subjects.
 *
 * A page of its own rather than controls tucked onto the cards screen: none of
 * these is about a card, all of them are about the merchant. The name buyers
 * read is here; under it the address the merchant's money arrives at, which
 * lives in `payout-wallet.ts`; under that the WooCommerce shop a merchant can
 * sell the catalogue of, which is drawn by `woo-screens.ts` from the connection
 * this page was handed; and last the merchant's own account, which lives in
 * `account-settings.ts`. That one arrived because the address in the corner of
 * every page is the one thing on a screen that says "this is you" — pressing it
 * has to lead somewhere that answers that, and the answer is a page with the
 * account on it.
 *
 * The order is the things about selling first and the account last, because a
 * merchant setting themselves up works down the page: what they are called,
 * where they are paid, where their products come from, and only then how they
 * get back in.
 *
 * The shape of every card is the same and is the shape Dmitry asked for on
 * 2026-09-21: a heading, the control, and one helper line under the box. No
 * lede over the page — a sentence naming what is on a page that fits on a
 * screen is a table of contents for the screen you are already looking at —
 * and no paragraph in front of a field. The rules the panels used to print are
 * in the boxes and in the refusals.
 *
 * The name box normally shows what the gateway answered. After a refusal it
 * keeps the rejected value so the merchant can correct it.
 */
export const settingsScreen = (viewer: Viewer, problem?: string, typedName?: string): string => {
  const { base } = viewer;
  const name = viewer.sellerName ?? null;

  const body = `
  <div class="lede">
    <div>
      <h1>Settings</h1>
    </div>
  </div>
  <div class="settings-grid">
  <section class="settings-panel">
  <div class="lede">
    <div>
      <h2>Seller name</h2>
    </div>
  </div>
  <form class="issue" method="post" action="${escaped(base)}/settings">
    <div>
      <label for="seller_name">The name buyers read</label>
      <input id="seller_name" name="seller_name" type="text" autocomplete="organization" aria-describedby="seller_name_help" ${NAME_BOX} value="${escaped(typedName ?? name ?? "")}" required>
    </div>
    <button class="button button-compact button-primary" type="submit">Save</button>
    <p class="quiet" id="seller_name_help">${
      // Unset is not a preference, it is a state in which the merchant's own
      // code is being refused, so the helper says the consequence while it
      // lasts. The cards screen carries the same fact in a banner; this page
      // is the one with the box that ends it.
      name === null
        ? "Buyers see this beside your products. Until it is set, publishing a card is refused."
        : "The name buyers see beside your products."
    } <a href="/docs/quickstart#_1-make-the-merchant-account-ready">Learn more</a>.</p>
    ${
      problem === undefined
        ? ""
        : `<p class="problem">${escaped(problem)}</p>${
            // The box is holding what was refused, so the page has stopped
            // showing what a merchant is actually listed under. Which name is
            // live is the thing they cannot see for themselves after a
            // refusal, and it is four words.
            name === null ? "" : `<p class="quiet">Still listed as ${escaped(name)}.</p>`
          }`
    }
  </form>
  </section>
  <section class="settings-panel">${payoutWalletBlock(viewer)}</section>
  ${
    viewer.shop === undefined
      ? ""
      : `<section class="settings-panel">${wooSettingsBlock(base, viewer.shop)}</section>`
  }
  <section class="settings-panel">${accountSettings(viewer)}</section>
  </div>`;

  return page({
    mode: viewer.mode,
    base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: "settings",
    title: "Settings",
    body,
  });
};

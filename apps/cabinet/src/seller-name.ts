/**
 * The two screens the name buyers read is chosen on: the one a merchant meets
 * straight after their merchant is attached, and the settings page it is
 * changed on afterwards. The choice is a public answer printed beside the
 * products every buyer sees, so the first screen says what the name does before
 * asking for it and promises it can be changed.
 *
 * Skipping is allowed on the first of the two screens, because a name demanded
 * before somebody can answer it is a name nobody means. What is not allowed is
 * skipping it silently: until a name is set, publishing a card is refused, and
 * every screen a merchant works on says so with a way to fix it.
 *
 * Neither screen fetches anything or decides anything, which is what lets a
 * test read the page a merchant would be looking at.
 */

import { ServiceNameSchema } from "@nuanu-ai/agentify-contracts";
import { accountSettings } from "./account-settings.js";
import { bare, brandLockup, escaped, page } from "./html.js";
import { payoutWalletBlock } from "./payout-wallet.js";
import { refusedForNoName, type Viewer } from "./screens.js";
import { wooSettingsBlock } from "./woo-screens.js";

/**
 * What a name has to be, said in words a person can act on.
 *
 * The rule itself is the contract's `ServiceNameSchema` and is applied by
 * asking it rather than by writing it out again in code: it is the discovery
 * catalogue's own rule, because that catalogue is where this name goes, and a
 * second copy of it here would be the copy that goes stale. What is written out
 * is only the sentence, because the schema's messages are one per broken rule
 * and somebody filling in a form is better served by the whole rule once.
 *
 * It is on both screens before anybody types, rather than only after a refusal,
 * so that the common case is a name that fits.
 */
export const NAME_RULE =
  "Use 1 to 32 characters of printable ASCII: Latin letters, numbers, spaces or common punctuation," +
  " with no space at either end.";

/**
 * What somebody is told whose name the catalogue would not carry.
 *
 * The rule, whole, and then the half the person cannot see for themselves:
 * that nothing was written. Because it carries the rule, the first screen does
 * not print its own copy of the rule under a refusal of this kind — the same
 * paragraph twice in a row reads as the page failing to notice anything
 * happened.
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
 * What the name is for, and what one looks like.
 *
 * The example is the shape of the mistake rather than a decorated version of
 * the rule: the name people already know, not a description of the goods. A
 * merchant who writes their catalogue into this box ends up listed under their
 * own stock list, and nothing further down the line corrects it.
 *
 * On the first screen only. It was on both, and the settings panel is headed
 * "The name your products are sold under", which is the same sentence in four
 * words over the box it belongs to.
 */
const WHAT_IT_IS_FOR = `<p>Buyers see this seller name beside your products and in the payment they approve. Use the name people already know you by, rather than a description of what you sell.</p>`;

/**
 * The screen a merchant lands on the moment their account exists.
 *
 * Drawn with no navigation because it is the last step of first-time setup
 * rather than a page inside the cabinet. The way out
 * is a link and not a hidden field: whoever skips goes to their cards, which is
 * where the same fact is waiting for them with the page that fixes it.
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
  <p>Your account is ready. Choose the seller name buyers will see.</p>
  <label for="seller_name">The name your products are sold under</label>
  <input id="seller_name" name="seller_name" type="text" autocomplete="organization" maxlength="32" value="${escaped(typed)}" autofocus required>
  ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  ${problem === NAME_REFUSED ? "" : `<p class="quiet">${escaped(NAME_RULE)}</p>`}
  <button class="button button-primary" type="submit">Use this name</button>
  ${WHAT_IT_IS_FOR}
  <p class="quiet">You can change it in <a href="${escaped(base)}/settings">Settings</a>; until it is set, nothing you publish goes on sale.</p>
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
 * The four are not the same kind of thing, so each is under a heading that
 * names which it is. Somebody landing here should be able to tell which part
 * they came for without reading the others.
 *
 * The name box normally shows what the gateway answered. After a refusal it
 * keeps the rejected value so the merchant can correct it; the heading still
 * says which name is actually saved.
 */
export const settingsScreen = (viewer: Viewer, problem?: string, typedName?: string): string => {
  const { base } = viewer;
  const name = viewer.sellerName ?? null;

  const body = `
  <div class="lede">
    <div>
      <h1>Settings</h1>
      <p>${escaped(
        // The one thing on this page a merchant can be caught out by, and
        // nothing else. What else is here is under headings a few lines down,
        // and a sentence listing them would be a table of contents for a page
        // that fits on a screen — one more thing to rewrite the day a third
        // section is added, and one more line between somebody and the box
        // they came to fill in.
        name === null
          ? `You have not chosen the name your products are sold under.${refusedForNoName(viewer) ? " Until you do, publishing a card is refused." : ""}`
          : `Your products are sold under ${name}.`,
      )}</p>
    </div>
  </div>
  <div class="settings-grid">
  <section class="settings-panel">
  <div class="lede">
    <div>
      <h2>The name your products are sold under</h2>
      <p class="quiet">${escaped(NAME_RULE)}</p>
      <p class="quiet">${escaped(NAME_CANNOT_BE_TAKEN_AWAY)}</p>
    </div>
  </div>
  <form class="issue" method="post" action="${escaped(base)}/settings">
    <div>
      <label for="seller_name">The name buyers read</label>
      <input id="seller_name" name="seller_name" type="text" autocomplete="organization" maxlength="32" value="${escaped(typedName ?? name ?? "")}" required>
    </div>
    <button class="button button-primary" type="submit">Save it</button>
    ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
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

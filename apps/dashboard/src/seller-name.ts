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

import { SellerSiteSchema, ServiceNameSchema } from "@nuanu-ai/agentify-contracts";
import { accountSettings } from "./account-settings.js";
import { STOP_ALL_SELLING } from "./control-labels.js";
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
  " as plain text, without HTML tags or codes such as &amp;. Spaces at either end are removed.";

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
  " as plain text, without HTML tags or codes such as &amp;. Your name was not saved.";

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
  `The seller name cannot be empty once you have an account. To stop selling, use ${STOP_ALL_SELLING}` +
  " on the Cards screen; your cards stay there until you resume.";

/** What is wrong with a name somebody typed, in a sentence, or null. */
export const whatIsWrongWithTheName = (name: string): string | null =>
  ServiceNameSchema.safeParse(name).success ? null : NAME_REFUSED;

/**
 * What the shop's site is for and the form it takes, before anybody types.
 *
 * The form is the contract's `SellerSiteSchema` (ADR-0034), asked rather than
 * written out again; the sentence is for the person filling the box, and it
 * says what agents do with the address and that nobody checks it, because
 * both are things a merchant would otherwise assume the other way.
 */
export const SITE_RULE =
  "The address of your shop's own website: https:// and your domain, with nothing after it," +
  " such as https://yourshop.com. Agents read it beside your seller name on every card and order," +
  " as where to go with what an order cannot answer — goods that did not arrive, a return, your" +
  " terms. Agentify does not check it.";

/** What somebody is told whose address is not a site's bare https address. */
export const SITE_REFUSED =
  "Write the address as https:// and your shop's public domain, with nothing after it:" +
  " https://yourshop.com, in lower case, with no page, query, port or slash at the end." +
  " Your site was not saved.";

/**
 * What somebody is told who empties a site they already gave.
 *
 * Refused for the reason the gateway refuses it: an agent holding an order
 * that named the site has been told where to go, and a site that vanished
 * would leave it nowhere. A shop that moved gives the address it moved to.
 */
export const SITE_CANNOT_BE_TAKEN_AWAY =
  "A site cannot be removed once given, only changed: type the address your shop has moved to.";

/** What is wrong with a site somebody typed, in a sentence, or null. */
export const whatIsWrongWithTheSite = (site: string): string | null =>
  SellerSiteSchema.safeParse(site).success ? null : SITE_REFUSED;

/** A refused site, and what was typed, for the settings screen to draw. */
export interface RefusedSite {
  readonly problem: string;
  readonly typed: string;
}

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
 * rather than a page inside the dashboard. The way out
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
  <p class="quiet gate-skip">Not decided yet? <a href="${escaped(base)}/cards">Leave it for now</a>.</p>
</form>
</div>`,
    mode,
  );

/**
 * The dashboard's settings, which hold three account subjects.
 *
 * A page of its own rather than controls tucked onto the cards screen: none of
 * these is about a card, all of them are about the merchant. The name buyers
 * read is here; beside it is the address the merchant's money arrives at,
 * which lives in `payout-wallet.ts`; and last is the merchant's own account,
 * which lives in `account-settings.ts`. Integrations and plan and billing have
 * their own navigation sections. The account block arrived because the address in the corner of
 * every page is the one thing on a screen that says "this is you" — pressing it
 * has to lead somewhere that answers that, and the answer is a page with the
 * account on it.
 *
 * The order is the things about selling first and the account last, because a
 * merchant setting themselves up works down the page: what they are called,
 * where they are paid, and then how they get back in.
 *
 * The three are not the same kind of thing, so each is under a heading that
 * names which it is. Somebody landing here should be able to tell which part
 * they came for without reading the others.
 *
 * The name box normally shows what the gateway answered. After a refusal it
 * keeps the rejected value so the merchant can correct it; the heading still
 * says which name is actually saved.
 */
export const settingsScreen = (
  viewer: Viewer,
  problem?: string,
  typedName?: string,
  refusedSite?: RefusedSite,
): string => {
  const { base } = viewer;
  const name = viewer.sellerName ?? null;
  const site = viewer.sellerSite ?? null;

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
          ? `You have not set a seller name yet.${refusedForNoName(viewer) ? " Until you do, cards cannot be published." : ""}`
          : `Your products are sold under ${name}.`,
      )}</p>
    </div>
  </div>
  <div class="settings-grid">
  <section class="settings-panel settings-pair">
  <div class="panel-top">
  <div class="lede">
    <div>
      <h2>Seller name</h2>
      <p class="quiet">${escaped(NAME_RULE)}</p>
      ${problem === NAME_CANNOT_BE_TAKEN_AWAY ? "" : `<p class="quiet">${escaped(NAME_CANNOT_BE_TAKEN_AWAY)}</p>`}
    </div>
  </div>
  </div>
  <form class="issue" method="post" action="${escaped(base)}/settings">
    <div>
      <label for="seller_name">Your seller name</label>
      <input id="seller_name" name="seller_name" type="text" autocomplete="organization" maxlength="32" value="${escaped(typedName ?? name ?? "")}" required>
    </div>
    <button class="button button-primary" type="submit">Save</button>
  </form>
  <div class="panel-messages">${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}</div>
  <h2>Your shop's site</h2>
  <p class="quiet">${escaped(SITE_RULE)}</p>
  <form class="issue" method="post" action="${escaped(base)}/settings/site">
    <div>
      <label for="seller_site">Your shop's site</label>
      <input id="seller_site" name="seller_site" type="url" autocomplete="url" inputmode="url" placeholder="https://yourshop.com" value="${escaped(refusedSite?.typed ?? site ?? "")}" required>
    </div>
    <button class="button button-primary" type="submit">Save</button>
  </form>
  <div class="panel-messages">${refusedSite === undefined ? "" : `<p class="problem">${escaped(refusedSite.problem)}</p>`}</div>
  </section>
  <section class="settings-panel settings-pair">${payoutWalletBlock(viewer)}</section>
  <section class="settings-panel settings-wide settings-account">${accountSettings(viewer)}</section>
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

/**
 * The ways a catalogue reaches Agentify: the merchant's own code through the
 * SDK, which is the product's path and comes first, or a WooCommerce shop
 * through the experimental connector, where this dashboard has one. A tab of its own, because they are integrations,
 * and halfway down the settings, under the name and the wallet, is not where
 * anybody looks for one.
 */
export const integrationsScreen = (viewer: Viewer): string => {
  const { base } = viewer;
  const body = `
  <div class="lede">
    <div>
      <h1>Integrations</h1>
      <p>${
        viewer.shop === undefined
          ? "Your products reach Agentify from your own code through the SDK."
          : "Your products reach Agentify from your own code through the SDK, or from a WooCommerce shop through the experimental connector."
      }</p>
    </div>
  </div>
  <div class="settings-grid">
  <section class="settings-panel settings-wide settings-connect">
    <div class="connect-ways">
      <div class="connect-way">
        <h3>The SDK</h3>
        <p class="quiet">Your developer installs the <code>@nuanu-ai/agentify</code> package in a Node.js service, publishes cards with an API key, and handles paid orders in your own code.</p>
        <div class="connect-actions">
          <a class="button button-primary" href="/docs/quickstart">Open the connection guide</a>
          <a class="button button-secondary" href="${escaped(base)}/keys?new=key">Create an API key</a>
        </div>
      </div>
      ${
        viewer.shop === undefined
          ? ""
          : `<div class="connect-way">${wooSettingsBlock(base, viewer.shop)}</div>`
      }
    </div>
  </section>
  </div>`;

  return page({
    mode: viewer.mode,
    base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: "integrations",
    title: "Integrations",
    body,
  });
};

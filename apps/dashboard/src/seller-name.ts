/**
 * The screens where the name buyers read beside every product is chosen and
 * changed. Skipping is allowed on the first screen, but never silently: until a
 * name is set, publishing a card is refused, and every screen a merchant works
 * on says so with a way to fix it.
 */

import { SellerSiteSchema, ServiceNameSchema } from "@nuanu-ai/agentify-contracts";
import { accountSettings } from "./account-settings.js";
import { STOP_ALL_SELLING } from "./control-labels.js";
import { bare, brandLockup, escaped, page } from "./html.js";
import { payoutWalletBlock } from "./payout-wallet.js";
import { refusedForNoName, type Viewer } from "./screens.js";
import { APPROVAL_GIVEN, APPROVAL_PENDING } from "./words.js";

/**
 * The rule itself is the contract's `ServiceNameSchema`, the discovery
 * catalogue's own rule, and is applied by asking it; only the sentence is
 * written out, because the schema reports one message per broken rule.
 */
export const NAME_RULE =
  "Use 1 to 32 characters of printable ASCII: Latin letters, numbers, spaces or common punctuation," +
  " as plain text, without HTML tags or codes such as &amp;. Spaces at either end are removed.";

/**
 * The rule whole, then what the person cannot see: that nothing was written.
 * The name is checked here as well as at the gateway so the person reads this
 * rather than the gateway's refusal, which names a route rather than a page.
 */
export const NAME_REFUSED =
  "Use 1 to 32 characters of printable ASCII (Latin letters, numbers, spaces or common punctuation)" +
  " as plain text, without HTML tags or codes such as &amp;. Your name was not saved.";

export const NAME_NEEDED =
  "A name is needed here. If you have not settled on one yet, leave this for now with the link" +
  " below and come back to it in your settings.";

/**
 * Emptying the name is refused by rule: a card on sale with nobody named beside
 * it reaches a buyer as a request to pay somebody it does not name. Coming off
 * sale is the control that does what somebody emptying the box wants.
 */
export const NAME_CANNOT_BE_TAKEN_AWAY =
  `The seller name cannot be empty once you have an account. To stop selling, use ${STOP_ALL_SELLING}` +
  " on the Cards screen; your cards stay there until you resume.";

export const whatIsWrongWithTheName = (name: string): string | null =>
  ServiceNameSchema.safeParse(name).success ? null : NAME_REFUSED;

/**
 * The form is the contract's `SellerSiteSchema`, applied by asking it. The
 * sentence says what agents do with the address and that nobody checks it,
 * because a merchant would otherwise assume both the other way.
 */
export const SITE_RULE =
  "The address of your shop's own website: https:// and your domain, with nothing after it," +
  " such as https://yourshop.com. Agents read it beside your seller name on every card and order," +
  " as where to go with what an order cannot answer — goods that did not arrive, a return, your" +
  " terms. Agentify does not check it.";

export const SITE_REFUSED =
  "Write the address as https:// and your shop's domain name, with nothing after it:" +
  " https://yourshop.com, in lower case, with no page, query, port or slash at the end." +
  " Your site was not saved.";

/**
 * Refused for the reason the gateway refuses it: an agent holding an order that
 * named the site has been told where to go, and a vanished site would leave it
 * nowhere.
 */
export const SITE_CANNOT_BE_TAKEN_AWAY =
  "A site cannot be removed once given, only changed: type the address your shop has moved to.";

export const whatIsWrongWithTheSite = (site: string): string | null =>
  SellerSiteSchema.safeParse(site).success ? null : SITE_REFUSED;

export interface RefusedSite {
  readonly problem: string;
  readonly typed: string;
}

/**
 * The example is the shape of the common mistake: the name people already know,
 * not a description of the goods. A catalogue written into this box becomes the
 * listing name, and nothing further down the line corrects it.
 */
const WHAT_IT_IS_FOR = `<p>Buyers see this seller name beside your products and in the payment they approve. Use the name people already know you by, rather than a description of what you sell.</p>`;

/**
 * No navigation: this is the last step of first-time setup. Skipping is a link
 * to the cards screen, where the same missing-name notice waits with the page
 * that fixes it.
 */
export const chooseNameScreen = (
  base: string,
  mode: Viewer["mode"],
  who: string,
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
    who,
  );

/**
 * The name buyers read, the payout wallet (`payout-wallet.ts`) and the account
 * (`account-settings.ts`), each under its own heading.
 *
 * After a refusal the name box keeps the rejected value so the merchant can
 * correct it; the heading still says which name is actually saved.
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
        name === null
          ? `You have not set a seller name yet.${refusedForNoName(viewer) ? " Until you do, cards cannot be published." : ""}`
          : `Your products are sold under ${name}.`,
      )}</p>
      ${
        // Only in live mode, and only when the route read the approval: a
        // screen that did not ask says nothing rather than guess.
        viewer.mode === "live" && viewer.liveApproval !== undefined
          ? `<p>${escaped(viewer.liveApproval ? APPROVAL_GIVEN : APPROVAL_PENDING)}</p>`
          : ""
      }
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
  <div class="panel-messages">${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  <div class="panel-follow">
  <h2>Your shop's site</h2>
  <p class="quiet">${escaped(SITE_RULE)}</p>
  <form class="issue" method="post" action="${escaped(base)}/settings/site">
    <div>
      <label for="seller_site">Your shop's site</label>
      <input id="seller_site" name="seller_site" type="url" autocomplete="url" inputmode="url" placeholder="https://yourshop.com" value="${escaped(refusedSite?.typed ?? site ?? "")}" required>
    </div>
    <button class="button button-primary" type="submit">Save</button>
  </form>
  ${refusedSite === undefined ? "" : `<p class="problem">${escaped(refusedSite.problem)}</p>`}
  </div>
  </div>
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

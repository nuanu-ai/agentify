/**
 * The shop's `success=1` redirect is the shop telling the browser what it did;
 * the keys travel separately, posted from the shop's server to ours, and
 * anybody can type `success=1` into an address bar. So these pages say what our
 * rows hold, never what the redirect claims, and where nothing arrived they say
 * that rather than "it failed", which is not known.
 */

import type { SurfaceMode } from "@agentify/core";
import type { Integration } from "@agentify/gateway";
import { bare, brandLockup, escaped, page, when } from "./html.js";
import { refusedForNoName, type Viewer } from "./screens.js";
import type { SkippedProduct } from "./woo-catalog.js";
import { GRANT_MINUTES } from "./woo-connect.js";
import { PRODUCTS_AT_MOST } from "./woo-shop.js";
import { UNSET_WORDS, type Unset } from "./words.js";

/**
 * A shape of its own rather than the stored row, which also holds the shop's
 * key and secret: a type keeps those off every page.
 */
export interface ConnectedShop {
  readonly shopUrl: string;
  readonly permissions: string;
  readonly connectedAt: Date;
}

/**
 * "Not connected" would cover both "you have not tried" and "you tried and
 * nothing came", and the next moves differ: press the button, or wait and then
 * press again. The rows do not say why nothing came (declined, screen closed,
 * or a failed post all look the same), so that state names no cause. The clock
 * is read before this is built, so every screen draws one answer.
 */
export type ShopState =
  /** The only state in which anything can be sold. */
  | { readonly kind: "connected"; readonly shop: ConnectedShop }
  /** The fifteen minutes are still running, approved or not. */
  | {
      readonly kind: "waiting";
      readonly shopUrl: string;
      readonly startedMinutesAgo: number;
    }
  /** The fifteen minutes ran out with no keys here; why is not known. */
  | { readonly kind: "unanswered"; readonly shopUrl: string }
  | { readonly kind: "none" };

/**
 * `unread` is a state of what we know, not of the channel, and stays out of
 * `ShopState` because the shop screen is never drawn without a read. The
 * integrations screen also serves the SDK, so it draws this case and says so: a
 * block that vanished would read as "no shop is connected" to a merchant who
 * connected one, and "I don't know" must be distinguishable from "there is
 * none".
 */
export type ShopTile = ShopState | { readonly kind: "unread" };

export interface WooView {
  /** Read off our own rows. */
  readonly state: ShopState;
  /** As the gateway answered when the page was drawn. */
  readonly unset?: readonly Unset[];
  /**
   * Where this page answers a press of Import: what was unset at that moment,
   * before the shop was read.
   */
  readonly refused?: readonly Unset[];
  readonly problem?: string;
  /**
   * Why going back to their own code was just refused: drawn beside the
   * control that asked, not under the Connect box.
   */
  readonly leaving?: string;
  /**
   * Why selling through the connected shop was refused, or why Import was,
   * for a merchant still on their code: drawn beside the switch.
   */
  readonly switching?: string;
  /** Whether the merchant's selling is stopped, so that nothing imported sells. */
  readonly stopped?: boolean;
  /** So a refusal leaves the box as they left it. */
  readonly typed?: string;
  /**
   * The integration the merchant sells through, read off the gateway when the
   * page was drawn.
   */
  readonly through: Integration;
  /**
   * Set by the return route for any browser with a session, whatever query it
   * carried, so typing the address in sets it too. It changes what the page
   * says, never what it claims: the state is read off our rows either way.
   */
  readonly cameBack?: boolean;
}

const minutesAgo = (minutes: number): string =>
  minutes < 1 ? "less than a minute ago" : `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;

/**
 * Two sentences because the move differs: inside the fifteen minutes, wait;
 * past them a post would meet an expired token, so press Connect again. Neither
 * names a cause, because the rows hold the same nothing whether the merchant
 * declined, closed the screen, or approved and the shop's post failed. What may
 * be said is WooCommerce's own behaviour: a shop whose post fails or is refused
 * shows an error on its own screen and deletes the key it minted
 * (`class-wc-auth.php`, `post_consumer_data` and `maybe_delete_key`). What that
 * error says is not promised. The integrations screen says the same words.
 */
export const keysNotArrived = (
  state: Extract<ShopState, { kind: "waiting" | "unanswered" }>,
): Readonly<{ what: string; why: string }> =>
  state.kind === "waiting"
    ? {
        what: "Waiting for the keys from your shop",
        why: `You started connecting ${state.shopUrl} ${minutesAgo(state.startedMinutesAgo)}, and no keys have reached us yet. If you approved, your shop sends the keys in a separate request; reload in a moment to see whether they arrived. If you declined or closed the approval screen, you can start again now.`,
      }
    : {
        what: "The keys from your shop did not arrive",
        why: `You started connecting ${state.shopUrl}, and no keys arrived from it in the ${GRANT_MINUTES} minutes we wait for them. This page cannot tell whether approval was declined, closed or rejected before it was saved. No access from that attempt is active here. Press Connect again; if WooCommerce showed an error, it already removed the key from that attempt.`,
      };

const noKeysYet = (state: ShopState, action = ""): string => {
  if (state.kind !== "waiting" && state.kind !== "unanswered") {
    return "";
  }
  const said = keysNotArrived(state);
  return `  <div class="callout">
    <div class="what">${escaped(said.what)}</div>
    <div class="why">${escaped(said.why)}</div>
${state.kind === "waiting" ? `${action}\n` : ""}  </div>
`;
};

/**
 * Said once, here, on the page with Connect and Import, which is the only
 * place the connector is described; the integrations block links here.
 */
const WHAT_CONNECTING_DOES = `<p>The WooCommerce connector works in test mode only for now. It imports published simple products priced in USD, with no stock management, from a shop whose tax calculation is turned off, in two narrow configurations. A virtual download with one protected file and unlimited downloads is handed to the agent once it is paid for. A physical product, neither virtual nor downloadable, is sold as a parcel: the agent pays its price plus your shop's own cheapest shipping rate to the buyer's place, and your shop gets a paid order carrying the buyer's shipping address.</p>
  <p class="quiet">Connecting gives Agentify access to your shop, and importing publishes supported products as cards. You approve access in WooCommerce; Agentify never asks for your shop password.</p>
  <p class="quiet">You sell through your shop or through your own code, one at a time. While you sell through the shop, the cards your code published are off sale and your code receives no orders; disconnecting the shop here brings them back.</p>`;

export const wooScreen = (viewer: Viewer, view: WooView): string => {
  const { base } = viewer;
  const body = `
  <div class="integration-shell">
  <div class="lede">
    <div>
      <h1>WooCommerce</h1>
      ${WHAT_CONNECTING_DOES}
    </div>
  </div>
${view.cameBack === true && view.state.kind === "connected" ? KEYS_ARRIVED : ""}${
  view.state.kind === "connected"
    ? theConnection(base, view.state.shop, view)
    : `${view.through === "woocommerce" ? theWayBack(base, view) : ""}${noKeysYet(
        view.state,
        // Only the wait has a next step of its own; a Connect that ran out is
        // answered by the form below it.
        view.state.kind === "waiting"
          ? `    <div class="connect-actions"><a class="button button-secondary" href="${escaped(base)}/woocommerce">Check again</a></div>`
          : "",
      )}${theForm(base, view)}`
}
  </div>`;

  return page({
    mode: viewer.mode,
    base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: "integrations",
    title: "WooCommerce",
    unnamed: refusedForNoName(viewer),
    body,
  });
};

/**
 * Drawn off the row, never off the redirect: the return route reads neither
 * `success=1` nor `success=0`, and a signed-in merchant reaches this page by
 * typing the address as surely as by being sent. What a merchant reads on
 * coming back is what the block below says on a reload or tomorrow.
 */
const KEYS_ARRIVED = `  <div class="callout done">
    <div class="what">Your shop is connected: the keys came directly from its server.</div>
  </div>
`;

/**
 * The session cookie is `SameSite=Lax`, so a signed-in browser coming back from
 * its shop is sent on into the dashboard before this is drawn. What arrives
 * here came back without a session (it ended meanwhile, or the shop was opened
 * in another browser), and a sign-in form here would read as a failed connect.
 *
 * So the page is for anybody and every word may be read by anybody: it says
 * what this address is for, not that a connection happened, names no account,
 * shop or key, and is the same whatever this dashboard holds. It asks for no
 * email and does not interpret the untrusted redirect query.
 */
export const wooReturnScreen = (base: string, mode: SurfaceMode): string =>
  bare(
    base,
    "Back from your shop",
    `<div class="gate">
  ${brandLockup("/")}
  <form class="gate-card" method="get" action="${escaped(base)}/woocommerce">
    <h1>Back from your shop</h1>
    <p>Continue to your dashboard to see whether access reached Agentify. If you chose not to connect, you can try again there.</p>
    <input type="hidden" name="from" value="shop">
    <button class="button button-primary" type="submit">Continue to your dashboard</button>
  </form>
</div>`,
    mode,
    null,
  );

/**
 * The way back to the merchant's own code for one who sells through a shop
 * that is not connected: they pressed Connect and never approved, or the
 * account was put on the shop by cards it had imported, with no shop
 * connected. Nothing reads a shop for them, so the shop's cards cannot sell,
 * and the code's are off sale until they press this.
 */
const theWayBack = (
  base: string,
  view: WooView,
): string => `  <form class="issue" method="post" action="${escaped(base)}/woocommerce/disconnect">
    <div>
      <label>You sell through a WooCommerce shop, and none is connected</label>
      <p class="quiet">Nothing sells until a shop is connected. To sell through your own code instead, switch back: the cards your code published come back, with selling stopped until you start it again on Cards.</p>
      ${view.leaving === undefined ? "" : `<p class="problem">${escaped(view.leaving)}</p>`}
    </div>
    <button class="button button-secondary" type="submit">Sell through your own code</button>
  </form>
`;

/**
 * The switch to the connected shop, for a merchant whose shop is here while
 * they sell through their own code: a Disconnect cut off between moving them
 * back and forgetting the shop leaves them so, and so can two tabs. Nothing
 * imported sells until they press it.
 */
const theSwitch = (
  base: string,
  view: WooView,
): string => `  <form class="issue" method="post" action="${escaped(base)}/woocommerce/switch">
    <div>
      <label>You sell through your own code</label>
      <p class="quiet">This shop is connected, but its cards are off sale and nothing can be imported while you sell through your own code. Selling through the shop takes the cards your code published off sale, and your code receives no orders until you disconnect the shop here.</p>
      ${view.switching === undefined ? "" : `<p class="problem">${escaped(view.switching)}</p>`}
    </div>
    <button class="button button-primary" type="submit">Sell through this shop</button>
  </form>
`;

const theForm = (base: string, view: WooView): string => `  <div class="lede">
    <div>
      <h2>Connect your shop</h2>
      <p>Type the address you open your own shop at. Your browser goes there next, so that WooCommerce can ask you to approve.</p>${
        view.through === "api"
          ? `
      <p class="quiet">Pressing Connect switches you to selling through the shop at once, before you approve: the cards your code published go off sale and your code receives no orders. Orders your code is still working on have to finish first.</p>`
          : ""
      }
      <p class="quiet">Use the public https address at the root of the shop. WooCommerce permalinks must be set to anything other than Plain.</p>
    </div>
  </div>
  <form class="issue" method="post" action="${escaped(base)}/woocommerce/connect">
    <div>
      <label for="shop_url">The address of your shop</label>
      <input id="shop_url" name="shop_url" type="url" inputmode="url" placeholder="https://shop.example.com" value="${escaped(view.typed ?? (view.state.kind === "waiting" || view.state.kind === "unanswered" ? view.state.shopUrl : ""))}" required>
    </div>
    <button class="button button-primary" type="submit">Connect</button>
    ${view.problem === undefined ? "" : `<p class="problem">${escaped(view.problem)}</p>`}
  </form>
`;

/**
 * The refusal is drawn here as well as on the form because it is about
 * something different: what the shop answered when we read it, not what was
 * just typed.
 */
const theConnection = (
  base: string,
  connection: ConnectedShop,
  view: WooView,
): string => `  <div class="lede">
    <div>
      <h2>Your shop</h2>
      <p>${escaped(connection.shopUrl)}, connected ${when(connection.connectedAt.toISOString())}.</p>
      ${view.problem === undefined ? "" : `<p class="problem">${escaped(view.problem)}</p>`}
      ${
        connection.permissions === "read_write"
          ? ""
          : `<p class="problem">Your shop granted ${escaped(connection.permissions)} access rather than read and write. A fresh purchase is unavailable before payment because this connection cannot create its WooCommerce order. Connect again and approve read and write access.</p>`
      }
    </div>
  </div>
${view.through === "api" ? theSwitch(base, view) : ""}${
  view.stopped === true
    ? `  <p class="quiet">Selling is stopped, so nothing imported sells until you start it again on <a href="${escaped(base)}/cards">Cards</a>.</p>
`
    : ""
}  <form class="issue" method="post" action="${escaped(base)}/woocommerce/import">
    <div>
      <label>Import the catalog</label>
      <p class="quiet">Reads up to ${PRODUCTS_AT_MOST} products and publishes only the product configuration currently supported by this connector, described above. Other products stay in your shop. If the shop has more than ${PRODUCTS_AT_MOST} products, the whole import is refused. Running it again updates the same cards.</p>
      <p class="quiet">If a product is later deleted from the shop, runs out, or stops being supported, its card stays listed, but the price check refuses the purchase before payment. Pause cards you no longer want agents to see.</p>
      <p class="quiet">Every parcel is published with seven days to ship. That number is Agentify's, not yours: WooCommerce has no field for it. A parcel's order that has not shipped seven days after payment reads as a refund owed. A parcel's card is published only once your shop's site is set in <a href="${escaped(base)}/settings">Settings</a>, because the site is where a buyer asks about a parcel that did not arrive.</p>
      <p class="quiet">Marking a parcel's order Completed in WooCommerce, in the shop it was sold from and within thirty days of it being placed, tells the buyer it has shipped, and that cannot be taken back. If the order has a fulfilled WooCommerce fulfilment, the buyer gets its carrier and tracking; otherwise the buyer is told your shipping method's name as the carrier, with no tracking number. An order not marked Completed within its seven days reads as a refund owed on your Orders screen, and marking it Completed later, within the thirty days, still clears that debt unless a refund has already been recorded. An order you cancel or refund in WooCommerce has not shipped, and becomes a refund owed when its seven days run out. If a parcel's order reads as a refund owed before its seven days are up while your shop holds a paid order for it, do not ship that order: Agentify could not confirm it, and you owe the buyer a refund instead.</p>
      ${beforeImporting(base, view)}
    </div>
    <button class="button button-primary" type="submit">Import the catalog</button>
  </form>
  <form class="issue" method="post" action="${escaped(base)}/woocommerce/disconnect">
    <div>
      <label>Disconnect</label>
      <p class="quiet">Deletes the keys your shop gave us and switches you back to selling through your own code: the shop's cards go off sale, and the cards your code published come back, with selling stopped until you start it again on Cards. Orders still waiting on the shop have to finish first, a parcel until it is marked Completed in WooCommerce. A parcel already owed a refund is no longer followed once the shop is disconnected, so marking it Completed after that does not clear the debt. To revoke the keys in the shop too, open WooCommerce → Settings → Advanced → REST API.</p>
      ${view.leaving === undefined ? "" : `<p class="problem">${escaped(view.leaving)}</p>`}
    </div>
    <button class="button button-secondary" type="submit">Forget this shop</button>
  </form>
`;

/**
 * The gateway refuses every card of a merchant who has not set these, in a
 * sentence naming an API route, which means nothing to a merchant with no code.
 * So the line names the setting as Settings does and links there, before the
 * press as well as after. After a refused press it says nothing was imported
 * and names what was unset at that moment. Only that answer is an alert; a
 * standing notice announced on every visit would drown it. The connector is not
 * offered on live, so the operator's approval never stands in the way here.
 */
const beforeImporting = (base: string, view: WooView): string => {
  const refused = view.refused ?? [];
  const unset = refused.length > 0 ? refused : (view.unset ?? []);
  if (unset.length === 0) {
    return "";
  }
  const what = unset.map((one) => UNSET_WORDS[one]).join(" and ");
  const settings = `<a href="${escaped(base)}/settings">Settings</a>`;
  return refused.length > 0
    ? `<p class="problem" role="alert">Nothing was imported. Set ${what} in ${settings}, then import again.</p>`
    : `<p class="problem">Import publishes nothing until you set ${what} in ${settings}.</p>`;
};

interface Sent {
  /** The shop's own identifier. */
  readonly id: string;
  readonly title: string;
}

/** Our catalogue identifier for the card. */
interface Published extends Sent {
  readonly published: string;
}

/** Word for word, one finding per field. */
interface Refused extends Sent {
  readonly problems: readonly string[];
}

/** What came back instead of an answer. */
interface Unanswered extends Sent {
  readonly failed: string;
}

interface NotAttempted extends Sent {
  readonly notAttempted: true;
}

/**
 * A product the publish step never answered about is a shape of its own, so no
 * screen can fold it into the refusals a merchant can repair in their shop.
 */
export type ImportOutcome = Published | Refused | Unanswered | NotAttempted;

export interface ImportView {
  readonly shopUrl: string;
  readonly outcomes: readonly ImportOutcome[];
  readonly skipped: readonly SkippedProduct[];
}

/**
 * Answered with a page rather than a redirect, because it has to carry a list:
 * each refusal is the publish step's own sentence about one field of one card,
 * the only thing that tells a merchant what to change in their shop.
 */
export const wooImportScreen = (viewer: Viewer, view: ImportView): string => {
  const went = view.outcomes.filter((one): one is Published => "published" in one);
  const refused = view.outcomes.filter((one): one is Refused => "problems" in one);
  const unanswered = view.outcomes.filter((one): one is Unanswered => "failed" in one);
  const notAttempted = view.outcomes.filter((one): one is NotAttempted => "notAttempted" in one);

  const body = `
  <div class="lede">
    <div>
      <h1>What came over from ${escaped(view.shopUrl)}</h1>
      <p>${escaped(summaryOf(went.length, refused.length, unanswered.length, notAttempted.length, view.skipped.length))}</p>
      <p class="quiet"><a href="${escaped(viewer.base)}/cards">Your cards</a> · <a href="${escaped(viewer.base)}/woocommerce">Back to the shop</a></p>
    </div>
  </div>
${went.length === 0 ? "" : publishedBlock(went)}${refused.length === 0 ? "" : refusedBlock(refused)}${
  unanswered.length === 0 ? "" : unansweredBlock(unanswered)
}${notAttempted.length === 0 ? "" : notAttemptedBlock(notAttempted)}${
  view.skipped.length === 0 ? "" : skippedBlock(view.skipped)
}`;

  return page({
    mode: viewer.mode,
    base: viewer.base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: "integrations",
    title: "WooCommerce import",
    body,
  });
};

/** Published is always said; each other outcome is said whenever it is not zero. */
const summaryOf = (
  published: number,
  refused: number,
  unanswered: number,
  notAttempted: number,
  skipped: number,
): string => {
  const parts = [
    `${published} ${published === 1 ? "product" : "products"} published`,
    ...(refused === 0 ? [] : [`${refused} refused by our publishing rules`]),
    ...(unanswered === 0 ? [] : [`${unanswered} got no verdict`]),
    ...(notAttempted === 0 ? [] : [`${notAttempted} not attempted`]),
    ...(skipped === 0 ? [] : [`${skipped} could not be turned into a card at all`]),
  ];
  return `${parts.join(", ")}.`;
};

/**
 * Named for what publishing did and no more: its answer says nothing about
 * selling, and a card the merchant paused stays paused, so "on sale" would be a
 * guess. The cards screen draws the selling state, and the heading says so.
 */
const publishedBlock = (outcomes: readonly Published[]): string => `  <div class="lede">
    <div>
      <h2>Published</h2>
      <p class="quiet">Each is one of your cards. Whether it can be bought is on your cards screen. A card you paused stays paused through an import, and while all selling is stopped no card takes an order.</p>
      <ul>${outcomes
        .map(
          (one) =>
            `<li>${escaped(one.title)} <span class="quiet">— product ${escaped(one.id)} in your shop, card ${escaped(one.published)}</span></li>`,
        )
        .join("")}</ul>
    </div>
  </div>
`;

/**
 * Word for word: the merchant's next move is to change the named thing in their
 * shop, and a paraphrase would be a second description of a rule that has one.
 */
const refusedBlock = (outcomes: readonly Refused[]): string => `  <div class="lede">
    <div>
      <h2>Refused</h2>
      <p class="quiet">These are our own publishing rules, and the sentences under each product are the ones the publish door gave. Change what they name in your shop and import again.</p>
      <p class="quiet">The count is of your description with markup removed, so your shop's editor shows a larger number.</p>
      <ul>${outcomes
        .map(
          (
            one,
          ) => `<li>${escaped(one.title)} <span class="quiet">— product ${escaped(one.id)}</span>
        <ul>${one.problems.map((problem) => `<li>${escaped(problem)}</li>`).join("")}</ul></li>`,
        )
        .join("")}</ul>
    </div>
  </div>
`;

/**
 * Nobody read these products (the gateway was unreachable or answered with
 * something else, a refused key among them), so no edit in the shop helps and
 * they are listed apart from the refusals. "The gateway" means the WooCommerce
 * payment plugin to a WooCommerce merchant, so the paragraph defines the word
 * before the lines use it.
 */
const unansweredBlock = (outcomes: readonly Unanswered[]): string => `  <div class="lede">
    <div>
      <h2>No verdict</h2>
      <p class="quiet">Nothing here is a finding about the product, and nothing in your shop needs changing: the part of Agentify that keeps your cards — the lines below call it the gateway — did not answer when this product was sent to it, or answered with something other than its verdict. Import again later; importing again does not double cards.</p>
      <ul>${outcomes
        .map(
          (
            one,
          ) => `<li>${escaped(one.title)} <span class="quiet">— product ${escaped(one.id)}</span>
        <ul><li>${escaped(one.failed)}</li></ul></li>`,
        )
        .join("")}</ul>
    </div>
  </div>
`;

const notAttemptedBlock = (outcomes: readonly NotAttempted[]): string => `  <div class="lede">
    <div>
      <h2>Not attempted</h2>
      <p class="quiet">Import stopped after the first product got no verdict, so these products were not sent to Agentify. Import again later.</p>
      <ul>${outcomes
        .map(
          (one) =>
            `<li>${escaped(one.title)} <span class="quiet">— product ${escaped(one.id)}</span></li>`,
        )
        .join("")}</ul>
    </div>
  </div>
`;

/**
 * Not folded into the refused list: those are products the gateway would not
 * take, these are products that could not be read as a card at all, and the
 * merchant's move differs.
 */
const skippedBlock = (skipped: readonly SkippedProduct[]): string => `  <div class="lede">
    <div>
      <h2>Left in the shop</h2>
      <p class="quiet">Nothing was published for these, and nothing about them was changed in your shop.</p>
      <ul>${skipped
        .map(
          (one) =>
            `<li>${escaped(one.title)} <span class="quiet">— product ${escaped(one.id)}</span><br>${escaped(one.why)}</li>`,
        )
        .join("")}</ul>
    </div>
  </div>
`;

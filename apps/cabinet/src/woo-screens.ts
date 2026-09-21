/**
 * The screens a merchant connects a WooCommerce shop on.
 *
 * Four of them: before the shop knows anything about us, the moment the
 * merchant's browser comes back through the return address, the import, and
 * the block on the settings screen that says which of those the account is
 * in. None of them fetches anything or decides anything, which is what lets a
 * test read the page a merchant would be looking at.
 *
 * The one thing these pages are careful about is what they claim. A merchant
 * comes back from their own shop having pressed Approve, and the shop's
 * redirect says `success=1` — but that is the shop telling the browser what it
 * did, and the keys travel separately, on a request from the shop's own server
 * to ours. The redirect is a claim and the row is the evidence: anybody can
 * type `success=1` into an address bar, and a post that never got through
 * leaves the same nothing here as a post never made. So the return page says
 * what is actually here rather than what the redirect claims, and where nothing
 * is here it says that, rather than "it failed" — which it does not know.
 */

import type { SurfaceMode } from "@agentify/commerce-core";
import { bare, brandLockup, escaped, page } from "./html.js";
import type { Viewer } from "./screens.js";
import type { SkippedProduct } from "./woo-catalog.js";
import { GRANT_MINUTES } from "./woo-connect.js";
import { PRODUCTS_AT_MOST } from "./woo-shop.js";
import { moment } from "./words.js";

/**
 * A connected shop as a screen may know it.
 *
 * Three fields, and a shape of its own rather than the stored row for one
 * reason: the row also holds the shop's key and its secret, and the rule that
 * those never reach a page is worth holding in a type rather than in whoever
 * writes the next screen remembering it (ADR-0023).
 */
export interface ConnectedShop {
  readonly shopUrl: string;
  readonly permissions: string;
  readonly connectedAt: Date;
}

/**
 * Where this account's WooCommerce channel has got to, in the four states a
 * merchant can be in and can be told apart.
 *
 * Four of them, not two, and the two in the middle are what this shape exists
 * for. A merchant presses Connect, approves in their own shop, and their shop
 * then posts the keys to us from its own server — a request that can simply
 * not arrive, and when it does not, our rows look no different from a merchant
 * who never pressed the button. "Not connected" would cover both "you have not
 * tried" and "you tried and nothing came", and those have different next
 * moves: one is press the button, the other is wait, and then press it again.
 *
 * What the rows do not say is why nothing came. A merchant who declined in
 * their shop, one who closed its screen, and one whose shop tried to post and
 * failed all leave the same nothing here, so the third state names none of
 * them: the one thing it knows is that no keys arrived in the time we hold a
 * Connect open.
 *
 * The clock is read before this is built, not after, so that both screens draw
 * one answer rather than each doing its own arithmetic on a row.
 */
export type ShopState =
  /** The keys arrived. This is the only state in which anything can be sold. */
  | { readonly kind: "connected"; readonly shop: ConnectedShop }
  /** Approved or not, the fifteen minutes are still running. Wait, or reload. */
  | {
      readonly kind: "waiting";
      readonly shopUrl: string;
      readonly startedMinutesAgo: number;
    }
  /** The fifteen minutes ran out with no keys written down here. Why is not known here. */
  | { readonly kind: "unanswered"; readonly shopUrl: string }
  /** Nothing was ever started. */
  | { readonly kind: "none" };

/**
 * What the settings block is drawn from: where the channel is, or that where
 * it is could not be read just now.
 *
 * The fifth case is a state of what we know, not of the channel, and it stays
 * out of `ShopState` because the shop screen is never drawn without a read. A
 * read that fails there is the page failing, and a type that let the shop
 * screen be handed "unread" would be a state it has no honest sentence for.
 * The settings screen is different: three of its four subjects are the
 * merchant's name, their money and their account, and our own shops table
 * being down must not stand between a merchant and the box for their payout
 * address. So the block is drawn with the fifth case, saying so, rather than
 * dropped — a block that simply vanishes reads as "no shop is connected" to a
 * merchant who connected one yesterday, and "I don't know" has to be
 * distinguishable from "there is none".
 */
export type ShopTile = ShopState | { readonly kind: "unread" };

/** What the page is drawn from: where the channel is, and anything just refused. */
export interface WooView {
  /** Where this account's channel has got to, read off our own rows. */
  readonly state: ShopState;
  /** What was wrong with what the merchant just typed, where anything was. */
  readonly problem?: string;
  /** What they typed, so a refusal leaves the box as they left it. */
  readonly typed?: string;
  /**
   * Whether the browser reached this page through the return address.
   *
   * That is the whole of what it means. The return route sets it for any
   * browser with a session, whatever query it carried or none, so a merchant
   * who typed the address in sets it as surely as a shop that sent them — and
   * a real return sets it only where the cookie travels (ADR-0009). It changes
   * what the page says and nothing about what it claims: the state above is
   * read off our own rows either way.
   */
  readonly cameBack?: boolean;
}

/** How long ago a Connect was pressed, as a merchant would say it. */
const minutesAgo = (minutes: number): string =>
  minutes < 1 ? "less than a minute ago" : `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;

/**
 * The two sentences a Connect that produced no keys is worth.
 *
 * They are two and not one because the merchant's move differs. Inside the
 * fifteen minutes the answer is to wait. Past them the request is not coming
 * on this Connect — a post arriving now would meet an expired token and be
 * refused — and the answer is to press Connect again.
 *
 * Neither sentence names a cause, because none is known here. Past the
 * fifteen minutes there are three ways it can have gone: the merchant
 * declined, and their shop sent the browser back with nothing posted; they
 * closed the shop's screen; or they approved and the shop's post to us
 * failed. The rows hold the same nothing in all three, and "your shop could
 * not reach us", which the second sentence once said, was the third guess
 * presented as the fact — it sent a merchant who had declined off to repair a
 * firewall that was fine. So the sentence says that why is not known here,
 * which is the whole of what a row can support, and stops.
 *
 * Both were a sentence and a paragraph under it. The paragraph walked through
 * the three ways and what WooCommerce does about each; what a merchant acts on
 * is one of them — reload, or press Connect again — and that is what is left.
 */
const noKeysYet = (state: ShopState): string | null => {
  if (state.kind === "waiting") {
    return `No keys from ${escaped(state.shopUrl)} yet; you started ${escaped(minutesAgo(state.startedMinutesAgo))}. Reload in a moment.`;
  }
  if (state.kind === "unanswered") {
    return `No keys from ${escaped(state.shopUrl)} in the ${GRANT_MINUTES} minutes we wait. Why is unknown; connect again.`;
  }
  return null;
};

/**
 * What this connector is and what it will take, at the top of its own screen.
 *
 * One sentence, and it is the only place on the origin that the rule is
 * written: a merchant deciding whether to connect needs it before they press
 * Connect, and the settings block links here rather than repeating it. There
 * is no WooCommerce page in the portal and this pass does not make one: the
 * connector is experimental and is not the acceptance gate for anything.
 */
const WHAT_THIS_IS = `<p>An experimental connector, in TEST, for a published USD virtual download with one protected file, unlimited access, no managed stock and shop tax calculation off.</p>`;

/**
 * The one thing about Connect a merchant cannot see coming.
 *
 * Their browser is about to leave for their own shop, and the page it lands on
 * asks them to approve. Somebody who has been phished once needs to be told,
 * here rather than there, that the password box on that screen is their own
 * shop's and never ours. Drawn only where a Connect is what happens next.
 */
const WHOSE_SCREEN_ASKS = `<p class="quiet">Your shop asks for approval on its own screen; Agentify never asks for your password.</p>`;

/** The page a merchant connects from, and comes back to. */
export const wooScreen = (viewer: Viewer, view: WooView): string => {
  const { base } = viewer;
  const body = `
  <div class="integration-shell">
  <div class="lede">
    <div>
      <h1>WooCommerce</h1>
      ${WHAT_THIS_IS}${view.state.kind === "connected" ? "" : WHOSE_SCREEN_ASKS}
    </div>
  </div>
${view.cameBack === true && view.state.kind === "connected" ? KEYS_ARRIVED : ""}${
  view.state.kind === "connected"
    ? theConnection(base, view.state.shop, view)
    : `${waitingBlock(view.state)}${theForm(base, view)}`
}
  </div>`;

  return page({
    mode: viewer.mode,
    base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: "settings",
    title: "WooCommerce",
    ...(viewer.sellerName === undefined ? {} : { unnamed: viewer.sellerName === null }),
    body,
  });
};

/**
 * What the page adds when the browser came through the return address and the
 * keys are here: the sentence a merchant went out to their shop for.
 *
 * It is drawn off the row, never off the redirect. WooCommerce puts
 * `success=1` or `success=0` on its redirect and the return route reads
 * neither, so nothing here knows what the shop said, and a merchant signed in
 * on this browser reaches this page by typing the address in as surely as by
 * being sent. In every other state the arrival adds nothing. "Your shop says
 * it approved", which the page once said there, was the redirect's claim
 * presented as read — drawn over a redirect saying `success=0` and over no
 * redirect at all — and its honest replacement, "your browser arrived through
 * the return address", was a sentence the page had to disclaim in the next
 * one, and said nothing the block below does not. That block is drawn off our
 * rows and is the same sentence on a reload and on the settings screen, so
 * what a merchant reads on coming back is what they read tomorrow.
 */
const KEYS_ARRIVED = `  <div class="callout done">
    <div class="what">Your shop is connected. The keys arrived from your shop's own server, which is what settles it.</div>
  </div>
`;

/**
 * The Connect that produced no keys, drawn above the form that starts another.
 *
 * A notice and not a section, because that is what this cabinet draws for a
 * state the merchant has to act on — the same box an order owing a refund gets
 * on the orders screen (`agentify.css`, `.callout`). It was a heading and a
 * paragraph under it, which is the shape of an explanation rather than of
 * something to do.
 */
const waitingBlock = (state: ShopState): string => {
  const said = noKeysYet(state);
  return said === null
    ? ""
    : `  <div class="callout">
    <div class="what">${said}</div>
  </div>
`;
};

/**
 * What the return address answers a browser that arrives carrying no session.
 *
 * Which, on a real return, is every browser. The cabinet's cookie is
 * `SameSite=Strict` (ADR-0009) and the navigation back is started by the
 * merchant's own shop, so the request that lands here has nothing on it even
 * for somebody signed in on that very browser. Behind the sign-in gate that
 * ends a working flow on a sign-in form, and a merchant reads the form as the
 * connect having failed — which is what happened, twice, when this flow was
 * walked by hand.
 *
 * So the page is drawn for anybody, and every word of it is chosen so that
 * anybody may read it. It says what this address is for, which is true of the
 * address rather than of the visitor; it does not say that a connection
 * happened, because for whoever typed the address in by hand none did, and
 * because what the shop's `success=1` claims is not something we have seen. It
 * names no account, no shop and no key, and the same page is served whether
 * this cabinet holds a connection or holds nothing — a stranger who walks up to
 * this address learns that the address exists, and that is all there is here to
 * learn.
 *
 * The next click is same-site, so a browser that was already signed in sends
 * its Strict cookie again. A browser without one meets the cabinet's ordinary
 * sign-in gate. The page does not ask for another email or interpret the
 * untrusted redirect query.
 */
export const wooReturnScreen = (base: string, mode: SurfaceMode): string =>
  bare(
    base,
    "Back from your shop",
    `<div class="gate">
  ${brandLockup("/")}
  <form class="gate-card" method="get" action="${escaped(base)}/woocommerce">
    <h1>Back from your shop</h1>
    <p>Continue to your cabinet to see whether access reached Agentify.</p>
    <input type="hidden" name="from" value="shop">
    <button class="button button-primary" type="submit">Continue to your cabinet</button>
  </form>
</div>`,
    mode,
  );

/** The box the shop's address is typed into, and the one line under it. */
const theForm = (base: string, view: WooView): string => `  <div class="lede">
    <div>
      <h2>Connect your shop</h2>
    </div>
  </div>
  <form class="issue" method="post" action="${escaped(base)}/woocommerce/connect">
    <div>
      <label for="shop_url">The address of your shop</label>
      <input id="shop_url" name="shop_url" type="url" inputmode="url" placeholder="https://shop.example.com" value="${escaped(view.typed ?? (view.state.kind === "waiting" || view.state.kind === "unanswered" ? view.state.shopUrl : ""))}" required>
      <p class="quiet">The public https address at the root of your shop. Permalinks must not be Plain.</p>
      ${view.problem === undefined ? "" : `<p class="problem">${escaped(view.problem)}</p>`}
    </div>
    <button class="button button-compact button-primary" type="submit">Connect</button>
  </form>
`;

/**
 * What a connected shop looks like, and the two things to do with it.
 *
 * The refusal is drawn here as well as in the form next door, and the two are
 * not one line in one place because they are about different things. On the
 * form it is about what somebody just typed; here it is about what the shop
 * answered when we went to read it, and there is no box on this page for it to
 * sit under.
 */
const theConnection = (
  base: string,
  connection: ConnectedShop,
  view: WooView,
): string => `  <div class="lede">
    <div>
      <h2>Your shop</h2>
      <p>${escaped(connection.shopUrl)}, connected ${escaped(moment(connection.connectedAt.toISOString()))}.</p>
      ${view.problem === undefined ? "" : `<p class="problem">${escaped(view.problem)}</p>`}
      ${
        connection.permissions === "read_write"
          ? ""
          : `<p class="problem">Your shop granted ${escaped(connection.permissions)} access rather than read and write. A fresh purchase is unavailable before payment because this connection cannot create its WooCommerce order. Connect again and approve read and write access.</p>`
      }
    </div>
  </div>
  <form class="issue" method="post" action="${escaped(base)}/woocommerce/import">
    <div>
      <label>Import the catalogue</label>
      <p class="quiet">Up to ${PRODUCTS_AT_MOST} products; more and the whole import is refused.</p>
    </div>
    <button class="button button-compact button-primary" type="submit">Import the catalogue</button>
  </form>
  <form class="issue" method="post" action="${escaped(base)}/woocommerce/disconnect">
    <div>
      <label>Disconnect</label>
      <p class="quiet">Forgets your shop's keys. Orders already paid stay yours.</p>
    </div>
    <button class="button button-compact button-secondary" type="submit">Forget this shop</button>
  </form>
  <p class="note">A card outlives the shop product it came from and the connection itself; a price check refuses it before payment.</p>
`;

/** A product an import sent through the publish door, named as the shop names it. */
interface Sent {
  /** The shop's own identifier for the product. */
  readonly id: string;
  /** The product's name in the shop. */
  readonly title: string;
}

/** The door took it: our catalogue identifier for the card. */
interface Published extends Sent {
  readonly published: string;
}

/** The door refused it: what it said, word for word, one finding per field. */
interface Refused extends Sent {
  readonly problems: readonly string[];
}

/** The door never answered about it: what came back instead of an answer. */
interface Unanswered extends Sent {
  readonly failed: string;
}

/** Import stopped before this product was sent through the publish door. */
interface NotAttempted extends Sent {
  readonly notAttempted: true;
}

/**
 * What came of one product sent through the publish door: one of three, and
 * never none of them. The third is the one a merchant cannot repair in their
 * shop, and it is a shape of its own so that no screen can fold it into the
 * one they can.
 */
export type ImportOutcome = Published | Refused | Unanswered | NotAttempted;

export interface ImportView {
  readonly shopUrl: string;
  readonly outcomes: readonly ImportOutcome[];
  readonly skipped: readonly SkippedProduct[];
}

/**
 * What an import came to, answered as a page rather than as a redirect.
 *
 * The one screen in this cabinet besides the new-key page that answers a form
 * post with a page, and for the same kind of reason: a redirect can carry a
 * flag and this has to carry a list. Every refusal here is the publish door's
 * own sentence about one field of one card, which is the only thing that tells
 * a merchant what to go and change in their shop — folded into "some cards were
 * refused" it would be a page saying something went wrong and nothing else.
 * And a product the door never answered about is listed apart from those,
 * because its next move is not in the shop at all.
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
    tab: "settings",
    title: "WooCommerce import",
    body,
  });
};

/** One line of counts, written so that none of the four is hidden. */
const summaryOf = (
  published: number,
  refused: number,
  unanswered: number,
  notAttempted: number,
  skipped: number,
): string => {
  const parts = [
    `${published} ${published === 1 ? "product" : "products"} published`,
    ...(refused === 0 ? [] : [`${refused} refused`]),
    ...(unanswered === 0 ? [] : [`${unanswered} got no verdict`]),
    ...(notAttempted === 0 ? [] : [`${notAttempted} not attempted`]),
    ...(skipped === 0 ? [] : [`${skipped} could not be read as a card`]),
  ];
  return `${parts.join(", ")}.`;
};

/**
 * The cards the door took, named for what the door did and not for what it
 * did not. The answer to a publish carries the catalogue identifier and
 * nothing about selling, and a card the merchant paused stays paused through a
 * publish — so "on sale" here would be this page's guess, made over the one
 * card a merchant went out of their way to hold back. Where the selling state
 * is drawn is the cards screen, and the line under the heading says so.
 */
const publishedBlock = (outcomes: readonly Published[]): string => `  <div class="lede">
    <div>
      <h2>Published</h2>
      <p class="quiet">Whether each can be bought is on your cards screen.</p>
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
 * The cards the door refused, with its own words under each one.
 *
 * Word for word, and not summarised. What the merchant does next is go into
 * their shop and change the thing named — a description over five hundred
 * characters, a title the catalogue will not carry — and a paraphrase of ours
 * would be a second description of a rule that already has one.
 */
const refusedBlock = (outcomes: readonly Refused[]): string => `  <div class="lede">
    <div>
      <h2>Refused</h2>
      <p class="quiet">Our own publishing rules. Change what these lines name in your shop and import again.</p>
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
 * The products the door never answered about, apart from the ones it refused.
 *
 * A refusal is a sentence about a field of the product, and the merchant's
 * next move is in their shop. These are not that: the product may be perfect
 * for all anybody knows, because nobody read it — the gateway was not there,
 * or answered with something that is not its answer to a publish, a refusal
 * of the key among them — and no move in the shop helps. Folded into the list
 * above, this page sent a merchant to edit a product nobody had read. The
 * line printed under each product says "the gateway", which to a WooCommerce
 * merchant is the payment plugin on their own Payments tab, so the paragraph
 * binds the word before the line is read.
 */
const unansweredBlock = (outcomes: readonly Unanswered[]): string => `  <div class="lede">
    <div>
      <h2>No verdict</h2>
      <p class="quiet">Not a finding about the product: the part of Agentify that keeps your cards — the gateway — did not answer. Import again later; importing again does not double cards.</p>
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
      <p class="quiet">Import stopped at the first product with no verdict.</p>
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
 * The products that never became a card at all.
 *
 * A different list from the one above and deliberately not folded into it. A
 * refused card is a product we could describe and our own door would not take;
 * these are products this cabinet could not read as a card in the first place,
 * and the merchant's move is different in each case.
 */
const skippedBlock = (skipped: readonly SkippedProduct[]): string => `  <div class="lede">
    <div>
      <h2>Left in the shop</h2>
      <p class="quiet">Nothing was published, and nothing in your shop changed.</p>
      <ul>${skipped
        .map(
          (one) =>
            `<li>${escaped(one.title)} <span class="quiet">— product ${escaped(one.id)}</span><br>${escaped(one.why)}</li>`,
        )
        .join("")}</ul>
    </div>
  </div>
`;

/**
 * The block on the settings screen that says where the channel has got to.
 *
 * It draws the state rather than a standing invitation, and that is the whole
 * of why it reads rows. A merchant comes back from approving in their own shop,
 * opens Settings, and finds out there whether it took; a block that says
 * "connect a WooCommerce shop" over a shop that is already connected is not
 * merely out of date, it is this page telling them the Connect failed and
 * sending them round the loop again.
 *
 * The same four states as the shop screen and the same sentences for the two
 * that are neither connected nor nothing, because this is the screen a merchant
 * looks at after being sent here from the return page, and being told two
 * different things by two pages about one row is worse than being told nothing.
 * What a merchant does about any of it — the import, the disconnect, the form
 * that starts another Connect — is on the shop screen, and this block is the
 * way in from all four. So the block is a heading, one line and that link:
 * what a supported product is, and what Connect and Import each do, is on the
 * screen the link leads to. The fifth case, `unread`, is this screen's alone:
 * the rows could not be read just now, and the block says so rather than going
 * away, because a block that vanishes reads as "no shop is connected".
 *
 * A shop that granted less than read and write is said here too, for the same
 * reason the third state exists: that channel cannot deliver a single order,
 * and a line reading only "connected" over it is this page being reassuring
 * about something that is broken.
 */
export const wooSettingsBlock = (base: string, state: ShopTile): string => {
  // The unread state is the one with no link to the shop screen. That page
  // needs the same read and would answer with an error page, so a link would
  // be the settings screen offering something that cannot be drawn.
  const said =
    state.kind === "unread"
      ? `<p>Whether a shop is connected could not be read just now. Nothing was disconnected. Reload this page in a moment.</p>`
      : state.kind === "connected"
        ? `<p>${escaped(state.shop.shopUrl)}, connected ${escaped(moment(state.shop.connectedAt.toISOString()))}.</p>
      ${
        state.shop.permissions === "read_write"
          ? ""
          : `<p class="problem">Your shop granted ${escaped(state.shop.permissions)} access rather than read and write, so a fresh purchase is unavailable before payment. Connect again and approve read and write access.</p>`
      }
      <p><a href="${escaped(base)}/woocommerce">Your shop</a></p>`
        : state.kind === "none"
          ? `<p>An experimental connector for one narrow kind of WooCommerce product.</p>
      <p><a href="${escaped(base)}/woocommerce">Connect a WooCommerce shop</a></p>`
          : `<p>${noKeysYet(state) ?? ""}</p>
      <p><a href="${escaped(base)}/woocommerce">${state.kind === "waiting" ? "Check the connection" : "Connect again"}</a></p>`;

  return `  <div class="lede">
    <div>
      <h2>WooCommerce</h2>
      ${said}
    </div>
  </div>
`;
};

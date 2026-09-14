/**
 * The screens a merchant connects a WooCommerce shop on.
 *
 * Four of them: before the shop knows anything about us, the moment the
 * merchant's browser comes back from approving, the import, and the block on
 * the settings screen that says which of those the account is in. None of them
 * fetches anything or decides anything, which is what lets a test read the page
 * a merchant would be looking at.
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

import type { SurfaceMode } from "@coinslot/core";
import { bare, escaped, page } from "./html.js";
import type { Viewer } from "./screens.js";
import type { SkippedProduct } from "./woo-catalog.js";
import { GRANT_MINUTES } from "./woo-connect.js";
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
   * Whether this is the page their browser came back to from their own shop.
   *
   * It changes what the page says and nothing about what it claims: the state
   * above is read off our own rows either way.
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
 * firewall that was fine. What the sentence may say is the one thing that is
 * WooCommerce's own behaviour rather than a guess about the merchant's
 * network: a shop whose post fails, or whose post our own door refuses, shows
 * the merchant an error on its own screen and deletes the key it minted
 * (`class-wc-auth.php`, `post_consumer_data` and `maybe_delete_key`). So a
 * merchant who saw an error there was stopped at the post, and one who was
 * sent back here, or who closed the page, never sent anything. What the
 * error says is not promised: on a post our door refused, WooCommerce's
 * message names nothing.
 */
const noKeysYet = (state: ShopState): string => {
  if (state.kind === "waiting") {
    return `<p>You started connecting ${escaped(state.shopUrl)} ${escaped(minutesAgo(state.startedMinutesAgo))}, and no keys have reached us yet.</p>
      <p class="quiet">The keys do not travel with your browser: your shop sends them to us in a request of its own, and it may not have arrived yet. Reload this page in a moment.</p>`;
  }
  if (state.kind === "unanswered") {
    return `<p>You started connecting ${escaped(state.shopUrl)}, and no keys arrived from it in the ${GRANT_MINUTES} minutes we wait for them.</p>
      <p class="quiet">Your shop sends the keys in a request of its own, and nothing from that request was written down here, so whether the connection was approved, declined or never answered cannot be seen from this page. If you still want to connect it, press Connect again and your shop will ask you to approve afresh. If your shop showed you an error page of its own instead of sending you back here, the keys were stopped between your shop and us, and your shop took them back.</p>`;
  }
  return "";
};

const WHAT_CONNECTING_DOES = `<p>Connecting reads your shop's catalogue and publishes what it finds as cards, so agents can buy your products. When one is bought, the order is created in your shop, marked paid, and appears in WooCommerce → Orders like any other.</p>
  <p class="quiet">Your shop asks you to approve this in its own screen, and it is your shop that hands us the keys — nothing here asks for a password of yours. The keys appear afterwards in WooCommerce → Settings → Advanced → REST API under the name Coinslot, where you can revoke them whenever you like.</p>`;

/** The page a merchant connects from, and comes back to. */
export const wooScreen = (viewer: Viewer, view: WooView): string => {
  const { base } = viewer;
  const body = `
  <div class="lede">
    <div>
      <h1>WooCommerce</h1>
      ${WHAT_CONNECTING_DOES}
    </div>
  </div>
${view.cameBack === true ? cameBackNote(view) : ""}${
  view.state.kind === "connected"
    ? theConnection(base, view.state.shop, view)
    : `${waitingBlock(view.state)}${theForm(base, view)}`
}`;

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
 * What a merchant is told on the page their shop sent them back to.
 *
 * It separates the two facts on purpose, because the merchant cannot see that
 * they are two: their shop said it approved, and the keys either arrived here
 * or did not. A page that read the redirect and announced success would be
 * announcing something it has not seen.
 *
 * Where they did not arrive it says only that the shop claims to have approved.
 * The diagnosis is in the block below rather than repeated here, because that
 * block is drawn on a reload and on the settings screen as well, and a merchant
 * who comes back to this page tomorrow needs the same sentence they got today.
 */
const cameBackNote = (view: WooView): string =>
  view.state.kind === "connected"
    ? `  <div class="callout done">
    <div class="what">Your shop is connected. The keys arrived from your shop's own server, which is what settles it.</div>
  </div>
`
    : `  <div class="callout">
    <div class="what">Your shop says it approved the connection.</div>
    <div class="why">What that settles is its half. The keys travel separately, on a request from your shop's own server to ours, and what follows is what has actually reached us.</div>
  </div>
`;

/** The Connect that produced no keys, drawn above the form that starts another. */
const waitingBlock = (state: ShopState): string => {
  const said = noKeysYet(state);
  return said === ""
    ? ""
    : `  <div class="lede">
    <div>
      <h2>The connection you started</h2>
      ${said}
    </div>
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
 * The one link on it is the sign-in, which is the door that answers everybody
 * the same way too. A link straight into the cabinet would be an invitation
 * into a place the reader may have no account in, and it would end where this
 * page started: on a form nobody was expecting.
 */
export const wooReturnScreen = (base: string, mode: SurfaceMode): string =>
  bare(
    base,
    "Back from your shop",
    `<div class="gate">
  <h1>Coinslot</h1>
  <p>This is the address a WooCommerce shop sends you to when it has finished with a connection.</p>
  <p>Nothing about it can be shown here. Arriving from another site does not carry your sign-in with it, which is deliberate and is why you are reading this page rather than your own settings.</p>
  <p>Sign in and your settings say where the connection got to: which shop is connected, or that one was started and its keys have not reached us.</p>
  <p class="quiet"><a href="${escaped(base)}/sign-in">Sign in</a></p>
</div>`,
    mode,
  );

/** The box the shop's address is typed into. */
const theForm = (base: string, view: WooView): string => `  <div class="lede">
    <div>
      <h2>Connect your shop</h2>
      <p>Type the address you open your own shop at. Your browser goes there next, so that WooCommerce can ask you to approve.</p>
      <p class="quiet">Two things have to be true of the shop before this works, and you are told which one is missing rather than being sent somewhere that looks broken. It has to be reachable over https, and its permalinks have to be set to anything other than Plain — the screen that grants access is served through a rewrite rule, and with Plain there is no rule to serve it.</p>
    </div>
  </div>
  <form class="issue" method="post" action="${escaped(base)}/woocommerce/connect">
    <div>
      <label for="shop_url">The address of your shop</label>
      <input id="shop_url" name="shop_url" type="url" inputmode="url" placeholder="https://shop.example.com" value="${escaped(view.typed ?? "")}" required>
    </div>
    <button class="primary" type="submit">Connect</button>
    ${view.problem === undefined ? "" : `<p class="problem">${escaped(view.problem)}</p>`}
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
          : `<p class="problem">Your shop granted ${escaped(connection.permissions)} access rather than read and write. Orders cannot be created in a shop we can only read, so every sale would be refused at the moment of delivery. Connect again and approve read and write access.</p>`
      }
    </div>
  </div>
  <form class="issue" method="post" action="${escaped(base)}/woocommerce/import">
    <div>
      <label>Import the catalogue</label>
      <p class="quiet">Reads every product your shop offers for sale and publishes each one as a card. Running it again republishes those cards rather than making a second set, so a price or a description you changed in your shop comes over: a card is keyed by the product's own identifier there.</p>
      <p class="quiet">What it does not do is take anything off sale. A product you delete in your shop, or one that goes out of stock, is simply not in what this reads — the card published for it earlier stays where it is, and taking it off sale is one press on your cards screen.</p>
    </div>
    <button class="primary" type="submit">Import the catalogue</button>
  </form>
  <form class="issue" method="post" action="${escaped(base)}/woocommerce/disconnect">
    <div>
      <label>Disconnect</label>
      <p class="quiet">Forgets the keys your shop gave us. The cards already published stay on sale and their orders will then fail, so pause your selling first if that is what you meant. The keys themselves are revoked in your own shop, under WooCommerce → Settings → Advanced → REST API.</p>
    </div>
    <button type="submit">Forget this shop</button>
  </form>
`;

/** One card the publish door accepted, or the findings that stopped it. */
export interface ImportOutcome {
  /** The shop's own identifier for the product. */
  readonly id: string;
  /** The product's name in the shop. */
  readonly title: string;
  /** Our catalogue identifier, where the card went through. */
  readonly published?: string;
  /** What the door said, word for word, where it did not. */
  readonly problems?: readonly string[];
  /** Where the gateway itself could not be reached or would not answer. */
  readonly failed?: string;
}

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
 */
export const wooImportScreen = (viewer: Viewer, view: ImportView): string => {
  const went = view.outcomes.filter((one) => one.published !== undefined);
  const stopped = view.outcomes.filter((one) => one.published === undefined);

  const body = `
  <div class="lede">
    <div>
      <h1>What came over from ${escaped(view.shopUrl)}</h1>
      <p>${escaped(summaryOf(went.length, stopped.length, view.skipped.length))}</p>
      <p class="quiet"><a href="${escaped(viewer.base)}/cards">Your cards</a> · <a href="${escaped(viewer.base)}/woocommerce">Back to the shop</a></p>
    </div>
  </div>
${went.length === 0 ? "" : publishedBlock(went)}${stopped.length === 0 ? "" : refusedBlock(stopped)}${
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

/** One line of counts, written so that none of the three is hidden. */
const summaryOf = (published: number, refused: number, skipped: number): string => {
  const parts = [
    `${published} ${published === 1 ? "product is" : "products are"} on sale`,
    ...(refused === 0 ? [] : [`${refused} could not be published`]),
    ...(skipped === 0 ? [] : [`${skipped} could not be turned into a card at all`]),
  ];
  return `${parts.join(", ")}.`;
};

const publishedBlock = (outcomes: readonly ImportOutcome[]): string => `  <div class="lede">
    <div>
      <h2>On sale</h2>
      <ul>${outcomes
        .map(
          (one) =>
            `<li>${escaped(one.title)} <span class="quiet">— product ${escaped(one.id)} in your shop, card ${escaped(one.published ?? "")}</span></li>`,
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
const refusedBlock = (outcomes: readonly ImportOutcome[]): string => `  <div class="lede">
    <div>
      <h2>Not published</h2>
      <p class="quiet">These are our own publishing rules, and the sentences under each product are the ones the publish door gave. Change what they name in your shop and import again.</p>
      <p class="quiet">Where one of them counts the characters in a description, the number is of your product's description with the formatting taken out and the runs of whitespace collapsed: the tags your shop stores around the words are not part of what a card carries, so they are not part of what is counted. Your shop's own editor will show you a larger number than this page does, and the difference is the markup.</p>
      <ul>${outcomes
        .map(
          (
            one,
          ) => `<li>${escaped(one.title)} <span class="quiet">— product ${escaped(one.id)}</span>
        <ul>${(one.problems ?? [one.failed ?? "It was not published and nothing said why."])
          .map((problem) => `<li>${escaped(problem)}</li>`)
          .join("")}</ul></li>`,
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
 * way in from all four. The fifth case, `unread`, is this screen's alone: the
 * rows could not be read just now, and the block says so rather than going
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
      ? `<p>Whether a shop is connected to this account could not be read just now.</p>
      <p class="quiet">The fault is on our side, not in your shop, and nothing was disconnected by it. Reload this page in a moment.</p>`
      : state.kind === "connected"
        ? `<p>${escaped(state.shop.shopUrl)}, connected ${escaped(moment(state.shop.connectedAt.toISOString()))}.</p>
      ${
        state.shop.permissions === "read_write"
          ? ""
          : `<p class="problem">Your shop granted ${escaped(state.shop.permissions)} access rather than read and write, so every sale would be refused at the moment of delivery. Connect again and approve read and write access.</p>`
      }
      <p><a href="${escaped(base)}/woocommerce">Your shop</a></p>`
        : state.kind === "none"
          ? `<p>If your products live in a WooCommerce shop, connect it and your catalogue is published here for agents to buy. Orders are created in your shop, marked paid.</p>
      <p><a href="${escaped(base)}/woocommerce">Connect a WooCommerce shop</a></p>`
          : `${noKeysYet(state)}
      <p><a href="${escaped(base)}/woocommerce">${state.kind === "waiting" ? "Check the connection" : "Connect again"}</a></p>`;

  return `  <div class="lede">
    <div>
      <h2>WooCommerce</h2>
      ${said}
    </div>
  </div>
`;
};

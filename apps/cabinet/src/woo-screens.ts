/**
 * The screens a merchant connects a WooCommerce shop on.
 *
 * Three of them, and they are three because the flow genuinely has three
 * moments: before the shop knows anything about us, the moment the merchant's
 * browser comes back from approving, and the import. None of them fetches
 * anything or decides anything, which is what lets a test read the page a
 * merchant would be looking at.
 *
 * The one thing these pages are careful about is what they claim. A merchant
 * comes back from their own shop having pressed Approve, and the shop's
 * redirect says `success=1` — but that is the shop telling the browser what it
 * did, and the keys travel separately, on a request from the shop's own server
 * to ours. Those two can come apart: a shop that cannot reach us posts nothing
 * and still sends the browser back with `success=1`. So the return page says
 * what is actually here rather than what the redirect claims, and where nothing
 * is here it says that, rather than "it failed" — which it does not know.
 */

import { escaped, page } from "./html.js";
import type { Viewer } from "./screens.js";
import type { SkippedProduct } from "./woo-catalog.js";
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

/** What the page is drawn from: the connection, and anything just refused. */
export interface WooView {
  /** The shop this account has connected, or null for none. */
  readonly connection: ConnectedShop | null;
  /** What was wrong with what the merchant just typed, where anything was. */
  readonly problem?: string;
  /** What they typed, so a refusal leaves the box as they left it. */
  readonly typed?: string;
  /**
   * Whether this is the page their browser came back to from their own shop.
   *
   * It changes what the page says and nothing about what it claims: the state
   * below is read off our own rows either way.
   */
  readonly cameBack?: boolean;
}

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
  view.connection === null ? theForm(base, view) : theConnection(base, view.connection, view)
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
 */
const cameBackNote = (view: WooView): string =>
  view.connection === null
    ? `  <div class="callout">
    <div class="what">Your shop says it approved the connection, and no keys have reached us yet.</div>
    <div class="why">The keys do not travel with your browser: your shop sends them to us in a request of its own, and that request has either not arrived or did not get through. Reload this page in a moment. If it stays like this, your shop could not reach us — that request has to leave your server and arrive over https, and a shop behind a firewall that blocks outgoing requests never sends it.</div>
  </div>
`
    : `  <div class="callout done">
    <div class="what">Your shop is connected. The keys arrived from your shop's own server, which is what settles it.</div>
  </div>
`;

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
 * The block on the settings screen that says this exists.
 *
 * A link rather than the state, because the state is a row and a read, and the
 * settings screen is drawn from two calls to the gateway that have nothing to
 * do with a shop. What it has to do is be findable: a merchant who has a
 * WooCommerce shop has no other reason to guess at an address.
 */
export const wooSettingsBlock = (base: string): string => `  <div class="lede">
    <div>
      <h2>WooCommerce</h2>
      <p>If your products live in a WooCommerce shop, connect it and your catalogue is published here for agents to buy. Orders are created in your shop, marked paid.</p>
      <p><a href="${escaped(base)}/woocommerce">Connect a WooCommerce shop</a></p>
    </div>
  </div>
`;

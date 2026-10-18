/**
 * What the WooCommerce connector's screens show, as plain values built from
 * our own rows and the gateway's answers; the React pages under `app/` only
 * draw them.
 *
 * The shop's `success=1` redirect is the shop telling the browser what it did;
 * the keys travel separately, posted from the shop's server to ours, and
 * anybody can type `success=1` into an address bar. So these screens say what
 * our rows hold, never what the redirect claims, and where nothing arrived they
 * say that rather than "it failed", which is not known.
 */

import type { Integration } from "@agentify/gateway";
import { type MomentView, momentView } from "./views.js";
import { merchantItemIdFor, type SkippedProduct } from "./woo-catalog.js";
import { GRANT_MINUTES } from "./woo-connect.js";
import { PRODUCTS_AT_MOST } from "./woo-shop.js";
import { SITE_IN_SETTINGS, UNSET_WORDS, type Unset, type Way } from "./words.js";

/**
 * A shape of its own rather than the stored row, which also holds the shop's
 * key and secret: a type keeps those off every page.
 */
interface ConnectedShop {
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

/** Why nothing is connected although a Connect was started. */
export interface NoKeysYet {
  readonly what: string;
  readonly why: string;
  /** Only the wait has a next step of its own, looking again. */
  readonly waiting: boolean;
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
 * error says is not promised. Every screen that speaks of a Connect says these.
 */
export const noKeysYet = (state: ShopState): NoKeysYet | null => {
  if (state.kind === "waiting") {
    return {
      what: "Waiting for the keys from your shop",
      why: `You started connecting ${state.shopUrl} ${minutesAgo(state.startedMinutesAgo)}, and no keys have reached us yet. If you approved, your shop sends the keys in a separate request; reload in a moment to see whether they arrived. If you declined or closed the approval screen, you can start again now.`,
      waiting: true,
    };
  }
  if (state.kind === "unanswered") {
    return {
      what: "The keys from your shop did not arrive",
      why: `You started connecting ${state.shopUrl}, and no keys arrived from it in the ${GRANT_MINUTES} minutes we wait for them. This page cannot tell whether approval was declined, closed or rejected before it was saved. No access from that attempt is active here. Press Connect again; if WooCommerce showed an error, it already removed the key from that attempt.`,
      waiting: false,
    };
  }
  return null;
};

/**
 * The gateway refuses every card of a merchant who has not set these, in a
 * sentence naming an API route, which means nothing to a merchant with no code.
 * So the line names the setting as Settings does and links there, before the
 * press as well as after. After a refused press it says nothing was imported
 * and names what was unset at that moment, and only that answer is an alert: a
 * standing notice announced on every visit would drown it. The connector is not
 * offered on live, so the operator's approval never stands in the way here.
 */
interface BeforeImporting {
  readonly refused: boolean;
  /** The settings, in the words Settings uses for them. */
  readonly what: string;
}

/** How many of the orders a refusal names are drawn before the rest are counted. */
const ORDERS_DRAWN = 5;

/**
 * Why a press was refused, as the screen draws it: the sentence, then the
 * orders it names, which the merchant carries into their own system, each
 * drawn short with a button that copies it whole. A long list is cut, and how
 * many were left out is said.
 */
export interface Refusal {
  readonly says: string;
  readonly orders: readonly string[];
  readonly more: number;
}

/** A refusal as a press's answer hands it over: a sentence, or a refusal naming its orders. */
type Said = string | Readonly<{ why: string; orders?: readonly string[] }>;

const refusalOf = (said: Said | undefined): Refusal | null => {
  if (said === undefined) return null;
  if (typeof said === "string") return { says: said, orders: [], more: 0 };
  const orders = said.orders ?? [];
  return {
    says: said.why,
    orders: orders.slice(0, ORDERS_DRAWN),
    more: Math.max(0, orders.length - ORDERS_DRAWN),
  };
};

/** The shop the keys came from, the one state in which anything can be sold. */
export interface ConnectionView {
  readonly shopUrl: string;
  readonly connectedAt: MomentView;
  /**
   * What the shop granted where it is less than read and write, which cannot
   * create a single order; null where it is read and write.
   */
  readonly granted: string | null;
  /**
   * The switch to this shop, for a merchant whose shop is here while they sell
   * through their own code: a Disconnect cut off between moving them back and
   * forgetting the shop leaves them so, and so can two tabs. Nothing imported
   * sells until they press it.
   */
  readonly offerSwitch: boolean;
  /** Why selling through this shop, or Import, was just refused. */
  readonly switching: Refusal | null;
  readonly productsAtMost: number;
  readonly beforeImporting: BeforeImporting | null;
}

export interface WooShopView {
  readonly screen: "shop";
  /**
   * Said on coming back from the shop to a connected one, and drawn off the
   * row, never off the redirect: what a merchant reads on coming back is what
   * the connection says on a reload or tomorrow.
   */
  readonly keysArrived: boolean;
  readonly connection: ConnectionView | null;
  /**
   * The way back to the merchant's own code, for one who sells through a shop
   * that is not connected: they pressed Connect and never approved, or the
   * account was put on the shop by cards it had imported. Nothing reads a shop
   * for them, so the shop's cards cannot sell, and the code's are off sale
   * until they press it.
   */
  readonly wayBack: boolean;
  readonly noKeysYet: NoKeysYet | null;
  /** The box's value, so a refusal leaves it as the merchant left it. */
  readonly typed: string;
  /**
   * For a merchant on their own code, Connect switches them to the shop at
   * once, before they approve, and the form says so before the press.
   */
  readonly connectSwitches: boolean;
  /**
   * Why the press was refused: drawn under Connect, or, with a shop connected,
   * under the shop, since it is then about what the shop answered.
   */
  readonly problem: Refusal | null;
  /** Why going back to the merchant's own code was refused, beside the control that asked. */
  readonly leaving: Refusal | null;
}

/** What our rows and the gateway said when the screen was drawn. */
export interface ShopRead {
  readonly state: ShopState;
  readonly unset: readonly Unset[];
  readonly through: Integration;
}

/** What the screen is drawn in answer to, where it answers a press or a return. */
export interface ShopAnswer {
  readonly problem?: Said;
  readonly leaving?: Said;
  readonly switching?: Said;
  readonly typed?: string;
  readonly cameBack?: boolean;
  /** Where the screen answers a press of Import: what was unset at that moment. */
  readonly refused?: readonly Unset[];
}

export const wooShopView = (read: ShopRead, answer: ShopAnswer): WooShopView => {
  const { state } = read;
  const refused = answer.refused ?? [];
  const unset = refused.length > 0 ? refused : read.unset;
  return {
    screen: "shop",
    keysArrived: answer.cameBack === true && state.kind === "connected",
    connection:
      state.kind === "connected"
        ? {
            shopUrl: state.shop.shopUrl,
            connectedAt: momentView(state.shop.connectedAt.toISOString()),
            granted: state.shop.permissions === "read_write" ? null : state.shop.permissions,
            offerSwitch: read.through === "api",
            switching: refusalOf(answer.switching),
            productsAtMost: PRODUCTS_AT_MOST,
            beforeImporting:
              unset.length === 0
                ? null
                : {
                    refused: refused.length > 0,
                    what: unset.map((one) => UNSET_WORDS[one]).join(" and "),
                  },
          }
        : null,
    wayBack: state.kind !== "connected" && read.through === "woocommerce",
    noKeysYet: noKeysYet(state),
    typed:
      answer.typed ??
      (state.kind === "waiting" || state.kind === "unanswered" ? state.shopUrl : ""),
    connectSwitches: read.through === "api",
    problem: refusalOf(answer.problem),
    leaving: refusalOf(answer.leaving),
  };
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

/** A published product with the product code its card is found by on Cards. */
interface PublishedRow extends Published {
  readonly code: string;
}

/**
 * A refused product, and the page that puts it right where that is the
 * dashboard rather than the shop: the shop's site, which the person here sets
 * in Settings.
 */
interface RefusedRow extends Refused {
  readonly fix: Way | null;
}

/**
 * A page rather than a redirect, because it carries a list: each refusal is
 * the publish step's own sentence about one field of one card, the only thing
 * that tells a merchant what to change in their shop.
 */
export interface WooImportView {
  readonly screen: "import";
  readonly shopUrl: string;
  /** Every product the shop listed, whatever became of it. */
  readonly read: number;
  /**
   * False once a product got no verdict: the import stops there, and every
   * product after it is not attempted.
   */
  readonly finished: boolean;
  readonly published: readonly PublishedRow[];
  readonly refused: readonly RefusedRow[];
  readonly unanswered: readonly Unanswered[];
  readonly notAttempted: readonly NotAttempted[];
  readonly skipped: readonly SkippedProduct[];
}

const TO_SETTINGS: Way = { to: "/settings", words: "Open Settings" };

export const wooImportView = (
  shopUrl: string,
  outcomes: readonly ImportOutcome[],
  skipped: readonly SkippedProduct[],
): WooImportView => {
  const published = outcomes.filter((one): one is Published => "published" in one);
  const refused = outcomes.filter((one): one is Refused => "problems" in one);
  const unanswered = outcomes.filter((one): one is Unanswered => "failed" in one);
  const notAttempted = outcomes.filter((one): one is NotAttempted => "notAttempted" in one);
  return {
    screen: "import",
    shopUrl,
    read: outcomes.length + skipped.length,
    finished: unanswered.length === 0,
    published: published.map((one) => ({ ...one, code: merchantItemIdFor(shopUrl, one.id) })),
    refused: refused.map((one) => ({
      ...one,
      fix: one.problems.includes(SITE_IN_SETTINGS) ? TO_SETTINGS : null,
    })),
    unanswered,
    notAttempted,
    skipped,
  };
};

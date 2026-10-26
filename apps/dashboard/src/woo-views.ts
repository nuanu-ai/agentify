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
import { gapOf } from "./woo-money.js";
import type { ReferenceRead } from "./woo-reference.js";
import type { SavedRate, ShopCurrency } from "./woo-shops.js";
import { SITE_IN_SETTINGS, type Unset, type Way } from "./words.js";

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

/**
 * A shop is printed by its name, which is its host, on every screen; the
 * scheme is said only where an address is typed.
 */
export const shopNameOf = (address: string): string => {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
};

/**
 * What a Disconnect form drawn with no shop connected carries in place of the
 * shop's address, so a press from a page drawn before one was connected
 * forgets nothing.
 */
export const NO_SHOP = "none";

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
 * Two states because the move differs: inside the fifteen minutes, wait; past
 * them a post would meet an expired token, so press Connect again. Neither
 * names a cause, because the rows hold the same nothing whether the merchant
 * declined, closed the screen, or approved and the shop's post failed. Every
 * screen that speaks of a Connect says these.
 */
export const noKeysYet = (state: ShopState): NoKeysYet | null => {
  if (state.kind === "waiting") {
    return {
      what: "Waiting for your shop's keys",
      why: `You started connecting ${shopNameOf(state.shopUrl)} ${minutesAgo(state.startedMinutesAgo)}. If you approved, the keys arrive in a moment. If you closed the approval screen, connect again.`,
      waiting: true,
    };
  }
  if (state.kind === "unanswered") {
    return {
      what: "No keys came from your shop",
      why: `No keys came from ${shopNameOf(state.shopUrl)} within ${GRANT_MINUTES} minutes, and we can't tell why. Connect again.`,
      waiting: false,
    };
  }
  return null;
};

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
  /**
   * The page to go on to, said under the sentence: pausing all sales where
   * purchases about to lapse hold a move and new ones can keep arriving, or
   * Products where an import already running publishes what it reads.
   */
  readonly follow: "pause" | "products" | null;
}

/**
 * The orders that hold a move between integrations, as the shop screen words
 * them: `quick` where every one still open is a purchase not yet paid, whose
 * price lapses in seconds, and `parcels` where a parcel is among them, which
 * ends when its shop marks it Completed or its seven days run out.
 */
export interface Held {
  readonly to: Integration;
  readonly orders: readonly string[];
  readonly quick: boolean;
  readonly parcels: boolean;
}

/** An order as the open list shows it, as much as a held move reads of it. */
export interface OpenOrder {
  readonly id: string;
  readonly status: string;
  readonly payment_status: string;
  readonly ship_to?: unknown;
}

/**
 * The orders that held a move, as the open list shows them now, which is what
 * See open orders leads to: an order missing from it has ended since the
 * refusal, or has no price yet, which it gets within seconds or never. Where
 * the list could not be read, the refusal's own orders, said as goods owed.
 */
export const heldBy = (
  to: Integration,
  named: readonly string[],
  open: readonly OpenOrder[] | null,
): Held => {
  if (open === null) return { to, orders: named, quick: false, parcels: false };
  const still = open.filter((order) => named.includes(order.id));
  return {
    to,
    orders: still.map((order) => order.id),
    quick:
      still.length > 0 &&
      still.every((order) => order.status === "in_progress" && order.payment_status === "not_paid"),
    parcels: still.some((order) => order.ship_to !== undefined),
  };
};

/**
 * A refusal as a press's answer hands it over: a sentence, a refusal's own
 * words, held orders, or an import of the shop already running.
 */
export type Said =
  | string
  | Readonly<{ why: string }>
  | Readonly<{ held: Held }>
  | Readonly<{ running: true }>;

const heldSays = ({ to, orders, quick, parcels }: Held): string => {
  // Each order the refusal named has ended since, or has no price yet, which
  // it gets within seconds or never: nothing is known to hold it any more.
  if (orders.length === 0)
    return "None of the orders that blocked this is on Orders any more. Try again in a moment.";
  const one = orders.length === 1;
  const counted = `${orders.length} ${one ? "order" : "orders"} from your ${to === "woocommerce" ? "code" : "shop"} ${one ? "is" : "are"}`;
  if (quick) return `${counted} still in progress and should end within a minute. Try again then.`;
  return (
    `${counted} still open. Try again once ${one ? "it ends" : "they end"}.` +
    (to === "api" && parcels
      ? " A parcel ends when you mark it Completed in WooCommerce, or after its seven days."
      : "")
  );
};

const refusalOf = (said: Said | undefined): Refusal | null => {
  if (said === undefined) return null;
  if (typeof said === "string") return { says: said, orders: [], more: 0, follow: null };
  if ("why" in said) return { says: said.why, orders: [], more: 0, follow: null };
  if ("running" in said) {
    return {
      says: "An import of your shop is already running. Import again once it ends to see a result here.",
      orders: [],
      more: 0,
      follow: "products",
    };
  }
  const { held } = said;
  // Purchases about to lapse are not worth copying: they are gone in a minute.
  const named = held.quick ? [] : held.orders;
  return {
    says: heldSays(held),
    orders: named.slice(0, ORDERS_DRAWN),
    more: Math.max(0, named.length - ORDERS_DRAWN),
    follow: held.quick ? "pause" : null,
  };
};

/**
 * Settings' own names for what the gateway refuses every card without, so the
 * line beside a held Import names what that page calls it.
 */
const SETTING_NAMES: Readonly<Record<Unset, string>> = Object.freeze({
  no_seller_name: "seller name",
  no_payout_wallet: "payout wallet",
});

/**
 * Why Import cannot publish anything, known before it is pressed: the gateway
 * refuses every card of a merchant missing a setting, and a shop in another
 * currency publishes nothing until its rate is set. The button is held and
 * says which, so a press is not spent on reading a shop for nothing.
 */
export type ImportHeld =
  | Readonly<{ kind: "settings"; what: string }>
  | Readonly<{ kind: "rate"; currency: string }>
  /** Coinbase gives no rate for the shop's currency, so no rate can be saved and nothing sells. */
  | Readonly<{ kind: "unlisted"; currency: string }>;

/** The shop the keys came from, the one state in which anything can be sold. */
export interface ConnectionView {
  /** The shop's address, which Connect again sends. */
  readonly shopUrl: string;
  readonly shop: string;
  readonly connectedAt: MomentView;
  /**
   * The shop granted less than read and write, which cannot create a single
   * order, so every purchase is refused before payment.
   */
  readonly readOnly: boolean;
  /**
   * The merchant sells through their own code while this shop is connected: an
   * order of the code's open when the keys arrived refused the switch, or a
   * Disconnect was cut off between moving them back and forgetting the shop.
   * Nothing imported sells, and nothing can be imported, until they switch.
   */
  readonly onCode: boolean;
  /** Why selling through this shop was just refused. */
  readonly switching: Refusal | null;
  /** Why the last press of Import, or of Save rate, read nothing. */
  readonly importing: Refusal | null;
  readonly held: ImportHeld | null;
  /** Null where the shop sells in US dollars, or its currency was never read. */
  readonly rate: RateView | null;
}

/**
 * The rate a shop priced in another currency sells at, which the merchant sets:
 * how many units of the shop's currency one US dollar buys, with Coinbase's
 * open rate beside it as a reference that prices nothing.
 */
export interface RateView {
  readonly currency: string;
  /** "Indonesian Rupiah (IDR)". */
  readonly named: string;
  readonly current: {
    /** As saved, its thousands grouped for reading. */
    readonly rate: string;
    readonly raw: string;
    readonly setAt: MomentView;
    /** When the session that saved it signed in; null where that is not recorded. */
    readonly sessionSignedInAt: MomentView | null;
    /** How the current rate stands against the reference read now, where one was. */
    readonly gap: string | null;
    readonly far: boolean;
  } | null;
  readonly reference:
    | { readonly kind: "read"; readonly rate: string; readonly readAt: MomentView }
    /** Coinbase answered and gives no rate for the currency. */
    | { readonly kind: "unlisted" }
    /** Coinbase did not answer, which says nothing about the currency. */
    | { readonly kind: "unread" };
  /** The rate just typed, kept in the field. */
  readonly typed: string;
  /** A rate standing far from the reference, to be typed again before it is saved. */
  readonly again: string | null;
  /** Why the rate just typed was refused, said under its box. */
  readonly problem: string | null;
  /** Why a press of Save rate saved nothing for a reason other than what was typed. */
  readonly refused: string | null;
  /** What a press of Save rate did, where it saved one. */
  readonly saved: string | null;
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
   * that is not connected, which an account put on the shop by cards it had
   * imported can be. Nothing reads a shop for them, so the shop's cards cannot
   * sell, and the code's are off sale until they press it.
   */
  readonly wayBack: boolean;
  readonly noKeysYet: NoKeysYet | null;
  /** The box's value, so a refusal leaves it as the merchant left it. */
  readonly typed: string;
  /** Why the address typed was refused, said under its box. */
  readonly addressProblem: string | null;
  /**
   * For a merchant on their own code, the shop's keys arriving switch them to
   * the shop, and the form says so before the press.
   */
  readonly connectSwitches: boolean;
  /**
   * How many products the merchant's own code published, which every switch
   * takes off sale or brings back; null where they could not be counted, which
   * is said without a number rather than as none.
   */
  readonly codeProducts: number | null;
  /** Why a press of Connect, or Connect again, was refused about something other than the address. */
  readonly problem: Refusal | null;
  /** Why going back to the merchant's own code was refused, beside the control that asked. */
  readonly leaving: Refusal | null;
}

/** What our rows and the gateway said when the screen was drawn. */
export interface ShopRead {
  readonly state: ShopState;
  readonly through: Integration;
  /** The products the merchant's code published; null where they could not be counted. */
  readonly codeProducts?: number | null;
  /**
   * What publishing needs and is not set, read for a connected shop; null where
   * it could not be read, which holds nothing, the press finding out instead.
   */
  readonly unset?: readonly Unset[] | null;
  /** For a connected shop in another currency: its rate now and Coinbase's. */
  readonly rate?: {
    readonly currency: ShopCurrency;
    readonly current: SavedRate | null;
    readonly reference: ReferenceRead;
  };
}

/** What the screen is drawn in answer to, where it answers a press or a return. */
export interface ShopAnswer {
  readonly addressProblem?: string;
  readonly problem?: Said;
  readonly leaving?: Said;
  readonly switching?: Said;
  readonly importing?: Said;
  readonly typed?: string;
  readonly cameBack?: boolean;
  /** Where it answers a press of Save rate, or an Import that wanted a rate first. */
  readonly rate?: {
    readonly typed?: string;
    readonly again?: string;
    readonly problem?: string;
    readonly refused?: string;
    readonly saved?: string;
  };
}

const CURRENCY_NAMES = new Intl.DisplayNames(["en"], { type: "currency" });

/** A rate as typed, its thousands grouped for reading and nothing rounded. */
export const groupedRate = (rate: string): string => {
  const [whole = "", fraction] = rate.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
};

/**
 * Coinbase's rate as a reference to read beside one's own: whole units where
 * they are large, four decimals where they are small. It prices nothing.
 */
export const referenceShown = (rate: string): string => {
  const value = Number(rate);
  return value.toLocaleString("en-US", { maximumFractionDigits: value >= 100 ? 0 : 4 });
};

const rateViewOf = (read: NonNullable<ShopRead["rate"]>, answer: ShopAnswer): RateView => {
  const { currency, current, reference } = read;
  const gap = current !== null && reference.ok ? gapOf(current.rate, reference.rate) : null;
  return {
    currency: currency.code,
    named: `${CURRENCY_NAMES.of(currency.code) ?? currency.code} (${currency.code})`,
    current:
      current === null
        ? null
        : {
            rate: groupedRate(current.rate),
            raw: current.rate,
            setAt: momentView(current.setAt.toISOString()),
            sessionSignedInAt:
              current.sessionSignedInAt === null
                ? null
                : momentView(current.sessionSignedInAt.toISOString()),
            gap: gap?.shown ?? null,
            far: gap?.far ?? false,
          },
    reference: reference.ok
      ? {
          kind: "read",
          rate: referenceShown(reference.rate),
          readAt: momentView(reference.readAt.toISOString()),
        }
      : reference.listed === false
        ? { kind: "unlisted" }
        : { kind: "unread" },
    typed: answer.rate?.typed ?? "",
    again: answer.rate?.again ?? null,
    problem: answer.rate?.problem ?? null,
    refused: answer.rate?.refused ?? null,
    saved: answer.rate?.saved ?? null,
  };
};

/** What publishing lacks, in Settings' own names: "seller name and payout wallet". */
export const settingsNamed = (unset: readonly Unset[]): string =>
  unset.map((one) => SETTING_NAMES[one]).join(" and ");

const heldImport = (read: ShopRead): ImportHeld | null => {
  const unset = read.unset ?? [];
  if (unset.length > 0) {
    return { kind: "settings", what: settingsNamed(unset) };
  }
  if (read.rate !== undefined && read.rate.current === null) {
    const { reference, currency } = read.rate;
    return {
      kind: !reference.ok && reference.listed === false ? "unlisted" : "rate",
      currency: currency.code,
    };
  }
  return null;
};

export const wooShopView = (read: ShopRead, answer: ShopAnswer): WooShopView => {
  const { state } = read;
  const wayBack = state.kind !== "connected" && read.through === "woocommerce";
  // A refused Disconnect with no Disconnect left on the page, the merchant
  // being on their code with no shop, is said beside Connect instead.
  const leavingUnplaced = state.kind !== "connected" && !wayBack;
  return {
    screen: "shop",
    keysArrived: answer.cameBack === true && state.kind === "connected",
    connection:
      state.kind === "connected"
        ? {
            shopUrl: state.shop.shopUrl,
            shop: shopNameOf(state.shop.shopUrl),
            connectedAt: momentView(state.shop.connectedAt.toISOString()),
            readOnly: state.shop.permissions !== "read_write",
            onCode: read.through === "api",
            switching: refusalOf(answer.switching),
            importing: refusalOf(answer.importing),
            held: heldImport(read),
            rate: read.rate === undefined ? null : rateViewOf(read.rate, answer),
          }
        : null,
    wayBack,
    noKeysYet: noKeysYet(state),
    typed:
      answer.typed ??
      (state.kind === "waiting" || state.kind === "unanswered" ? state.shopUrl : ""),
    addressProblem: answer.addressProblem ?? null,
    connectSwitches: read.through === "api",
    codeProducts: read.codeProducts === undefined ? null : read.codeProducts,
    problem: refusalOf(answer.problem ?? (leavingUnplaced ? answer.leaving : undefined)),
    leaving: leavingUnplaced ? null : refusalOf(answer.leaving),
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
  /** A finding is about a length, which the shop's editor counts with the markup in. */
  readonly tooLong?: true;
}

/**
 * The publish step gave no answer about it: whether it was published is not
 * known.
 */
interface Unanswered extends Sent {
  readonly failed: true;
}

interface NotAttempted extends Sent {
  readonly notAttempted: true;
}

/**
 * A product the publish step never answered about is a shape of its own, so no
 * screen can fold it into the refusals a merchant can repair in their shop.
 */
export type ImportOutcome = Published | Refused | Unanswered | NotAttempted;

/** A published product with the product code its card is found by on Products. */
interface PublishedRow extends Published {
  readonly code: string;
}

/**
 * A product the merchant can put right, and the page that does it where that
 * is the dashboard rather than the shop: the shop's site, which the person
 * here sets in Settings.
 */
interface FixRow extends Sent {
  readonly says: readonly string[];
  readonly fix: Way | null;
}

/**
 * A page rather than a redirect, because it carries a list. Its groups follow
 * what the merchant does next: put right in the shop, import again, nothing,
 * or nothing more than reading.
 */
export interface WooImportView {
  readonly screen: "import";
  readonly shop: string;
  /** Where the import ran because a rate was saved: what was saved. */
  readonly rateSaved: string | null;
  /** Every product the shop listed, whatever became of it. */
  readonly read: number;
  /**
   * False once a product got no verdict: the import stops there, and every
   * product after it is not attempted.
   */
  readonly finished: boolean;
  /**
   * Refused by Agentify's rules in their own words, or left by the connector
   * for something the shop can change.
   */
  readonly toFix: readonly FixRow[];
  readonly tooLong: boolean;
  readonly unanswered: readonly Sent[];
  readonly notAttempted: readonly Sent[];
  /** Left by the connector for what no change in the shop's product puts right. */
  readonly unsupported: readonly SkippedProduct[];
  readonly published: readonly PublishedRow[];
}

const TO_SETTINGS: Way = { to: "/settings", words: "Open Settings" };

export const wooImportView = (
  shopUrl: string,
  outcomes: readonly ImportOutcome[],
  skipped: readonly SkippedProduct[],
  rateSaved: string | null = null,
): WooImportView => {
  const published = outcomes.filter((one): one is Published => "published" in one);
  const refused = outcomes.filter((one): one is Refused => "problems" in one);
  const unanswered = outcomes.filter((one): one is Unanswered => "failed" in one);
  return {
    screen: "import",
    shop: shopNameOf(shopUrl),
    rateSaved,
    read: outcomes.length + skipped.length,
    finished: unanswered.length === 0,
    toFix: [
      ...refused.map((one) => ({
        id: one.id,
        title: one.title,
        says: one.problems,
        fix: one.problems.includes(SITE_IN_SETTINGS) ? TO_SETTINGS : null,
      })),
      ...skipped
        .filter((one) => one.fixable)
        .map((one) => ({ id: one.id, title: one.title, says: [one.why], fix: null })),
    ],
    tooLong: refused.some((one) => one.tooLong === true),
    unanswered: unanswered.map(({ id, title }) => ({ id, title })),
    notAttempted: outcomes
      .filter((one): one is NotAttempted => "notAttempted" in one)
      .map(({ id, title }) => ({ id, title })),
    unsupported: skipped.filter((one) => !one.fixable),
    published: published.map((one) => ({ ...one, code: merchantItemIdFor(shopUrl, one.id) })),
  };
};

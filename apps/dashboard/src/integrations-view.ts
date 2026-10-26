/**
 * What the integrations screen shows: the merchant's own code always, and
 * beside it the state of the account's WooCommerce connection where this
 * dashboard has somewhere to keep one, with the way the merchant sells through
 * marked. That mark is the gateway's to say; where it cannot be read neither
 * way is marked and the page says so, so the gateway cannot take the page down.
 */

import type { Integration } from "@agentify/gateway";
import { type MomentView, momentView } from "./views.js";
import { noKeysYet, type ShopTile, shopNameOf } from "./woo-views.js";

/**
 * The state rather than a standing invitation: "connect a WooCommerce shop"
 * over a connected shop would tell a merchant their Connect failed. A grant
 * narrower than read and write is said as such, because that channel cannot
 * deliver a single order.
 */
export type ShopTileView =
  | Readonly<{ kind: "unread" }>
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "connected";
      shop: string;
      connectedAt: MomentView;
      readOnly: boolean;
    }>
  | Readonly<{ kind: "not-arrived"; what: string; why: string; next: string }>;

/** What the gateway said about the merchant's integration, or that it said nothing. */
export type ThroughRead =
  | Readonly<{ through: Integration; offSale: readonly string[] }>
  | Readonly<{ unread: true }>;

export interface IntegrationsView {
  readonly lede: string;
  /**
   * The way new sales go through, marked on its block; null where none is
   * marked: no shop is offered, the gateway did not say, or the merchant has
   * done nothing on the shop's side, so selling through their code is no
   * choice of theirs to point at.
   */
  readonly inUse: Integration | null;
  /** Which way the merchant sells through could not be read. */
  readonly throughUnread: boolean;
  /** Null where this dashboard keeps no connection, which draws no block at all. */
  readonly shop: ShopTileView | null;
}

/** In the shop screen's own words about a Connect that brought no keys. */
const tileOf = (shop: ShopTile): ShopTileView => {
  if (shop.kind === "unread") return { kind: "unread" };
  if (shop.kind === "connected") {
    return {
      kind: "connected",
      shop: shopNameOf(shop.shop.shopUrl),
      connectedAt: momentView(shop.shop.connectedAt.toISOString()),
      readOnly: shop.shop.permissions !== "read_write",
    };
  }
  const said = noKeysYet(shop);
  return said === null
    ? { kind: "none" }
    : {
        kind: "not-arrived",
        what: said.what,
        why: said.why,
        next: said.waiting ? "Open WooCommerce page" : "Connect again",
      };
};

const inUseOf = (shop: ShopTile, read: ThroughRead): Integration | null => {
  if ("unread" in read) return null;
  if (read.through === "woocommerce") return "woocommerce";
  // Off sale while the code sells are the shop's products, so none means the
  // shop has never had a part in this account.
  return shop.kind === "none" && read.offSale.length === 0 ? null : "api";
};

/** `shop` and `through` are both absent where this dashboard offers no connector. */
export const integrationsView = (
  ...read: readonly [] | readonly [shop: ShopTile, through: ThroughRead]
): IntegrationsView => {
  if (read.length === 0) {
    return {
      lede: "Your products reach Agentify from your own code.",
      inUse: null,
      throughUnread: false,
      shop: null,
    };
  }
  const [shop, through] = read;
  return {
    lede: "You sell through your own code or through a WooCommerce shop, one at a time.",
    inUse: inUseOf(shop, through),
    throughUnread: "unread" in through,
    shop: tileOf(shop),
  };
};

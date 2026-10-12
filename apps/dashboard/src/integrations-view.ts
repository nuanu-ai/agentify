/**
 * What the integrations screen shows: the SDK always, and beside it the state
 * of the account's WooCommerce connection where this dashboard has somewhere to
 * keep one. Nothing on it comes from the gateway, so the gateway cannot take it
 * down.
 */

import { type FrameView, type MomentView, momentView } from "./views.js";
import { keysNotArrived, type ShopTile } from "./woo-screens.js";

/**
 * The state rather than a standing invitation: "connect a WooCommerce shop"
 * over a connected shop would tell a merchant their Connect failed. A grant
 * narrower than read and write is named, because that channel cannot deliver
 * a single order.
 */
export type ShopTileView =
  | Readonly<{ kind: "unread" }>
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "connected";
      shopUrl: string;
      connectedAt: MomentView;
      /** Null where the shop granted read and write. */
      narrower: string | null;
    }>
  | Readonly<{ kind: "not-arrived"; what: string; why: string; next: string }>;

export interface IntegrationsView {
  readonly frame: FrameView;
  readonly lede: string;
  /** Null where this dashboard keeps no connection, which draws no block at all. */
  readonly shop: ShopTileView | null;
}

const tileOf = (shop: ShopTile): ShopTileView => {
  switch (shop.kind) {
    case "unread":
    case "none":
      return { kind: shop.kind };
    case "connected":
      return {
        kind: "connected",
        shopUrl: shop.shop.shopUrl,
        connectedAt: momentView(shop.shop.connectedAt.toISOString()),
        narrower: shop.shop.permissions === "read_write" ? null : shop.shop.permissions,
      };
    case "waiting":
    case "unanswered":
      return {
        kind: "not-arrived",
        ...keysNotArrived(shop),
        next: shop.kind === "waiting" ? "Check the connection" : "Connect again",
      };
  }
};

export const integrationsView = (shop: ShopTile | undefined): IntegrationsView => ({
  frame: { unnamed: false },
  lede:
    shop === undefined
      ? "Your products reach Agentify from your own code through the SDK."
      : "Your products reach Agentify from your own code through the SDK, or from a WooCommerce shop, one of the two at a time.",
  shop: shop === undefined ? null : tileOf(shop),
});

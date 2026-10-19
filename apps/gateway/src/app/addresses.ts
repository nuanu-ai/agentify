/**
 * The whole addresses this gateway hands an agent to call: where a product is
 * bought and where an order is read again. Each is built from the address the
 * gateway is configured to answer as, never from a request: behind the proxy
 * that ends the agent's TLS a request says plain http, and its host and
 * forwarding headers are whatever the proxy or the caller wrote, so an address
 * built from them could send a paid order's identifier anywhere. An identifier
 * goes through the route table's substitution, since it may hold a character
 * that would split the path.
 */

import { API_ROUTES, expandPath } from "@nuanu-ai/agentify-contracts";
import type { GatewayConfig } from "../config.js";

type Configured = Pick<GatewayConfig, "publicBaseUrl">;

/**
 * Where one product is bought. A discovery catalog keys a listing on this
 * address, so the catalog, the payment challenge and the declaration inside it
 * all name it from here.
 */
export const purchaseUrlOf = (config: Configured, itemId: string): string =>
  `${config.publicBaseUrl}${expandPath(API_ROUTES.purchase_item.path, { item_id: itemId })}`;

/** Where one order is read again, and where goods that come later are collected. */
export const statusUrlOf = (config: Configured, orderId: string): string =>
  `${config.publicBaseUrl}${expandPath(API_ROUTES.get_order_status.path, { order_id: orderId })}`;

/**
 * The WooCommerce block of the integrations screen, still drawn as a string.
 * It says what our rows hold, in the words of `woo-views.ts`, which the shop
 * screen draws as well.
 */

import { escaped, when } from "./html.js";
import { noKeysYet, type ShopState, type ShopTile } from "./woo-views.js";

/**
 * Draws the state rather than a standing invitation: "connect a WooCommerce
 * shop" over a connected shop would tell a merchant their Connect failed. The
 * same states and sentences as the shop screen, since two pages saying
 * different things about one row is worse than saying nothing; every action is
 * on the shop screen. `unread` is this screen's alone. A grant less than read
 * and write is said too: that channel cannot deliver a single order.
 */
export const wooSettingsBlock = (base: string, state: ShopTile): string => {
  // No link to the shop screen when unread: that page needs the same read and
  // would answer with an error.
  const said =
    state.kind === "unread"
      ? `<p>Whether a shop is connected to this account could not be read just now.</p>
      <p class="quiet">The fault is on our side, not in your shop, and nothing was disconnected by it. Reload this page in a moment.</p>`
      : state.kind === "connected"
        ? `<p>${escaped(state.shop.shopUrl)}, connected ${when(state.shop.connectedAt.toISOString())}.</p>
      ${
        state.shop.permissions === "read_write"
          ? ""
          : `<p class="problem">Your shop granted ${escaped(state.shop.permissions)} access rather than read and write, so a fresh purchase is unavailable before payment. Connect again and approve read and write access.</p>`
      }
      <div class="connect-actions"><a class="button button-secondary" href="${escaped(base)}/woocommerce">Your shop</a></div>`
        : state.kind === "none"
          ? `<p>The connector imports two narrow WooCommerce configurations, a download and a parcel, which the shop screen describes. You sell through it or through your own code, one at a time.</p>
      <div class="connect-actions"><a class="button button-primary" href="${escaped(base)}/woocommerce">Connect a WooCommerce shop</a></div>`
          : `${noKeysYetBlock(state)}
      <div class="connect-actions"><a class="button button-primary" href="${escaped(base)}/woocommerce">${state.kind === "waiting" ? "Check the connection" : "Connect again"}</a></div>`;

  return `
      <h3>WooCommerce</h3>
      ${said}
`;
};

const noKeysYetBlock = (state: ShopState): string => {
  const said = noKeysYet(state);
  return said === null
    ? ""
    : `  <div class="callout">
    <div class="what">${escaped(said.what)}</div>
    <div class="why">${escaped(said.why)}</div>
  </div>
`;
};

/**
 * What the WooCommerce screens share with the server: how a shop is named,
 * what a form carries for no shop, and the recovery page's two refusals. Kept
 * apart from the connector's server code, which reaches `node:crypto` and the
 * network, so a screen's script that imports these does not carry it.
 */

/**
 * What a Disconnect form drawn with no shop connected carries in place of the
 * shop's address, so a press from a page drawn before one was connected
 * forgets nothing.
 */
export const NO_SHOP = "none";

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

/** Said where a download's shop order waits for its shop to be connected again. */
export const RECONNECT_FIRST =
  "Connect the same shop again on the WooCommerce page first, then create the order here.";

/** Said where a parcel's shop order was never made; nothing is kept to make it from. */
export const PARCEL_NOT_CREATED =
  "Your shop never got this order, and a parcel's order can't be made later: Agentify doesn't keep the delivery address.";

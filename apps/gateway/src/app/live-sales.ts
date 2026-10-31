import type { SurfaceMode } from "@agentify/core";
import type { JournalPress } from "../ports/journal.js";
import { checkedDecline, type LiveSalesAsk } from "../ports/live-sales.js";
import type { Store } from "../ports/store.js";

/** Records the seller's ask and its notice; a payout wallet is not required. */
export async function requestLiveSales(
  store: Store,
  input: LiveSalesAsk,
  at: number,
  surface: SurfaceMode,
) {
  if (surface !== "live") throw new Error("live-sales requests belong to the live channel");
  return store.requestLiveSales(input, at);
}
/** Declines only the request the operator reviewed, preserving the full note. */
export async function declineLiveSales(
  store: Store,
  merchantId: string,
  requestId: string,
  press: JournalPress,
) {
  checkedDecline(merchantId, press);
  return store.declineLiveSales(merchantId, requestId, press);
}

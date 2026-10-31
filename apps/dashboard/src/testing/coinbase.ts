import { coinbaseRates } from "@agentify/recorded";
import { type ReferenceRead, referenceRateOf } from "../woo-reference.js";

/** What the dashboard reads from Coinbase's recorded answer for `currency`, at the moment it was recorded. */
export const coinbaseAsRecorded = (currency: string): Promise<ReferenceRead> =>
  referenceRateOf(currency, {
    request: async () => new Response(coinbaseRates.body, { status: coinbaseRates.status }),
    now: () => coinbaseRates.readAt,
  });

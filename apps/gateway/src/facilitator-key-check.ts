/**
 * Shows the channel's facilitator key to Coinbase, as the gateway's own start
 * does, and says what came back: Coinbase let it through, refused it, or could
 * not be asked. It buys nothing and changes nothing, so it can run on demand.
 * What it returns is written here, never Coinbase's own body, so no key
 * material and no wallet address can be in it.
 */

import {
  askCoinbaseAboutTheKey,
  CANNOT_SIGN,
  facilitatorClientFor,
  refusedWith,
} from "./adapters/x402/client.js";
import { isCdpFacilitator, type PaymentConfig } from "./config.js";

export type FacilitatorKeyCheck = {
  /** When the check was made. */
  readonly checkedAt: number;
  /** One sentence on what was asked and what came back. */
  readonly said: string;
} & (
  | {
      /** Coinbase judged an empty payment instead of refusing the key. */
      readonly outcome: "taken";
    }
  | {
      /** The credentials cannot sign, or Coinbase refused the key itself. */
      readonly outcome: "refused";
    }
  | {
      /** Coinbase could not say, which says nothing about the key either way. */
      readonly outcome: "unconfirmed";
    }
  | {
      /** The channel's facilitator is not Coinbase's, so there is no key to ask about. */
      readonly outcome: "not_coinbase";
    }
);

export async function checkFacilitatorKey(
  payment: PaymentConfig,
  post: typeof fetch = fetch,
  clock: () => number = Date.now,
): Promise<FacilitatorKeyCheck> {
  const notCoinbase = `${payment.facilitatorUrl} is not Coinbase's facilitator, so there is no key to ask Coinbase about`;
  if (!isCdpFacilitator(payment.facilitatorUrl)) {
    return { checkedAt: clock(), outcome: "not_coinbase", said: notCoinbase };
  }
  let client: ReturnType<typeof facilitatorClientFor>;
  try {
    client = facilitatorClientFor(payment);
  } catch (unbuilt) {
    // Only this repository's own sentence about the missing variables is thrown here.
    const said = unbuilt instanceof Error ? unbuilt.message : String(unbuilt);
    return { checkedAt: clock(), outcome: "refused", said };
  }
  const answer = await askCoinbaseAboutTheKey(client, post);
  const checkedAt = clock();
  switch (answer.kind) {
    case "taken":
      return {
        checkedAt,
        outcome: "taken",
        said:
          "Coinbase let the key in CDP_API_KEY_ID and CDP_API_KEY_SECRET through: it judged the " +
          "empty payment instead of refusing the key",
      };
    case "not_coinbase":
      return { checkedAt, outcome: "not_coinbase", said: notCoinbase };
    case "cannot_sign":
      return {
        checkedAt,
        outcome: "refused",
        said: `The facilitator credentials do not work, and nothing was sent to Coinbase: ${CANNOT_SIGN}`,
      };
    case "refused":
      return {
        checkedAt,
        outcome: "refused",
        said:
          `Coinbase refuses the facilitator credentials: ${refusedWith(answer.status)}. While it ` +
          "does, every purchase fails at verify",
      };
    case "unconfirmed":
      return {
        checkedAt,
        outcome: "unconfirmed",
        said:
          "The key in CDP_API_KEY_ID and CDP_API_KEY_SECRET is unconfirmed: Coinbase could not " +
          `say whether it takes it (${answer.why}), which says nothing about the key either way`,
      };
  }
}

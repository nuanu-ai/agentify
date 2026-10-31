import { withUnit } from "@agentify/ui/units";
import type { RateView, RateViewState } from "./woo-views.js";

export interface RateWords {
  readonly explanation: string;
  readonly unlisted: string;
  readonly unavailable: string;
  readonly pending: string;
  readonly hint: string;
  readonly field: string;
  readonly yourRate: string | null;
  readonly referenceRate: string | null;
  readonly noSession: string;
  readonly sessionLead: string;
  readonly sessionTail: string;
}

/** The existing rate view owns display wording without changing the saved rate. */
export function presentRateView(rate: RateViewState): RateView {
  const { current, reference, currency } = rate;
  const unavailable =
    "Couldn't be read just now, so a rate saved now isn't compared with anything.";
  const pending = "Coinbase’s reference rate is checked when you save.";
  return {
    ...rate,
    words: {
      explanation: `Your shop sells in ${rate.named}. Agents pay in US dollars at your rate.${current === null ? " We check your products once the rate is saved." : ""}`,
      unlisted: `Coinbase gives no rate for ${currency}, so no rate can be saved for this shop.`,
      unavailable,
      pending,
      hint:
        reference.kind === "read"
          ? `Coinbase today: ${withUnit(reference.rate, currency)} per US dollar`
          : reference.kind === "not_requested"
            ? pending
            : `Coinbase: ${unavailable}`,
      field: `${currency} per US dollar`,
      yourRate:
        current === null
          ? null
          : `${withUnit(current.rate, currency)} per US dollar${current.gap === null ? "" : `, ${current.gap} Coinbase's`}`,
      referenceRate:
        reference.kind === "read"
          ? `${withUnit(reference.rate, currency)} per US dollar, read`
          : null,
      noSession: ". When its session signed in isn't recorded.",
      sessionLead: ", from a session that signed in ",
      sessionTail: ". That time doesn't prove who saved it.",
    },
  };
}

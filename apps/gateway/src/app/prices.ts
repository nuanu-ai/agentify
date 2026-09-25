/**
 * What a price a merchant sets has to be before this gateway will sell at it.
 *
 * A price comes in by two doors: on a card, when it is published, and in the
 * answer to a price question, when a purchase is priced live. Both are held to
 * the rules below and nothing else is, because both are the moment a merchant
 * is in front of somebody who can tell them what is wrong. Three rules, each
 * standing for a payment this gateway cannot take.
 *
 * A price of zero is refused. Nothing has yet been sold for nothing through the
 * payment step — the challenge, the facilitator's check and its settlement —
 * and what that step does with a charge of zero is not known. That is a "not
 * yet": it is lifted once a free sale has been carried through payment from
 * end to end (ADR-0002 §2).
 *
 * A currency other than the dollar is refused, because there is no exchange
 * rate anywhere in this system to charge it at. The set is the one the payment
 * edge charges in (`http/x402.ts` reads it from here), so a price the door took
 * is a price the edge can charge and the two cannot drift into two lists.
 *
 * An amount is written in dollars with at least two digits after the dot, so
 * that a merchant who counts in cents and writes "500" for five dollars is
 * refused rather than listed at five hundred. Fractions of a cent stay allowed:
 * a price per call is often below one. How many places a charge may carry is
 * the payment edge's own bound and is not repeated here.
 *
 * What these rules do not touch is a card already stored. Every answer that
 * carries a card is held to the contract on its way out, so a rule written
 * into the card's schema would turn the whole list of a merchant who published
 * such a price before the rule existed into a failure. And the contract itself
 * says which currencies are accepted is the gateway's question, not its own.
 */

import type { Money, Problem } from "@nuanu-ai/agentify-contracts";

/**
 * The currencies a price may be written in, and the one conversion this
 * gateway does make.
 *
 * A card priced in dollars is charged in the network's own dollar-denominated
 * asset, one for one. That is a decision and not the absence of one, so it is
 * written here rather than left to be inferred from the fact that it works: a
 * merchant who writes "USD" is charging their buyer USDC on the configured
 * chain, and the two are held to be the same number of dollars.
 *
 * Everything else is refused. Nobody has decided where an exchange rate would
 * come from, and a charge based on an invented one would be the clearest
 * possible claim beyond the evidence.
 */
export const PAYABLE_CURRENCIES: ReadonlySet<string> = new Set(["USD", "USDC"]);

/**
 * What stands between this price and a sale, as findings on the fields of the
 * document that carried it — empty where nothing does.
 *
 * The paths name `price` because a card and a price answer both carry the
 * price under that name, so one finding reads right in either. An amount gets
 * at most one finding: zero is said before the missing cents, because "0"
 * written as "0.00" would only be refused again.
 */
export function priceProblemsOf(price: Money): Problem[] {
  const problems: Problem[] = [];
  const written = JSON.stringify(price.amount);

  if (!/[1-9]/.test(price.amount)) {
    problems.push({
      path: ["price", "amount"],
      code: "custom",
      message: `the price is ${written}, and a price of zero cannot be sold yet: a payment of nothing has not been proven to go through, so the price has to be above zero`,
    });
  } else if (!/\.\d{2,}$/.test(price.amount)) {
    problems.push({
      path: ["price", "amount"],
      code: "custom",
      message: `the price is ${written}, and a price is written in dollars with at least two digits after the dot — five dollars is "5.00" — so that an amount counted in cents is never charged as dollars`,
    });
  }

  if (!PAYABLE_CURRENCIES.has(price.currency)) {
    problems.push({
      path: ["price", "currency"],
      code: "custom",
      message: `the price is in ${JSON.stringify(price.currency)}, which this gateway cannot charge: it takes USD, paid as USDC one for one, or USDC itself, and holds no exchange rate to anything else`,
    });
  }

  return problems;
}

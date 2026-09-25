/**
 * What a price a merchant sets has to be before Agentify will sell at it.
 *
 * A price comes in by two doors: on a card, when it is published, and in the
 * answer to a price question, when a purchase is priced live. The gateway holds
 * both to the rule below, and the merchant SDK's own check of a card holds it
 * to the same rule, so a card the check passes is not refused at publication
 * for its price. Three parts, each standing for a payment that cannot be
 * taken.
 *
 * A price of zero is refused, by design. A payment request for nothing asks
 * for something that cannot be done, and a gateway that took free items would
 * be hosting content rather than selling it. A merchant gives a free item away
 * from their own site, with no payment request in front of it (ADR-0002 §2).
 *
 * A currency other than the dollar is refused, because there is no exchange
 * rate anywhere in this system to charge it at. The payment edge charges in the
 * same set, read from here, so a price the door took is a price the edge can
 * charge and the two cannot drift into two lists.
 *
 * An amount is written in dollars with at least two digits after the dot, so
 * that a merchant who counts in cents and writes "500" for five dollars is
 * refused rather than listed at five hundred. Fractions of a cent stay allowed:
 * a price per call is often below one. How many places a charge may carry is
 * the payment edge's own bound and is not repeated here.
 *
 * It is a rule applied at the doors rather than part of any schema, and that is
 * the point of it being a function. The schemas also read back every document
 * already written — every answer that carries a card is held to the contract
 * on its way out — so a rule written into the card's schema would turn the
 * whole list of a merchant who published such a price before the rule existed
 * into a failure, for cards they could otherwise see, pause and replace.
 */

import type { Money } from "./primitives.js";
import type { Problem } from "./results.js";

/**
 * The currencies a price may be written in, and the one conversion Agentify
 * makes.
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
export const PAYABLE_CURRENCIES: readonly string[] = Object.freeze(["USD", "USDC"]);

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
      message: `the price is ${written}, and nothing is sold through Agentify at a price of zero: a free item is offered from your own site, without a payment`,
    });
  } else if (!/\.\d{2,}$/.test(price.amount)) {
    problems.push({
      path: ["price", "amount"],
      code: "custom",
      message: `the price is ${written}, and a price is written in dollars with at least two digits after the dot — five dollars is "5.00" — so that an amount counted in cents is never charged as dollars`,
    });
  }

  if (!PAYABLE_CURRENCIES.includes(price.currency)) {
    problems.push({
      path: ["price", "currency"],
      code: "custom",
      message: `the price is in ${JSON.stringify(price.currency)}, which Agentify cannot charge: it takes USD, paid as USDC one for one, or USDC itself, and holds no exchange rate to anything else`,
    });
  }

  return problems;
}

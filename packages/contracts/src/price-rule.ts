/**
 * What a price a merchant sets has to be before Agentify will sell at it.
 *
 * A price comes in on a card when it is published and in the answer to a price
 * question when a purchase is priced live. The gateway holds both to this rule,
 * and the SDK's own check of a card holds it to the same rule, so a card the
 * check passes is not refused at publication for its price.
 *
 * This is a function applied where a price comes in rather than part of a
 * schema, because the schemas also read back documents already written, and a
 * rule in the card's schema would make a merchant's whole list unreadable over
 * one card published before the rule.
 */

import type { Money } from "./primitives.js";
import type { Problem } from "./results.js";

/**
 * The currencies a price may be written in. A card priced in "USD" is charged
 * in USDC on the configured chain, one for one. Every other currency is
 * refused: Agentify holds no exchange rate to charge it at. A shop connected
 * through the dashboard and priced in another currency has its prices
 * converted at its merchant's own rate before any of them reaches this rule.
 */
export const PAYABLE_CURRENCIES: readonly string[] = Object.freeze(["USD", "USDC"]);

/**
 * How many places after the dot a price may carry: the places of USDC, which is
 * what a buyer pays in. Its smallest unit is a millionth of a dollar, so
 * "0.000001" is the finest price there is an exact charge for.
 */
export const PAYABLE_DECIMALS = 6;

/**
 * What stands between this price and a sale, as findings under the path
 * `price` of the card or price answer that carried it; empty when nothing does.
 *
 * A price of zero is refused, since a free item is given away from the
 * merchant's own site, not sold. An amount needs at least two digits after the
 * dot, so that "500" meant as cents is never charged as five hundred dollars,
 * and at most `PAYABLE_DECIMALS`, past which there is no exact amount to
 * charge. A currency outside `PAYABLE_CURRENCIES` is refused. An amount gets at
 * most one finding. The amount is expected to have passed `AmountSchema`.
 */
export function priceProblemsOf(price: Money): Problem[] {
  const problems: Problem[] = [];
  const written = JSON.stringify(price.amount);
  const places = price.amount.split(".")[1]?.length ?? 0;

  if (!/[1-9]/.test(price.amount)) {
    problems.push({
      path: ["price", "amount"],
      code: "custom",
      message: `the price is ${written}, and nothing is sold through Agentify at a price of zero: a free item is offered from your own site, without a payment`,
    });
  } else if (places < 2) {
    problems.push({
      path: ["price", "amount"],
      code: "custom",
      message: `the price is ${written}, and a price is written in dollars with at least two digits after the dot — five dollars is "5.00" — so that an amount counted in cents is never charged as dollars`,
    });
  } else if (places > PAYABLE_DECIMALS) {
    problems.push({
      path: ["price", "amount"],
      code: "custom",
      message: `the price is ${written}, and a price carries at most ${PAYABLE_DECIMALS} digits after the dot, the finest amount USDC can be paid in, so there is no exact amount to charge for it`,
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

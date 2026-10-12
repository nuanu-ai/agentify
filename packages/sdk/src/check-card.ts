/**
 * The local check of a card: the contract's card schema and its price rule,
 * and nothing beside them, so a card it passes is not refused at publication
 * for its shape or its price.
 */

import { CardSchema, type Problem, priceProblemsOf } from "@nuanu-ai/agentify-contracts";
import { problemsOf } from "./schema.js";

export interface CardCheck {
  /**
   * Everything wrong with the card that one pass could see, under the same word
   * and in the same shape the publish call answers in. Empty means the card is
   * complete as far as the contract can tell.
   */
  readonly problems: readonly Problem[];
}

/**
 * Checks a card before it is published, without calling the gateway, and
 * returns every finding under `problems` in the shape the publish call refuses
 * with. It never throws.
 *
 * The card is checked in two stages: its shape first, then the rules between
 * fields and the price rule. The second stage runs only once the first
 * passes, so a card refused on its shape may have more findings behind the
 * ones it was given. Whether the gateway accepts the card is decided only by
 * publishing: the merchant's own settings, such as a seller name, are not
 * checked here.
 */
export const checkCard = (card: unknown): CardCheck => {
  const result = CardSchema.safeParse(card);

  return {
    problems: result.success ? priceProblemsOf(result.data.price) : problemsOf(result.error.issues),
  };
};

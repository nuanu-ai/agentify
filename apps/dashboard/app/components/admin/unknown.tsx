/**
 * Unknown, said as unknown. A part of the system the application cannot see
 * is "Not measured", with a dashed dot and the sentence on where the fact
 * lives, never a green dot; a figure whose read failed is "Could not be read",
 * never a zero, because "there are none" and "I do not know" send an operator
 * to opposite conclusions.
 */

import { COULD_NOT_BE_READ } from "../../../src/admin/words.js";
import { ORDER_WORDS, type Word as WordView } from "../../../src/words.js";
import { Word } from "../word.js";

export function CouldNotBeRead() {
  return <span className="badge badge-unknown">{COULD_NOT_BE_READ}</span>;
}

/**
 * An order's state as the merchant's dashboard words it, with the one unknown
 * among them, a payment whose outcome nobody has heard, drawn as every unknown
 * in the workspace is: dashed, not in the colour of a failure.
 */
export function OrderState({ word }: Readonly<{ word: WordView }>) {
  return word.text === ORDER_WORDS.payment_unresolved.text ? (
    <span className="badge badge-unknown">{word.text}</span>
  ) : (
    <Word word={word} />
  );
}

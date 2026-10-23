/**
 * Unknown, said as unknown. A part of the system the application cannot see
 * is "Not measured", with a dashed dot and the sentence on where the fact
 * lives, never a green dot; a figure whose read failed is "Could not be read",
 * never a zero, because "there are none" and "I do not know" send an operator
 * to opposite conclusions.
 */

import { COULD_NOT_BE_READ, NOT_MEASURED } from "../../../src/admin/words.js";

export function NotMeasured() {
  return <span className="badge badge-unknown">{NOT_MEASURED}</span>;
}

export function CouldNotBeRead() {
  return <span className="badge badge-unknown">{COULD_NOT_BE_READ}</span>;
}

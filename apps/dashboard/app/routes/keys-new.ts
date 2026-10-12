/**
 * An address in the keys section that draws nothing and leads to the list, so
 * opening it again, from history or a bookmark, never issues a key.
 */

import type { LoaderFunctionArgs } from "react-router";
import type { Outcome } from "../../src/page-services.js";
import { answer } from "../answer.js";
import { services } from "../services.js";

export function loader(asked: LoaderFunctionArgs) {
  const toTheList: Outcome<never> = {
    kind: "redirect",
    location: `${asked.context.get(services).base}/keys`,
  };
  return answer(toTheList, asked);
}

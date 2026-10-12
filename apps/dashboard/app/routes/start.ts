/**
 * The dashboard's own address, which draws nothing: a merchant's owner goes on
 * to their cards, anybody else to the control that makes a merchant.
 */

import type { LoaderFunctionArgs } from "react-router";
import { answer } from "../answer.js";
import { services, signedIn } from "../services.js";

export function loader(asked: LoaderFunctionArgs) {
  const { context } = asked;
  return answer(context.get(services).start.where(context.get(signedIn)), asked);
}

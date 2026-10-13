/**
 * Import: what came over from the shop, product by product, or the shop
 * screen saying why nothing was read.
 */

import { type ActionFunctionArgs, useActionData } from "react-router";
import { acted } from "../answer.js";
import { WooPage } from "../screens/woocommerce.js";
import { signedIn } from "../services.js";
import { WOOCOMMERCE, wooPagesIn } from "../woocommerce.js";

export const handle = WOOCOMMERCE;

export async function action(asked: ActionFunctionArgs) {
  const { context } = asked;
  return acted(() => wooPagesIn(context).importCatalogue(context.get(signedIn)), asked);
}

export default function Import() {
  return <WooPage view={useActionData<typeof action>()} />;
}

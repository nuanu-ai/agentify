/**
 * Import: what came over from the shop, product by product, or the shop
 * screen saying why nothing was read.
 */

import { type ActionFunctionArgs, useActionData } from "react-router";
import { acted, formOf } from "../answer.js";
import { WooPage } from "../screens/woocommerce.js";
import { signedIn } from "../services.js";
import { WOO_SHOP_PAGE, wooPagesIn } from "../woocommerce.js";

export const handle = WOO_SHOP_PAGE;

export async function action(asked: ActionFunctionArgs) {
  const { context } = asked;
  return acted(async () => {
    const value = (await formOf(asked.request)).get("checked_job");
    return wooPagesIn(context).importCatalogue(
      context.get(signedIn),
      typeof value === "string" ? value : null,
    );
  }, asked);
}

export default function Import() {
  return <WooPage view={useActionData<typeof action>()} />;
}

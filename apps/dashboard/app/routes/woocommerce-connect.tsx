/**
 * Connect: the merchant is sent to their shop to approve, or the shop screen
 * says why not.
 */

import { type ActionFunctionArgs, useActionData } from "react-router";
import { acted, formOf } from "../answer.js";
import { WooPage } from "../screens/woocommerce.js";
import { signedIn } from "../services.js";
import { WOOCOMMERCE, wooPagesIn } from "../woocommerce.js";

export const handle = WOOCOMMERCE;

export async function action(asked: ActionFunctionArgs) {
  const { request, context } = asked;
  return acted(
    async () => await wooPagesIn(context).connect(context.get(signedIn), await formOf(request)),
    asked,
  );
}

export default function Connect() {
  return <WooPage view={useActionData<typeof action>()} />;
}

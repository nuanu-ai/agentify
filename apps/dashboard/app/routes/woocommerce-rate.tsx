/**
 * Save rate: the rate a shop priced in another currency sells at, and the
 * import it runs again at it, or the shop screen saying why nothing was saved.
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
    async () =>
      await wooPagesIn(context).setRate(
        context.get(signedIn),
        await formOf(request),
        request.headers.get("cookie") ?? undefined,
      ),
    asked,
  );
}

export default function Rate() {
  return <WooPage view={useActionData<typeof action>()} />;
}

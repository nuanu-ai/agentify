/** Back to the merchant's own code, forgetting the shop's keys once that held. */

import { type ActionFunctionArgs, useActionData } from "react-router";
import { acted, formOf } from "../answer.js";
import { WooPage } from "../screens/woocommerce.js";
import { signedIn } from "../services.js";
import { WOOCOMMERCE, wooPagesIn } from "../woocommerce.js";

export const handle = WOOCOMMERCE;

export async function action(asked: ActionFunctionArgs) {
  const { request, context } = asked;
  return acted(
    async () => await wooPagesIn(context).disconnect(context.get(signedIn), await formOf(request)),
    asked,
  );
}

export default function Disconnect() {
  return <WooPage view={useActionData<typeof action>()} />;
}

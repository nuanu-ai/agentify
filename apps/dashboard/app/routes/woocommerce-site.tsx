import { type ActionFunctionArgs, useActionData } from "react-router";
import { acted } from "../answer.js";
import { WooPage } from "../screens/woocommerce.js";
import { signedIn } from "../services.js";
import { WOO_SHOP_PAGE, wooPagesIn } from "../woocommerce.js";

export const handle = WOO_SHOP_PAGE;

export async function action(asked: ActionFunctionArgs) {
  const { context } = asked;
  return acted(() => wooPagesIn(context).useShopSite(context.get(signedIn)), asked);
}

export default function Site() {
  return <WooPage view={useActionData<typeof action>()} />;
}

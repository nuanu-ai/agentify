import { type ActionFunctionArgs, useActionData } from "react-router";
import { acted } from "../answer.js";
import { WooPage } from "../screens/woocommerce.js";
import { signedIn } from "../services.js";
import { WOOCOMMERCE, wooPagesIn } from "../woocommerce.js";
export const handle = WOOCOMMERCE;
export async function action(asked: ActionFunctionArgs) {
  return acted(() => wooPagesIn(asked.context).checkCatalogue(asked.context.get(signedIn)), asked);
}
export default function Check() {
  return <WooPage view={useActionData<typeof action>()} />;
}

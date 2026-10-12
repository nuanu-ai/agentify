/**
 * The one control that makes a merchant, for a person signed in without one.
 * It stands under the gate and outside `merchant-only`, which sends here.
 */

import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  useActionData,
  useLoaderData,
} from "react-router";
import { answer, useChrome } from "../answer.js";
import { MerchantScreen } from "../screens/setup.js";
import { services, signedIn } from "../services.js";

export function loader(asked: LoaderFunctionArgs) {
  const { context } = asked;
  return answer(context.get(services).start.merchant(context.get(signedIn)), asked);
}

export async function action(asked: ActionFunctionArgs) {
  const { context } = asked;
  return answer(await context.get(services).start.openMerchant(context.get(signedIn)), asked);
}

export default function Merchant() {
  const loaded = useLoaderData<typeof loader>();
  // A press that did not make a merchant is answered with the page itself.
  const view = useActionData<typeof action>() ?? loaded;
  return <MerchantScreen chrome={useChrome()} view={view} />;
}

/**
 * Choosing the name buyers read, the last step of a new merchant's setup. A
 * refused name is answered with the page, the name given back to correct.
 */

import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  useActionData,
  useLoaderData,
} from "react-router";
import { acted, answer, formOf, useChrome } from "../answer.js";
import { ChooseNameScreen } from "../screens/setup.js";
import { services, signedIn } from "../services.js";

export function loader(asked: LoaderFunctionArgs) {
  return answer(asked.context.get(services).sellerName.page(), asked);
}

export async function action(asked: ActionFunctionArgs) {
  const { request, context } = asked;
  return acted(
    async () =>
      await context.get(services).sellerName.choose(context.get(signedIn), await formOf(request)),
    asked,
  );
}

export default function ChooseName() {
  const loaded = useLoaderData<typeof loader>();
  const view = useActionData<typeof action>() ?? loaded;
  return <ChooseNameScreen chrome={useChrome()} view={view} />;
}

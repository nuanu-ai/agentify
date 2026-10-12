/**
 * The page a mailed link lands on, and its press. The page holds a one-time
 * token, so it is sent with no script at all.
 */

import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  useActionData,
  useLoaderData,
} from "react-router";
import { answer, carried, formOf, useChrome } from "../answer.js";
import { OpenLinkScreen } from "../screens/sign-in.js";
import { services } from "../services.js";

export const handle = { script: false };

export const headers = carried;

export async function loader(asked: LoaderFunctionArgs) {
  const { request, url, context } = asked;
  return answer(
    await context
      .get(services)
      .signIn.landing(request.headers.get("cookie") ?? undefined, url.searchParams),
    asked,
  );
}

export async function action(asked: ActionFunctionArgs) {
  const { request, context } = asked;
  return answer(
    await context
      .get(services)
      .signIn.open(request.headers.get("cookie") ?? undefined, await formOf(request)),
    asked,
  );
}

export default function OpenLink() {
  const chrome = useChrome();
  const loaded = useLoaderData<typeof loader>();
  return <OpenLinkScreen chrome={chrome} view={useActionData<typeof action>() ?? loaded} />;
}

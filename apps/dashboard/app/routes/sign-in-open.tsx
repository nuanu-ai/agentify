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

export async function loader({ request, context }: LoaderFunctionArgs) {
  const pages = context.get(services);
  return answer(
    await pages.signIn.landing(
      request.headers.get("cookie") ?? undefined,
      new URL(request.url).searchParams,
    ),
    request,
    context,
  );
}

export async function action({ request, context }: ActionFunctionArgs) {
  const pages = context.get(services);
  return answer(
    await pages.signIn.open(request.headers.get("cookie") ?? undefined, await formOf(request)),
    request,
    context,
  );
}

export default function OpenLink() {
  const chrome = useChrome();
  const loaded = useLoaderData<typeof loader>();
  return <OpenLinkScreen chrome={chrome} view={useActionData<typeof action>() ?? loaded} />;
}

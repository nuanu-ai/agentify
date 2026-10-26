/**
 * Products' former address, which mails already sent and bookmarks still
 * carry. It leads there for good with the query it came with, so a link to a
 * search lands on that search; it stands in front of the gate because it
 * reads nothing, and the page it leads to asks for the sign-in itself. A form
 * posted here is sent on as it was posted.
 */

import { type LoaderFunctionArgs, redirect } from "react-router";

export function loader({ url }: LoaderFunctionArgs) {
  return redirect(`/products${url.search}`, 308);
}

export const action = loader;

/**
 * The pages about a merchant's selling. A person signed in without a merchant
 * reaches none of them and is sent to the one screen that makes one.
 */

import {
  type LoaderFunctionArgs,
  type MiddlewareFunction,
  Outlet,
  redirectDocument,
  type ShouldRevalidateFunction,
} from "react-router";
import { services, signedIn } from "../services.js";

export const middleware: MiddlewareFunction<Response>[] = [
  ({ context }, next) => {
    if (context.get(signedIn).merchant === null) {
      // Sent as it is, prefix and all, as the gate's redirects are.
      throw redirectDocument(`${context.get(services).base}/merchant`, 303);
    }
    return next();
  },
];

/**
 * The banner the frame draws over every one of these pages, about the
 * merchant's account. Read by this layout, React Router asks for it beside the
 * page's own data in the same request, never after it; the read has a short
 * deadline of its own, so it cannot hold a page longer than that.
 */
export async function loader({ context }: LoaderFunctionArgs) {
  return await context.get(services).screens.frame(context.get(signedIn));
}

/**
 * Read again on every move between pages, since a setting can change at any
 * moment; after a press, as React Router would.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formMethod,
  defaultShouldRevalidate,
}) => formMethod === undefined || defaultShouldRevalidate;

export default function MerchantOnly() {
  return <Outlet />;
}

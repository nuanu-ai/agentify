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
 * What the frame draws over every one of these pages: the count of orders that
 * need the merchant and the banner about their account. Read by this layout,
 * React Router asks for it beside the page's own data in the same request,
 * never after it; its reads have a short deadline of their own, so they cannot
 * hold a page longer than that.
 */
export async function loader({ context }: LoaderFunctionArgs) {
  return await context.get(services).screens.frame(context.get(signedIn));
}

/**
 * Read again on every move between pages, since an order can fall due and a
 * setting change at any moment; after a press, as React Router would.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formMethod,
  defaultShouldRevalidate,
}) => formMethod === undefined || defaultShouldRevalidate;

export default function MerchantOnly() {
  return <Outlet />;
}

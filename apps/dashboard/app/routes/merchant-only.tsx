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
 * The count of orders that need the merchant, for the frame's sidebar. Read by
 * this layout, it is asked for beside the page's own data in the same request,
 * never after it; handed over unawaited, so a page that only sends the browser
 * on does not wait for it, and a move between pages draws before it arrives.
 */
export function loader({ context }: LoaderFunctionArgs) {
  return { needYou: context.get(services).screens.needYou(context.get(signedIn)) };
}

/**
 * Read again on every move between pages, since an order can fall due at any
 * moment; after a press, as React Router would.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formMethod,
  defaultShouldRevalidate,
}) => formMethod === undefined || defaultShouldRevalidate;

export default function MerchantOnly() {
  return <Outlet />;
}

/**
 * The pages about a merchant's selling. A person signed in without a merchant
 * reaches none of them and is sent to the one screen that makes one.
 */

import { type MiddlewareFunction, Outlet, redirectDocument } from "react-router";
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

export default function MerchantOnly() {
  return <Outlet />;
}

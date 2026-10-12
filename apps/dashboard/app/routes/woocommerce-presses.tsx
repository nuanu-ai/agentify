/**
 * The addresses the shop screen's forms post to. With script, the answer to a
 * press is drawn at the press's address, so a reload reads that address; a
 * person's read of it is sent to the shop screen, where the forms are. The
 * data React Router reads after a press, at the same address with `.data` on
 * the end, goes through.
 */

import { type MiddlewareFunction, Outlet, redirectDocument } from "react-router";
import { services } from "../services.js";

export const middleware: MiddlewareFunction<Response>[] = [
  ({ request, url, context }, next) => {
    const reading = request.method === "GET" || request.method === "HEAD";
    if (reading && new URL(request.url).pathname === url.pathname) {
      // Sent as it is, prefix and all, as the gate's redirects are.
      throw redirectDocument(`${context.get(services).base}/woocommerce`, 303);
    }
    return next();
  },
];

export default function Presses() {
  return <Outlet />;
}

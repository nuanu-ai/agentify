/**
 * A press on the settings page posts to an address of its own and answers with
 * a redirect, a problem, or the page read after its work. React Router then
 * runs the loaders at that address, and the one that draws the page draws the
 * press's read rather than reading again, so a read that fails is the press's
 * failure and the gateway is asked once.
 */

import { createContext, type MiddlewareFunction, redirectDocument } from "react-router";
import type { Outcome } from "../src/page-services.js";
import type { SettingsView } from "../src/settings-view.js";
import { type Asked, acted } from "./answer.js";
import { services } from "./services.js";

export const pressed = createContext<SettingsView | null>(null);

/**
 * A read of a press's own address, from history or the address bar, leads to
 * the settings: drawn there without a press, the page would say nothing
 * happened. The data the page drawn there asks for goes through.
 */
export const readsLeadToSettings: MiddlewareFunction<Response>[] = [
  ({ request, url, context }, next) => {
    const reading = request.method === "GET" || request.method === "HEAD";
    if (reading && new URL(request.url).pathname === url.pathname) {
      throw redirectDocument(`${context.get(services).base}/settings`, 303);
    }
    return next();
  },
];

export function press(work: () => Promise<Outcome<SettingsView>>, asked: Asked) {
  return acted(async () => {
    const outcome = await work();
    if (outcome.kind === "view") asked.context.set(pressed, outcome.view);
    return outcome;
  }, asked);
}

/**
 * A press on the settings page posts to an address of its own and answers with
 * a redirect, a problem, or the page read after its work. React Router then
 * runs the loader of every route at that address, the page's among them, and
 * that loader draws the press's read rather than reading again, so a read that
 * fails is the press's failure and the gateway is asked once.
 */

import { createContext } from "react-router";
import type { Outcome } from "../src/page-services.js";
import type { SettingsView } from "../src/settings-view.js";
import { type Asked, answer } from "./answer.js";

export const pressed = createContext<SettingsView | null>(null);

export function press(outcome: Outcome<SettingsView>, asked: Asked) {
  if (outcome.kind === "view") asked.context.set(pressed, outcome.view);
  return answer(outcome, asked);
}

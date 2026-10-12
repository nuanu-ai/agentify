/**
 * The server half of the React pages: what their loaders, actions and gate
 * call. A call takes what the request carried and answers with an `Outcome` —
 * a view to draw, a place to send the browser, or a problem to show — never
 * with a response, so the pages decide nothing a test of this module cannot
 * see. The pages import only the types from here: the build that runs in the
 * browser carries none of this, and the build that runs on the server is handed
 * it by the process that mounts it.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS, type SurfaceMode } from "@agentify/core";
import type { DashboardConfig } from "./config.js";
import type { DashboardIdentity } from "./dashboard-entry.js";
import { type Gate, gateFor } from "./gate.js";

/** A view to draw, a place to send the browser, or a problem to show instead. */
export type Outcome<View> =
  | Readonly<{
      kind: "view";
      view: View;
      status?: number;
      headers?: Readonly<Record<string, string>>;
      setCookies?: readonly string[];
    }>
  | Readonly<{
      kind: "redirect";
      /** A path on this site, the dashboard's prefix included where it is the dashboard's. */
      location: string;
      headers?: Readonly<Record<string, string>>;
      setCookies?: readonly string[];
    }>
  | Readonly<{ kind: "problem"; problem: Problem }>;

/**
 * A page that could not be drawn or a form that was not done. The page itself
 * adds the way back: its own address where a page failed, so the merchant
 * keeps their place, and the first screen where a form did.
 */
export interface Problem {
  readonly status: number;
  readonly said: string;
}

/** Which stack this is, said on every page; nothing is said on the live one. */
export interface Surface {
  readonly attribute: string;
  readonly mode: SurfaceMode;
  readonly words: string | null;
}

export interface PageServices {
  /** "" when mounted at the root of its origin. */
  readonly base: string;
  readonly surface: Surface;
  readonly gate: Gate;
}

export interface PageParts {
  readonly identity: DashboardIdentity;
}

export function pageServicesFor(config: DashboardConfig, parts: PageParts): PageServices {
  return {
    base: config.basePath,
    surface: {
      attribute: SURFACE_MARKER_ATTRIBUTE,
      mode: config.surfaceMode,
      words: SURFACE_WORDS[config.surfaceMode],
    },
    gate: gateFor(config.basePath, parts.identity, config.cookieSecure),
  };
}

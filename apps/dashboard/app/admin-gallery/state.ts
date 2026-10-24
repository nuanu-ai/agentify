/**
 * A state of a page of the operator's workspace, as an area's gallery file
 * describes it: its words, its address and channel, and the data its loaders
 * or press would have answered. `gallery.tsx` draws it through the dashboard's
 * own route tree, with the workspace's frame read for the channel unless the
 * state gives one. The example data is the area's own, built by its real view
 * functions; never a real merchant's.
 */

import type { SurfaceMode } from "@agentify/core";
import type { HydrationState } from "react-router";
import type { AdminFrameView } from "../../src/admin/frame.js";

export interface AdminGalleryState {
  /** Lowercase, starting `dashboard-admin-`. */
  readonly id: string;
  /** The screen as an operator calls it; every state of one screen says it the same way. */
  readonly screen: string;
  /** One sentence: when an operator sees this. */
  readonly when: string;
  /** One sentence: what in the system causes it. */
  readonly cause: string;
  /** Under the dashboard's prefix, query and all, such as `/admin/merchants`. */
  readonly path: string;
  readonly mode: SurfaceMode;
  /** The frame's channel and counts; the channel's own with no counts where absent. */
  readonly frame?: AdminFrameView;
  /** Each route's loader data by route id, such as `routes/admin/merchants`. */
  readonly loaded?: HydrationState["loaderData"];
  readonly pressed?: HydrationState["actionData"];
  readonly failed?: HydrationState["errors"];
}

const CHANNELS: Readonly<Record<SurfaceMode, AdminFrameView["channel"]>> = {
  live: { mode: "live", name: "Live channel", line: "agentify.ad · Base" },
  test: { mode: "test", name: "Test channel", line: "test.agentify.ad · Base Sepolia" },
  sandbox: { mode: "sandbox", name: "Sandbox", line: "localhost:8080 · no chain" },
};

/** The frame of a channel with nothing waiting in any section. */
export const frameIn = (mode: SurfaceMode): AdminFrameView => ({
  channel: CHANNELS[mode],
  counts: {},
});

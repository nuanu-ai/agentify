/**
 * A state of a page of the operator's workspace, as an area's gallery file
 * describes it: its words, its address and channel, and the data its loaders
 * or press would have answered. `gallery.tsx` draws it through the dashboard's
 * own route tree, with the workspace's frame read for the channel unless the
 * state gives one. The example data is the area's own, built by its real view
 * functions; never a real merchant's.
 */

import type { SurfaceMode } from "@agentify/core";
import { CHANNEL_NAMES, type SectionCounts } from "@agentify/ui/workspace-view";
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
  live: { mode: "live", name: CHANNEL_NAMES.live },
  test: { mode: "test", name: CHANNEL_NAMES.test },
  sandbox: { mode: "sandbox", name: CHANNEL_NAMES.sandbox },
};

/**
 * What waits on the live channel of the examples: the merchant who waits for
 * admission, the two payments whose outcome is unknown and the analytics
 * events given up, as the overview's example has them.
 */
export const LIVE_WAITING: SectionCounts = {
  merchants: { count: 1, needsYou: true },
  orders: { count: 2, needsYou: false },
  health: { count: 1, needsYou: false },
};

/**
 * The frame of a channel: on the live channel with what waits there, unless
 * a state says otherwise, such as one where nothing waits or nothing could be
 * read; on the others with nothing waiting.
 */
export const frameIn = (
  mode: SurfaceMode,
  counts: SectionCounts = mode === "live" ? LIVE_WAITING : {},
): AdminFrameView => ({
  channel: CHANNELS[mode],
  counts,
});

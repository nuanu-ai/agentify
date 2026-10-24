/**
 * The workspace's gallery states, one file an area, put together for
 * `gallery.tsx`; an area adds its states in its own file and nothing here.
 */

import { ACCOUNTS_STATES } from "./accounts.js";
import { FIGURES_STATES } from "./figures.js";
import { MERCHANTS_STATES } from "./merchants.js";
import { ORDERS_STATES } from "./orders.js";
import type { AdminGalleryState } from "./state.js";
import { WORKSPACE_STATES } from "./workspace.js";

export { type AdminGalleryState, frameIn } from "./state.js";

export const ADMIN_STATES: readonly AdminGalleryState[] = [
  ...WORKSPACE_STATES,
  ...FIGURES_STATES,
  ...MERCHANTS_STATES,
  ...ORDERS_STATES,
  ...ACCOUNTS_STATES,
];

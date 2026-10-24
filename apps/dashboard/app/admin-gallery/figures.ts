/** The figures area's gallery states. Owned by the figures area. */

import type { AdminGalleryState } from "./state.js";

export const FIGURES_STATES: readonly AdminGalleryState[] = [
  {
    id: "dashboard-admin-overview",
    screen: "Overview",
    when: "An operator opens the workspace before the overview is built.",
    cause: "The overview is not built yet, so its placeholder is drawn in the frame.",
    path: "/admin",
    mode: "live",
    loaded: { "routes/admin/index": { section: "overview" } },
  },
  {
    id: "dashboard-admin-money",
    screen: "Money",
    when: "An operator opens Money before the section is built.",
    cause: "The section's screen is not built yet, so its placeholder is drawn in the frame.",
    path: "/admin/money",
    mode: "live",
    loaded: { "routes/admin/money": { section: "money" } },
  },
  {
    id: "dashboard-admin-health",
    screen: "Health",
    when: "An operator opens Health before the section is built.",
    cause: "The section's screen is not built yet, so its placeholder is drawn in the frame.",
    path: "/admin/health",
    mode: "test",
    loaded: { "routes/admin/health": { section: "health" } },
  },
];

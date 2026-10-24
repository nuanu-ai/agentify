/** The merchants area's gallery states. Owned by the merchants area. */

import type { AdminGalleryState } from "./state.js";

export const MERCHANTS_STATES: readonly AdminGalleryState[] = [
  {
    id: "dashboard-admin-merchants",
    screen: "Merchants",
    when: "An operator opens Merchants before the section is built.",
    cause: "The section's screen is not built yet, so its placeholder is drawn in the frame.",
    path: "/admin/merchants",
    mode: "live",
    loaded: { "routes/admin/merchants": { section: "merchants" } },
  },
  {
    id: "dashboard-admin-merchant",
    screen: "Merchant",
    when: "An operator opens one merchant before the page is built.",
    cause: "The merchant's page is not built yet, so its placeholder is drawn in the frame.",
    path: "/admin/merchants/mch_78f0c3eaf1edb0c9086a6d2ae1731c28",
    mode: "live",
    loaded: { "routes/admin/merchant": { section: "merchants" } },
  },
];

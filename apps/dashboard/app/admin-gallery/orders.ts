/** The orders area's gallery states. Owned by the orders area. */

import type { AdminGalleryState } from "./state.js";

export const ORDERS_STATES: readonly AdminGalleryState[] = [
  {
    id: "dashboard-admin-orders",
    screen: "Orders",
    when: "An operator opens Orders before the section is built.",
    cause: "The section's screen is not built yet, so its placeholder is drawn in the frame.",
    path: "/admin/orders",
    mode: "live",
    loaded: { "routes/admin/orders": { section: "orders" } },
  },
  {
    id: "dashboard-admin-order",
    screen: "Order",
    when: "An operator opens one order before the page is built.",
    cause: "The order's page is not built yet, so its placeholder is drawn in the frame.",
    path: "/admin/orders/ord_8c2e3b7a91d04f6e8a5c2d1b0e9f41a9",
    mode: "live",
    loaded: { "routes/admin/order": { section: "orders" } },
  },
  {
    id: "dashboard-admin-find",
    screen: "Find a record",
    when: "An operator pastes something into the lookup before it is built.",
    cause: "The lookup is not built yet, so its placeholder is drawn in the frame.",
    path: "/admin/find?q=ord_8c2e",
    mode: "live",
    loaded: { "routes/admin/find": { section: "orders" } },
  },
];

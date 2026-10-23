/** The accounts area's gallery states, the Journal's among them. Owned by the accounts area. */

import type { AdminGalleryState } from "./state.js";

export const ACCOUNTS_STATES: readonly AdminGalleryState[] = [
  {
    id: "dashboard-admin-accounts",
    screen: "Accounts",
    when: "An operator opens Accounts before the section is built.",
    cause: "The section's screen is not built yet, so its placeholder is drawn in the frame.",
    path: "/admin/accounts",
    mode: "live",
    loaded: { "routes/admin/accounts": { section: "accounts" } },
  },
  {
    id: "dashboard-admin-account",
    screen: "Account",
    when: "An operator opens one account before the page is built.",
    cause: "The account's page is not built yet, so its placeholder is drawn in the frame.",
    path: "/admin/accounts/Xq9fT2mLwP4kR7sV1bN8",
    mode: "live",
    loaded: { "routes/admin/account": { section: "accounts" } },
  },
  {
    id: "dashboard-admin-journal",
    screen: "Journal",
    when: "An operator opens the Journal before the section is built.",
    cause: "The section's screen is not built yet, so its placeholder is drawn in the frame.",
    path: "/admin/journal",
    mode: "live",
    loaded: { "routes/admin/journal": { section: "journal" } },
  },
];

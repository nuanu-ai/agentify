/**
 * Where a sign-in may return a person: the closed list of the dashboard's
 * sections and of the operator's workspace's pages. A destination travels in
 * a query, a form and a mailed link's stored claim, so anything outside the
 * list must lead to the start rather than to a path a stranger chose.
 */

import { describe, expect, it } from "vitest";
import { adminDestinationIn, dashboardDestinationIn } from "./dashboard-entry.js";

describe("where a sign-in returns to", () => {
  it("returns to every page of the operator's workspace, a record by its identifier", () => {
    const pages = [
      "admin",
      "admin/merchants",
      "admin/merchants/mch_78f0c3eaf1edb0c9086a6d2ae1731c28",
      "admin/orders",
      "admin/orders/ord_8c2e41a9",
      "admin/money",
      "admin/health",
      "admin/accounts",
      "admin/accounts/Xq9-account_1",
      "admin/journal",
    ];

    for (const page of pages) {
      expect(adminDestinationIn(page), page).toBe(page);
      expect(dashboardDestinationIn(page), page).toBe(page);
    }
  });

  it("leads to the start for anything else, however close to a page it looks", () => {
    const astray = [
      "admin/",
      "admin/find",
      "admin/live-sales",
      "admin/money/mch_1",
      "admin/merchants/",
      "admin/merchants/mch_1/withdraw",
      "admin/merchants/../settings",
      "admin/merchants/mch_1?next=//evil.example",
      "admin/merchants/<script>",
      `admin/orders/${"o".repeat(65)}`,
      "/admin",
      "//evil.example/admin",
      "https://evil.example/admin",
      "Admin",
      "admin\n",
      ["admin"],
      null,
    ];

    for (const value of astray) {
      expect(adminDestinationIn(value), JSON.stringify(value)).toBeNull();
      expect(dashboardDestinationIn(value), JSON.stringify(value)).toBe("default");
    }
  });

  it("still returns to the merchant's own sections", () => {
    expect(dashboardDestinationIn("orders")).toBe("orders");
    expect(dashboardDestinationIn("keys")).toBe("keys");
    expect(adminDestinationIn("orders")).toBeNull();
  });
});

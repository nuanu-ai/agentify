/**
 * What the workspace's server halves are built from. Only `src/server.ts`
 * builds these, and only for the admin services: the operator's reader reads
 * every merchant's rows, and nothing else in the dashboard is handed it.
 */

import type { Gateway } from "@agentify/gateway";
import type { OperatorReader } from "@agentify/gateway/operator";
import type { DashboardConfig } from "../config.js";
import type { DashboardIdentity } from "../dashboard-entry.js";
import type { Pressing } from "./action.js";
import type { DashboardJournal } from "./journal.js";

export interface AdminParts {
  readonly config: DashboardConfig;
  readonly identity: DashboardIdentity;
  /** The gateway's application, whose store takes a gateway action's journal row. */
  readonly gateway: Gateway;
  /** Every read that crosses merchants. */
  readonly reader: OperatorReader;
  /** Where a dashboard action writes its change and its row together. */
  readonly journal: DashboardJournal;
  /** What every press goes through first (`pressed` in `action.ts`). */
  readonly pressing: Pressing;
  readonly now: () => Date;
  /**
   * Each connected WooCommerce shop's site and the account that connected it,
   * on a channel that offers shops, and null on one that does not. Never the
   * shop's keys: nothing here hands them out.
   */
  readonly shopSites: (() => Promise<readonly ShopSite[]>) | null;
}

export interface ShopSite {
  readonly accountId: string;
  /** Without a trailing slash, as it was checked at Connect. */
  readonly shopUrl: string;
}

/**
 * What the workspace's server halves are built from. Only `src/server.ts`
 * builds these, and only for the admin services: the operator's reader reads
 * every merchant's rows, and nothing else in the dashboard is handed it.
 */

import type { Gateway } from "@agentify/gateway";
import type { OperatorReader } from "@agentify/gateway/operator";
import type { DashboardConfig } from "../config.js";
import type { DashboardIdentity } from "../dashboard-entry.js";
import type { WooShops } from "../woo-shops.js";
import type { AccountsDirectory } from "./accounts.js";
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
  /** The accounts as an operator reads and changes them. */
  readonly accounts: AccountsDirectory;
  /** What every press goes through first (`pressed` in `action.ts`). */
  readonly pressing: Pressing;
  readonly now: () => Date;
  /** The connected WooCommerce shops, or null where this deployment offers no connector. */
  readonly shops: WooShops | null;
}

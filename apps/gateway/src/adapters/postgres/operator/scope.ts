/** What every area's Postgres reads are built over. */

import type { ReadOnly } from "./read-only.js";

export interface OperatorScope {
  /** Runs one read inside a read-only transaction with a bounded statement time. */
  readonly read: ReadOnly;
  /**
   * The deployment's network: a wallet's split is the one recorded on it, and
   * a registry row of another network is never read as one.
   */
  readonly network: string;
}

/**
 * A minute has to pass between two links to one address. A test about something
 * further down the flow needs the second link without waiting: moving every
 * send back by the interval keeps the sends inside the rolling hour, so the
 * hourly limit still counts them. Tests of the limits themselves do not use
 * this.
 */

import { LINK_MIN_INTERVAL_MS } from "../identity.js";

export const rewindLinkSends = (
  rows: Record<string, Record<string, unknown>[]>,
  by: number = LINK_MIN_INTERVAL_MS,
): void => {
  for (const row of rows.dashboard_link_sends ?? []) {
    row.sentAt = new Date(new Date(row.sentAt as Date).getTime() - by);
  }
};

/** The one client asking, for a test that is not about which client asked. */
export const ONE_CLIENT = { client: "192.0.2.10" } as const;

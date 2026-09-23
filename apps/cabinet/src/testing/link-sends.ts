/**
 * The clock a test moves when it needs two links for one address.
 *
 * A minute has to pass between two links to the same address, which is a rule
 * about time and nothing else. A test that is about something further down the
 * flow — a token, a session, a command that counts sessions — needs the second
 * link without waiting a real minute for it, and the rows the memory store
 * keeps are the only clock it can reach. Moving every send back by the
 * interval puts the address back where it was before the last link went out,
 * and leaves it inside the rolling hour, so the three-an-hour wall keeps
 * counting the links that were actually sent.
 *
 * The tests about the walls themselves do not use this: they ask twice and
 * read the answer.
 */

import { LINK_MIN_INTERVAL_MS } from "../identity.js";

export const rewindLinkSends = (
  rows: Record<string, Record<string, unknown>[]>,
  by: number = LINK_MIN_INTERVAL_MS,
): void => {
  for (const row of rows.cabinet_link_sends ?? []) {
    row.sentAt = new Date(new Date(row.sentAt as Date).getTime() - by);
  }
};

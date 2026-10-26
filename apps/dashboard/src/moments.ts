/**
 * Moments as the dashboard's pages write them: in the zone of the person the
 * page is drawn for, named beside every moment, or in UTC, said as UTC, where
 * their browser has not named a zone. To the second, because receipts are
 * reconciled against a wallet and two payments a few seconds apart must not
 * look like one line twice.
 *
 * The zone is held for the request rather than passed down, because moments
 * are written in dozens of views that know nothing else of the request. A
 * moment written outside one, as a background job or a mail writes it, is in
 * UTC; one written in the wrong zone would still name the zone it is in.
 * Mail goes to people a page was not drawn for, so it writes `momentInUtc`.
 */

import { clockIn, dayIn, momentIn } from "@agentify/ui/zone";

// Asked of the process rather than imported: the views that write moments are
// also bundled for the browser, for the words and types its components share,
// and a browser has no such module. No moment is written there.
const hooks = globalThis.process?.getBuiltinModule?.("node:async_hooks");
const viewersZone = hooks === undefined ? null : new hooks.AsyncLocalStorage<string | null>();

/** Runs `draw` with every moment it writes in `zone`; null is a viewer whose zone is not known. */
export const inViewersZone = <T>(zone: string | null, draw: () => T): T =>
  viewersZone === null ? draw() : viewersZone.run(zone, draw);

const zoneHere = (): string | null => viewersZone?.getStore() ?? null;

// A timestamp that cannot be read is shown raw: it is what we were told, and
// an invented date would put a moment on a receipt that nothing stands behind.
const written = (iso: string, zone: string | null): string => {
  const parts = momentIn(new Date(iso), zone);
  return parts === null ? iso : `${parts.date} ${parts.time} ${parts.zone}`;
};

/** "2026-10-27 04:03:12 UTC+8", in the zone of the page's viewer. */
export const moment = (iso: string): string => written(iso, zoneHere());

/** "2026-10-26 20:03:12 UTC", whoever the page being drawn is for. */
export const momentInUtc = (iso: string): string => written(iso, null);

/** "04:03 UTC+8": the hour and minute of a moment, in the zone of the page's viewer. */
export const clockOf = (at: number): string => clockIn(new Date(at), zoneHere()) ?? "—";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const dayWritten = (day: { year: number; month: number; day: number }): string =>
  `${day.day} ${MONTHS[day.month - 1]} ${day.year}`;

/** The day a moment falls on in the viewer's calendar, written out: "27 October 2026". */
export const dayOf = (iso: string): string => {
  const day = dayIn(new Date(iso), zoneHere());
  return day === null ? iso : dayWritten(day);
};

/** The UTC day of a moment, for what is counted by UTC day whoever reads it. */
export const dayOfUtc = (iso: string): string => {
  const day = dayIn(new Date(iso), null);
  return day === null ? iso : dayWritten(day);
};

/**
 * A moment as a row under a heading for its day: the heading names the day in
 * the viewer's calendar and the zone, "27 October 2026 · UTC+8", and the row
 * keeps the time to the second. A zone's offset changes within a day only at a
 * clock change, where the rows after it fall under a heading of their own.
 */
export const withinDay = (iso: string): { day: string; time: string } => {
  const parts = momentIn(new Date(iso), zoneHere());
  const day = dayIn(new Date(iso), zoneHere());
  return parts === null || day === null
    ? { day: iso, time: iso }
    : { day: `${dayWritten(day)} · ${parts.zone}`, time: parts.time };
};

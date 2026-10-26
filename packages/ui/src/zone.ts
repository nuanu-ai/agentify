/**
 * Moments as a person reads them on a page: in the time zone their browser
 * names, with that zone written beside every moment, and in UTC, said as UTC,
 * where no zone is known. The browser names its zone in a cookie the server
 * reads, so a page is drawn once, on the server, in the zone the browser
 * named before it, with nothing rewritten after it is shown. It imports
 * nothing and touches no browser, so a server process can take it; the
 * browser's half is `remember-zone.ts`.
 */

/** The cookie a browser names its time zone in, read by every page of the origin. */
export const ZONE_COOKIE = "agentify_zone";

/** Longer than any zone name the time zone database holds. */
const LONGEST_ZONE = 64;

/**
 * A name as the time zone database writes one, "UTC", "Asia/Makassar" or
 * "Etc/GMT-8", never a bare offset: the runtime would take any of thousands
 * of offsets, and each would keep a clock face for the life of the process.
 */
const DATABASE_NAME = /^[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * Clock faces by the zone's name in lower case, as the runtime reads a name
 * whatever its case, so the map holds at most one per zone the runtime knows.
 */
const formats = new Map<string, Intl.DateTimeFormat>();

/** The runtime's clock face for `zone`, or null where it knows no such zone. */
const formatFor = (zone: string): Intl.DateTimeFormat | null => {
  if (!DATABASE_NAME.test(zone)) return null;
  const key = zone.toLowerCase();
  const known = formats.get(key);
  if (known !== undefined) return known;
  try {
    const format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(key, format);
    return format;
  } catch {
    return null;
  }
};

/**
 * The zone named in a Cookie header, in the runtime's spelling of it, or null
 * where none is named or the runtime knows no zone by that name.
 */
export function zoneIn(cookie: string | null | undefined): string | null {
  const named = (cookie ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${ZONE_COOKIE}=`))
    ?.slice(ZONE_COOKIE.length + 1);
  if (named === undefined || named === "" || named.length > LONGEST_ZONE * 3) return null;
  let zone: string;
  try {
    zone = decodeURIComponent(named);
  } catch {
    return null;
  }
  if (zone.length > LONGEST_ZONE) return null;
  return formatFor(zone)?.resolvedOptions().timeZone ?? null;
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** Minutes ahead of UTC at that moment. */
  readonly offset: number;
}

const wallClock = (at: Date, zone: string | null): WallClock | null => {
  const ms = at.getTime();
  if (Number.isNaN(ms)) return null;
  const format = zone === null ? null : formatFor(zone);
  if (format === null) {
    return {
      year: at.getUTCFullYear(),
      month: at.getUTCMonth() + 1,
      day: at.getUTCDate(),
      hour: at.getUTCHours(),
      minute: at.getUTCMinutes(),
      second: at.getUTCSeconds(),
      offset: 0,
    };
  }
  const part = Object.fromEntries(
    format.formatToParts(at).map(({ type, value }) => [type, Number(value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  // The offset is what the wall clock reads minus the instant itself, so it is
  // the one in force at that moment, summer time included.
  const read = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
  return { ...part, offset: Math.round((read - Math.floor(ms / 1000) * 1000) / 60_000) };
};

const two = (n: number): string => String(n).padStart(2, "0");

/** "UTC", "UTC+8", "UTC-3", "UTC+5:45": short, and exact for the moment it is written beside. */
const offsetName = (offset: number): string => {
  if (offset === 0) return "UTC";
  const whole = Math.abs(offset);
  const minutes = whole % 60;
  return `UTC${offset > 0 ? "+" : "-"}${Math.floor(whole / 60)}${minutes === 0 ? "" : `:${two(minutes)}`}`;
};

/**
 * An instant to the second in `zone`, or in UTC where `zone` is null: its
 * date, its time of day, and the zone's offset at that moment, which is to be
 * written wherever the time is, so the reader never guesses the zone and a
 * copied moment is exact. Null where the instant cannot be read.
 */
export function momentIn(
  at: Date,
  zone: string | null,
): { date: string; time: string; zone: string } | null {
  const clock = wallClock(at, zone);
  if (clock === null) return null;
  return {
    date: `${clock.year}-${two(clock.month)}-${two(clock.day)}`,
    time: `${two(clock.hour)}:${two(clock.minute)}:${two(clock.second)}`,
    zone: offsetName(clock.offset),
  };
}

/** The hour and minute of an instant in `zone` with the zone named: "22:03 UTC+8". */
export function clockIn(at: Date, zone: string | null): string | null {
  const clock = wallClock(at, zone);
  return clock === null
    ? null
    : `${two(clock.hour)}:${two(clock.minute)} ${offsetName(clock.offset)}`;
}

/** The calendar day an instant falls on in `zone`, or in UTC where `zone` is null; month 1 is January. */
export function dayIn(
  at: Date,
  zone: string | null,
): { year: number; month: number; day: number } | null {
  const clock = wallClock(at, zone);
  return clock === null ? null : { year: clock.year, month: clock.month, day: clock.day };
}

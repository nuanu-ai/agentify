import { createUuidV7, type DatabaseTransaction } from "@agentify/scanner-database";
import { sql } from "drizzle-orm";

import { getDatabase } from "./database";

export type RateKind =
  | "scan_ip_hour"
  | "scan_target_day"
  | "registration_email_hour"
  | "registration_session_hour"
  | "recovery_email_hour"
  | "recovery_ip_hour"
  | "merchant_ip_hour"
  | "merchant_email_hour";

type AtomicRateEntry = Readonly<{
  keyHash: string;
  kind: RateKind;
  limit: number;
}>;

type LockedRateEntry = Readonly<{
  entry: AtomicRateEntry;
  count: number;
  windowStart?: Date;
  expiresAt: Date;
  /** When this entry would let one more request through; set once it is full. */
  retryAt?: Date;
}>;

/**
 * A refusal carries the moment the window frees and the wall that set it,
 * because the doors in front of it have to tell a person how long they are
 * actually waiting and, where they can see the wall, why.
 *
 * What was allowed carries a receipt per rolling wall it spent, so a caller
 * that turns out not to have used what it took can give that one back.
 */
export type SpentRateEvent = Readonly<{ kind: RateKind; eventId: string }>;

export type RateLimitOutcome =
  | Readonly<{ allowed: true; spent: readonly SpentRateEvent[] }>
  | Readonly<{ allowed: false; retryAt: Date; wall: RateKind }>;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function usesRollingWindow(kind: RateKind): boolean {
  return kind.endsWith("_hour");
}

export function rateWindowStart(kind: RateKind, now = new Date()): Date {
  const value = new Date(now);
  if (kind.endsWith("_day")) value.setUTCHours(0, 0, 0, 0);
  else value.setUTCMinutes(0, 0, 0);
  return value;
}

async function lockRollingRate(
  tx: DatabaseTransaction,
  entry: AtomicRateEntry,
  now: Date,
): Promise<LockedRateEntry> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${entry.kind}:${entry.keyHash}`}, 0))`,
  );
  const cutoff = new Date(now.getTime() - HOUR_MS);
  // Requests can acquire the lock out of timestamp order. Count every committed
  // event after the cutoff, including requests that overtook this one.
  const result = await tx.execute<{ count: number }>(sql`
    select count(*)::int as count
    from rate_limit_events
    where key_hash = ${entry.keyHash}
      and kind = ${entry.kind}
      and occurred_at > ${cutoff}
  `);
  const count = result.rows[0]?.count ?? 0;
  return {
    entry,
    count,
    expiresAt: new Date(now.getTime() + HOUR_MS),
    ...(count >= entry.limit ? { retryAt: await rollingRetryAt(tx, entry, cutoff, count) } : {}),
  };
}

/**
 * When a full rolling window lets one more request through: the oldest event
 * that keeps it full leaves the window an hour after it happened. Reading the
 * row rather than adding an hour to now is the whole point — a window filled
 * fifty minutes ago frees up in ten minutes, not in an hour.
 */
async function rollingRetryAt(
  tx: DatabaseTransaction,
  entry: AtomicRateEntry,
  cutoff: Date,
  count: number,
): Promise<Date> {
  const result = await tx.execute<{ occurred_at: string | Date }>(sql`
    select occurred_at
    from rate_limit_events
    where key_hash = ${entry.keyHash}
      and kind = ${entry.kind}
      and occurred_at > ${cutoff}
    order by occurred_at asc
    offset ${count - entry.limit}
    limit 1
  `);
  const oldestCounted = result.rows[0]?.occurred_at;
  // The count and this row come from one predicate, in one transaction, under
  // one lock: a full window always holds the event that keeps it full.
  if (oldestCounted === undefined)
    throw new Error(`a full ${entry.kind} window was read without the event that fills it`);
  return new Date(new Date(oldestCounted).getTime() + HOUR_MS);
}

async function ensureAndLockFixedRateWindow(
  tx: DatabaseTransaction,
  entry: AtomicRateEntry,
  now: Date,
): Promise<LockedRateEntry> {
  const windowStart = rateWindowStart(entry.kind, now);
  const expiresAt = new Date(windowStart.getTime() + DAY_MS);
  await tx.execute(sql`
    insert into rate_windows (key_hash, window_start, kind, count, challenge_passed_count, expires_at)
    values (${entry.keyHash}, ${windowStart}, ${entry.kind}, 0, 0, ${expiresAt})
    on conflict (key_hash, window_start, kind) do nothing
  `);
  const result = await tx.execute<{ count: number }>(sql`
    select count from rate_windows
    where key_hash = ${entry.keyHash}
      and window_start = ${windowStart}
      and kind = ${entry.kind}
    for update
  `);
  const count = result.rows[0]?.count ?? 0;
  return {
    entry,
    count,
    windowStart,
    expiresAt,
    // A fixed window frees when it rolls over, which is when it expires.
    ...(count >= entry.limit ? { retryAt: expiresAt } : {}),
  };
}

async function lockRateEntry(
  tx: DatabaseTransaction,
  entry: AtomicRateEntry,
  now: Date,
): Promise<LockedRateEntry> {
  return usesRollingWindow(entry.kind)
    ? await lockRollingRate(tx, entry, now)
    : await ensureAndLockFixedRateWindow(tx, entry, now);
}

async function recordRateConsumption(
  tx: DatabaseTransaction,
  locked: LockedRateEntry,
  now: Date,
  challengePassed = false,
): Promise<string | undefined> {
  if (usesRollingWindow(locked.entry.kind)) {
    const eventId = createUuidV7();
    await tx.execute(sql`
      insert into rate_limit_events
        (id, key_hash, kind, occurred_at, challenge_passed, expires_at)
      values
        (${eventId}, ${locked.entry.keyHash}, ${locked.entry.kind}, ${now}, ${challengePassed}, ${locked.expiresAt})
    `);
    return eventId;
  }
  if (!locked.windowStart)
    throw new Error(`a ${locked.entry.kind} window was locked without a window start`);
  await tx.execute(sql`
    update rate_windows
    set count = count + 1,
        challenge_passed_count = challenge_passed_count + ${challengePassed ? 1 : 0},
        expires_at = ${locked.expiresAt}
    where key_hash = ${locked.entry.keyHash}
      and window_start = ${locked.windowStart}
      and kind = ${locked.entry.kind}
  `);
  return undefined;
}

export async function readRateCount(
  keyHash: string,
  kind: RateKind,
  now = new Date(),
): Promise<number> {
  const { db } = getDatabase();
  if (usesRollingWindow(kind)) {
    const cutoff = new Date(now.getTime() - HOUR_MS);
    const result = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
      from rate_limit_events
      where key_hash = ${keyHash}
        and kind = ${kind}
        and occurred_at > ${cutoff}
    `);
    return result.rows[0]?.count ?? 0;
  }
  const windowStart = rateWindowStart(kind, now);
  const result = await db.execute<{ count: number }>(
    sql`select count from rate_windows where key_hash = ${keyHash} and window_start = ${windowStart} and kind = ${kind}`,
  );
  return result.rows[0]?.count ?? 0;
}

export async function consumeRateLimit(
  keyHash: string,
  kind: RateKind,
  limit: number,
  now = new Date(),
): Promise<{ allowed: boolean; count: number }> {
  const entry = { keyHash, kind, limit };
  const { db } = getDatabase();
  return await db.transaction(async (tx) => {
    const locked = await lockRateEntry(tx, entry, now);
    if (locked.count >= limit) return { allowed: false, count: locked.count };
    await recordRateConsumption(tx, locked, now);
    return { allowed: true, count: locked.count + 1 };
  });
}

/**
 * Of the walls standing, the one that is still there when the others have
 * gone: the latest moment, and the kind that set it.
 *
 * This is a floor on the wait, not a promise about the door. Two of these
 * walls are shared — a scan session, an IP that a whole office sits behind —
 * so somebody else's request can refill one between the answer and the
 * return. What the answer can say honestly is that nothing passes before this
 * moment.
 */
function governingWall(walls: readonly LockedRateEntry[]): { retryAt: Date; wall: RateKind } {
  let latest: { retryAt: Date; wall: RateKind } | undefined;
  for (const wall of walls) {
    if (!wall.retryAt) continue;
    if (!latest || wall.retryAt.getTime() > latest.retryAt.getTime())
      latest = { retryAt: wall.retryAt, wall: wall.entry.kind };
  }
  if (!latest) throw new Error("a full rate window was read without the moment it frees");
  return latest;
}

/**
 * Give back one rolling event that was taken and not used.
 *
 * The walls count two different things, and only one of them can be given
 * back. An address's hour counts letters that arrived in somebody's mailbox:
 * when the send is refused downstream no letter arrived, and charging the
 * address for it means a person who obeys "ask again in forty seconds" spends
 * their hour on refusals. A session's or an IP's hour counts requests arriving
 * at us, and the request did arrive, so it stays spent. A send we merely could
 * not confirm is not refunded either: we know a letter went out only when the
 * far side says it did, and we do not give back what we cannot prove unspent.
 */
export async function refundRateLimitEvent(eventId: string): Promise<void> {
  await getDatabase().db.execute(sql`delete from rate_limit_events where id = ${eventId}`);
}

export async function consumeRateLimitsAtomically(
  entries: readonly AtomicRateEntry[],
  now = new Date(),
  transaction?: DatabaseTransaction,
): Promise<RateLimitOutcome> {
  const ordered = [...entries].sort((a, b) =>
    `${a.kind}:${a.keyHash}`.localeCompare(`${b.kind}:${b.keyHash}`),
  );
  const consume = async (tx: DatabaseTransaction): Promise<RateLimitOutcome> => {
    const locked: LockedRateEntry[] = [];
    for (const entry of ordered) locked.push(await lockRateEntry(tx, entry, now));
    const walls = locked.filter(({ count, entry }) => count >= entry.limit);
    if (walls.length) return { allowed: false, ...governingWall(walls) };
    const spent: SpentRateEvent[] = [];
    for (const entry of locked) {
      const eventId = await recordRateConsumption(tx, entry, now);
      if (eventId) spent.push({ kind: entry.entry.kind, eventId });
    }
    return { allowed: true, spent };
  };
  return transaction ? await consume(transaction) : await getDatabase().db.transaction(consume);
}

/**
 * A scan refused outright says when the wall it hit frees, for the same reason
 * the link doors do: the caller is a machine, and an hour it made up is an
 * hour of somebody's agent doing nothing for no reason.
 */
export type ScanRateDecision =
  | Readonly<{ verdict: "allowed" }>
  | Readonly<{ verdict: "challenge_required" }>
  | Readonly<{ verdict: "hard_rate_limit"; retryAt: Date }>;

export async function consumeScanRateLimits(input: {
  ipKey: string;
  targetKey: string;
  challengePassed: boolean;
  now?: Date;
}): Promise<ScanRateDecision> {
  const now = input.now ?? new Date();
  const entries: readonly AtomicRateEntry[] = [
    { keyHash: input.ipKey, kind: "scan_ip_hour", limit: 10 },
    { keyHash: input.targetKey, kind: "scan_target_day", limit: 10 },
  ];
  const ordered = [...entries].sort((a, b) =>
    `${a.kind}:${a.keyHash}`.localeCompare(`${b.kind}:${b.keyHash}`),
  );
  const { db } = getDatabase();
  return await db.transaction(async (tx) => {
    const locked: LockedRateEntry[] = [];
    for (const entry of ordered) locked.push(await lockRateEntry(tx, entry, now));
    const ip = locked.find(({ entry }) => entry.kind === "scan_ip_hour");
    const target = locked.find(({ entry }) => entry.kind === "scan_target_day");
    if (!ip || !target)
      throw new Error("a scan was rate-checked without both its ip window and its target window");

    const walls = [ip, target].filter(({ count, entry }) => count >= entry.limit);
    if (walls.length) return { verdict: "hard_rate_limit", retryAt: governingWall(walls).retryAt };
    if (ip.count >= 3 && !input.challengePassed) return { verdict: "challenge_required" };

    await recordRateConsumption(tx, ip, now, input.challengePassed && ip.count >= 3);
    await recordRateConsumption(tx, target, now);
    return { verdict: "allowed" };
  });
}

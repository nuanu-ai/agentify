import { sql } from "drizzle-orm";
import {
  createUuidV7,
  type DatabaseTransaction,
} from "@agentify/scanner-database";

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
}>;

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
  return {
    entry,
    count: result.rows[0]?.count ?? 0,
    expiresAt: new Date(now.getTime() + HOUR_MS),
  };
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
  return {
    entry,
    count: result.rows[0]?.count ?? 0,
    windowStart,
    expiresAt,
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
): Promise<void> {
  if (usesRollingWindow(locked.entry.kind)) {
    await tx.execute(sql`
      insert into rate_limit_events
        (id, key_hash, kind, occurred_at, challenge_passed, expires_at)
      values
        (${createUuidV7()}, ${locked.entry.keyHash}, ${locked.entry.kind}, ${now}, ${challengePassed}, ${locked.expiresAt})
    `);
    return;
  }
  await tx.execute(sql`
    update rate_windows
    set count = count + 1,
        challenge_passed_count = challenge_passed_count + ${challengePassed ? 1 : 0},
        expires_at = ${locked.expiresAt}
    where key_hash = ${locked.entry.keyHash}
      and window_start = ${locked.windowStart!}
      and kind = ${locked.entry.kind}
  `);
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

export async function consumeRateLimitsAtomically(
  entries: readonly AtomicRateEntry[],
  now = new Date(),
  transaction?: DatabaseTransaction,
): Promise<{ allowed: boolean }> {
  const ordered = [...entries].sort((a, b) =>
    `${a.kind}:${a.keyHash}`.localeCompare(`${b.kind}:${b.keyHash}`),
  );
  const consume = async (tx: DatabaseTransaction) => {
    const locked: LockedRateEntry[] = [];
    for (const entry of ordered)
      locked.push(await lockRateEntry(tx, entry, now));
    if (locked.some(({ count, entry }) => count >= entry.limit))
      return { allowed: false };
    for (const entry of locked) await recordRateConsumption(tx, entry, now);
    return { allowed: true };
  };
  return transaction
    ? await consume(transaction)
    : await getDatabase().db.transaction(consume);
}

export async function consumeScanRateLimits(input: {
  ipKey: string;
  targetKey: string;
  challengePassed: boolean;
  now?: Date;
}): Promise<"allowed" | "challenge_required" | "hard_rate_limit"> {
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
    for (const entry of ordered)
      locked.push(await lockRateEntry(tx, entry, now));
    const ip = locked.find(({ entry }) => entry.kind === "scan_ip_hour")!;
    const target = locked.find(
      ({ entry }) => entry.kind === "scan_target_day",
    )!;

    if (ip.count >= ip.entry.limit || target.count >= target.entry.limit)
      return "hard_rate_limit";
    if (ip.count >= 3 && !input.challengePassed) return "challenge_required";

    await recordRateConsumption(
      tx,
      ip,
      now,
      input.challengePassed && ip.count >= 3,
    );
    await recordRateConsumption(tx, target, now);
    return "allowed";
  });
}

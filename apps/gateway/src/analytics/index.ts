/**
 * Recording product analytics events. An event is one row in the outbox,
 * written where the fact it records is written; a background sender in the
 * dashboard takes it to Nuanu Analytics later, so recording never waits on
 * the network and never fails because Nuanu is away.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { analyticsEvents } from "../adapters/postgres/schema.js";
import { failureNamed } from "../failure-named.js";
import type { AnalyticsEvent } from "./events.js";

export type {
  AnalyticsEvent,
  AuthResult,
  CardPublishResult,
  DashboardViewed,
  MerchantCreated,
  OrderCreated,
  OrderOutcomeChanged,
  PaymentResult,
  SellingChanged,
  SetupResult,
  UiBlocked,
} from "./events.js";
export { checkedEvent } from "./events.js";

/**
 * A drizzle node-postgres database or a transaction on one, such as the
 * gateway store's or the dashboard's.
 */
export type Recorder = Pick<NodePgDatabase, "insert">;

/**
 * Records `event` as having happened at `at`, inside the caller's
 * transaction: it commits with the caller's writes and is gone if they roll
 * back. It is one insert and checks nothing, so it fails only where the
 * transaction itself does; an event that breaks the contract is refused by
 * the sender, never here. The event's id and time are fixed now and sent
 * unchanged however often sending is tried.
 */
export async function record(tx: Recorder, event: AnalyticsEvent, at: Date): Promise<void> {
  // A time that is no time would throw before the insert is sent; the
  // database's own clock stands in for it.
  const occurredAt = Number.isNaN(at.getTime()) ? sql`now()` : at;
  await tx.insert(analyticsEvents).values({
    id: randomUUID(),
    name: event.name,
    occurredAt,
    actorType: event.actor,
    source: event.source,
    properties: event.fields ?? {},
    refs: event.refs ?? {},
    nextAttemptAt: occurredAt,
  });
}

/**
 * Records an observation that has no transaction of its own, such as a screen
 * shown or a problem on it, straight on `db`. It never rejects: a failure is
 * one line in the log, naming no identifier, and the page goes on. A caller
 * that should not wait for the database need not await it.
 */
export async function recordObserved(db: Recorder, event: AnalyticsEvent, at: Date): Promise<void> {
  try {
    await record(db, event, at);
  } catch (thrown) {
    console.error(`[analytics] an analytics event could not be recorded: ${failureNamed(thrown)}`);
  }
}

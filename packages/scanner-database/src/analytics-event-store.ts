import type { BusinessEventStore } from "@agentify/analytics";
import { eq } from "drizzle-orm";

import type { Database } from "./client.js";
import { createUuidV7 } from "./ids.js";
import { analyticsEvents, deliveryOutbox } from "./schema.js";

export type BusinessEventInput = Parameters<
  BusinessEventStore["insertOnce"]
>[0];
export type BusinessEventExecutor = Pick<Database, "select" | "insert">;

export const insertBusinessEventOnce = async (
  executor: BusinessEventExecutor,
  input: BusinessEventInput,
): Promise<{ inserted: boolean; eventId: string }> => {
  const existing = await executor
    .select({ eventId: analyticsEvents.eventId })
    .from(analyticsEvents)
    .where(eq(analyticsEvents.onceKey, input.onceKey))
    .limit(1);
  if (existing[0]) return { inserted: false, eventId: existing[0].eventId };

  const [insertedEvent] = await executor
    .insert(analyticsEvents)
    .values({
      id: createUuidV7(),
      eventId: input.event.eventId,
      onceKey: input.onceKey,
      name: input.event.name,
      occurredAt: new Date(input.event.occurredAt),
      sessionId: input.context.sessionId,
      ...(input.context.leadId ? { leadId: input.context.leadId } : {}),
      ...(input.context.scanId ? { scanId: input.context.scanId } : {}),
      segment: input.event.segment,
      landingVariant: input.event.landingVariant,
      properties: input.event.properties,
      consentSnapshotId: input.context.consentSnapshotId,
    })
    .onConflictDoNothing({ target: analyticsEvents.onceKey })
    .returning({ eventId: analyticsEvents.eventId });

  if (!insertedEvent) {
    const raced = await executor
      .select({ eventId: analyticsEvents.eventId })
      .from(analyticsEvents)
      .where(eq(analyticsEvents.onceKey, input.onceKey))
      .limit(1);
    if (!raced[0]) throw new Error("analytics_once_key_conflict_without_row");
    return { inserted: false, eventId: raced[0].eventId };
  }

  if (input.outbox.length) {
    await executor.insert(deliveryOutbox).values(
      input.outbox.map((row) => ({
        id: createUuidV7(),
        eventId: insertedEvent.eventId,
        destination: row.destination,
        payload: row.payload,
      })),
    );
  }
  return { inserted: true, eventId: insertedEvent.eventId };
};

export const createBusinessEventStore = (db: Database): BusinessEventStore => ({
  async insertOnce(input) {
    return await db.transaction(async (tx) =>
      insertBusinessEventOnce(tx, input),
    );
  },
});

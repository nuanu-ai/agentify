import type { ConsentSnapshot } from "./consent.js";
import type { AnalyticsEvent } from "./events.js";
import { eventOnceKey } from "./events.js";
import { buildOutboxInserts, type OutboxInsert } from "./outbox.js";

export interface BusinessEventStore {
  /** Must atomically insert event+outbox and enforce unique onceKey/eventId. */
  insertOnce(input: {
    onceKey: string;
    event: AnalyticsEvent;
    context: BusinessEventContext;
    outbox: OutboxInsert[];
  }): Promise<{ inserted: boolean; eventId: string }>;
}

export type BusinessEventContext = {
  sessionId: string;
  consentSnapshotId: string;
  leadId?: string;
  scanId?: string;
};

export const emitBusinessEvent = async (input: {
  store: BusinessEventStore;
  event: AnalyticsEvent;
  identifiers: Readonly<Record<string, string>>;
  context: BusinessEventContext;
  consent: ConsentSnapshot;
  posthogPayload: unknown;
  metaPayload: unknown;
}): Promise<{ inserted: boolean; eventId: string }> =>
  await input.store.insertOnce({
    onceKey: eventOnceKey(input.event.name, input.identifiers),
    event: input.event,
    context: input.context,
    outbox: buildOutboxInserts({
      event: input.event,
      consent: input.consent,
      posthogPayload: input.posthogPayload,
      metaPayload: input.metaPayload,
    }),
  });

import type { DeliveryDestination } from "@b2a/contracts";
import type { ConsentSnapshot } from "./consent.js";
import { consentAllowsDestination } from "./consent.js";
import type { AnalyticsEvent } from "./events.js";

export type OutboxInsert = {
  eventId: string;
  destination: DeliveryDestination;
  payload: unknown;
};

export const buildOutboxInserts = (input: {
  event: AnalyticsEvent;
  consent: ConsentSnapshot;
  posthogPayload: unknown;
  metaPayload: unknown;
}): OutboxInsert[] => {
  const rows: OutboxInsert[] = [];
  if (consentAllowsDestination(input.consent, "posthog")) {
    rows.push({
      eventId: input.event.eventId,
      destination: "posthog",
      payload: input.posthogPayload,
    });
  }
  if (consentAllowsDestination(input.consent, "meta")) {
    rows.push({
      eventId: input.event.eventId,
      destination: "meta",
      payload: input.metaPayload,
    });
  }
  return rows;
};

export const retryDelayMs = (attempt: number): number =>
  Math.min(24 * 60 * 60 * 1000, 1_000 * 2 ** Math.max(0, attempt - 1));

export const shouldDeadLetter = (attempt: number): boolean => attempt >= 17;

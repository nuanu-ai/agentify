/**
 * What happens to an event once a visitor has allowed measuring: it is
 * recorded by the scanner first, and only then delivered to PostHog and the
 * Meta pixel where the visitor allowed each. Fetched by the analytics runtime
 * on the first event a visitor allowed, so a visit nobody measures never loads
 * it.
 */

import type { ConsentSnapshot } from "@agentify/analytics/browser";
import {
  type BrowserAnalyticsConfig,
  metaPixelOf,
  posthogOf,
} from "@agentify/consent/destinations";
import type { AnalyticsEventName, Segment } from "@agentify/scanner-contracts";

import {
  createClientOwnedEventId,
  dispatchConsentedBrowserEvent,
  recordThenDeliverWithConsent,
} from "./analytics-client";

type ClientEventName = Extract<
  AnalyticsEventName,
  "landing_view" | "results_viewed" | "registration_started"
>;

export type PendingEvent = {
  name: ClientEventName;
  onceKey: string;
  scanId?: string;
  segment?: Segment;
  landingVariant?: string;
};

const META_CLIENT_EVENT = {
  landing_view: "PageView",
  results_viewed: "ViewContent",
  registration_started: "RegistrationStart",
} as const;

export async function deliver(
  config: BrowserAnalyticsConfig,
  event: PendingEvent,
  snapshot: ConsentSnapshot,
): Promise<void> {
  const eventIdKey = `agentify.analytics.event-id.${event.onceKey}`;
  const candidateEventId =
    window.sessionStorage.getItem(eventIdKey) ?? createClientOwnedEventId(event.name);
  window.sessionStorage.setItem(eventIdKey, candidateEventId);
  const scanToken = event.scanId
    ? window.sessionStorage.getItem(`agentify:scan-token:${event.scanId}`)
    : null;
  try {
    await recordThenDeliverWithConsent({
      consent: snapshot,
      recordBusinessEvent: async () => {
        const response = await fetch("/api/v1/events", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(scanToken ? { Authorization: `Bearer ${scanToken}` } : {}),
          },
          body: JSON.stringify({
            event_id: candidateEventId,
            name: event.name,
            ...(event.scanId ? { scan_id: event.scanId } : {}),
            ...(event.segment ? { segment: event.segment } : {}),
            ...(event.landingVariant ? { landing_variant: event.landingVariant } : {}),
            properties: {},
          }),
        });
        if (!response.ok) throw new Error("analytics_record_failed");
        const result = (await response.json()) as {
          event_id: string;
          segment: Segment;
          landing_variant: string;
        };
        window.sessionStorage.setItem(eventIdKey, result.event_id);
        return result;
      },
      deliverToBrowserDestinations: async (result, allowedConsent) => {
        await dispatchConsentedBrowserEvent({
          eventId: result.event_id,
          onceKey: `${event.onceKey}:${result.event_id}`,
          consent: allowedConsent,
          storage: window.localStorage,
          sendPosthog: async (eventId) =>
            sendPosthog(config, event.name, eventId, result.segment, result.landing_variant),
          sendMetaPixel: async (eventId) =>
            sendMetaPixel(config, event.name, eventId, result.segment, result.landing_variant),
        });
      },
    });
  } catch {
    // A later route trigger/refresh can retry the server event. Browser
    // destination once-keys are stored only after their own successful send.
  }
}

async function sendPosthog(
  config: BrowserAnalyticsConfig,
  name: ClientEventName,
  eventId: string,
  segment: Segment,
  landingVariant: string,
) {
  const posthog = await posthogOf(config);
  posthog?.capture(name, {
    $insert_id: eventId,
    $process_person_profile: false,
    segment,
    landing_variant: landingVariant,
  });
}

async function sendMetaPixel(
  config: BrowserAnalyticsConfig,
  name: ClientEventName,
  eventId: string,
  segment: Segment,
  landingVariant: string,
) {
  const fbq = metaPixelOf(config);
  if (!fbq) return;
  fbq(
    name === "landing_view" || name === "results_viewed" ? "track" : "trackCustom",
    META_CLIENT_EVENT[name],
    { segment, landing_variant: landingVariant },
    { eventID: eventId },
  );
}

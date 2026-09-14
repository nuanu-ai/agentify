import type { ConsentSnapshot } from "@b2a/analytics/browser";
import type { AnalyticsEventName } from "@b2a/contracts";

export interface BrowserOnceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const createBrowserEventId = (now = Date.now()): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const createClientOwnedEventId = (
  name: Extract<
    AnalyticsEventName,
    "landing_view" | "results_viewed" | "registration_started"
  >,
): string => {
  if (
    !new Set(["landing_view", "results_viewed", "registration_started"]).has(
      name,
    )
  ) {
    throw new Error("event_id_must_come_from_business_transaction");
  }
  return createBrowserEventId();
};

export const dispatchConsentedBrowserEvent = async (input: {
  eventId: string;
  onceKey: string;
  consent: ConsentSnapshot;
  storage: BrowserOnceStorage;
  sendPosthog: (eventId: string) => void | Promise<void>;
  sendMetaPixel: (eventId: string) => void | Promise<void>;
}): Promise<{ posthog: boolean; meta: boolean }> => {
  const delivered = { posthog: false, meta: false };
  const deliver = async (
    destination: "posthog" | "meta",
    allowed: boolean,
    sender: (eventId: string) => void | Promise<void>,
  ) => {
    if (!allowed) return;
    const key = `b2a.analytics.once.${destination}.${input.onceKey}`;
    if (input.storage.getItem(key)) return;
    await sender(input.eventId);
    input.storage.setItem(key, input.eventId);
    delivered[destination] = true;
  };
  await Promise.all([
    deliver(
      "posthog",
      input.consent.categories.product_analytics,
      input.sendPosthog,
    ),
    deliver(
      "meta",
      input.consent.categories.ads_measurement,
      input.sendMetaPixel,
    ),
  ]);
  return delivered;
};

export async function recordThenDeliverWithConsent<T>(input: {
  consent?: ConsentSnapshot;
  recordBusinessEvent: () => Promise<T>;
  deliverToBrowserDestinations: (
    recorded: T,
    consent: ConsentSnapshot,
  ) => Promise<void>;
}): Promise<T> {
  const recorded = await input.recordBusinessEvent();
  if (input.consent) {
    await input.deliverToBrowserDestinations(recorded, input.consent);
  }
  return recorded;
}

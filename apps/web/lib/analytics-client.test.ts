import { createConsentSnapshot } from "@agentify/analytics/browser";
import { describe, expect, it } from "vitest";

import {
  createBrowserEventId,
  createClientOwnedEventId,
  dispatchConsentedBrowserEvent,
  recordThenDeliverWithConsent,
} from "./analytics-client.js";

describe("browser analytics dedup", () => {
  it("records canonical business state before consent without loading destinations", async () => {
    const state = { recorded: false, delivered: false };
    await expect(
      recordThenDeliverWithConsent({
        consent: undefined,
        recordBusinessEvent: async () => {
          state.recorded = true;
          return { eventId: "business-event" };
        },
        deliverToBrowserDestinations: async () => {
          state.delivered = true;
        },
      }),
    ).resolves.toEqual({ eventId: "business-event" });
    expect(state).toEqual({ recorded: true, delivered: false });
  });

  it("creates UUIDv7 event IDs for client-owned triggers", () => {
    expect(createBrowserEventId(1_700_000_000_000)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(createClientOwnedEventId("landing_view")).toMatch(/-7[0-9a-f]{3}-/);
  });

  it("does not call either SDK when consent is denied", async () => {
    const delivered = { posthog: false, meta: false };
    const consent = createConsentSnapshot({
      policy: {
        policyVersion: "v1",
        requireOptInForAdsMeasurement: true,
        requireOptInForProductAnalytics: true,
      },
      decisions: {},
      source: "banner",
    });
    const storage = new Map<string, string>();
    await dispatchConsentedBrowserEvent({
      eventId: createBrowserEventId(),
      onceKey: "landing:session:day",
      consent,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      sendPosthog: () => {
        delivered.posthog = true;
      },
      sendMetaPixel: () => {
        delivered.meta = true;
      },
    });
    expect(delivered).toEqual({ posthog: false, meta: false });
  });

  it("deduplicates per destination only after successful delivery", async () => {
    const consent = createConsentSnapshot({
      policy: {
        policyVersion: "v1",
        requireOptInForAdsMeasurement: true,
        requireOptInForProductAnalytics: true,
      },
      decisions: { product_analytics: true, ads_measurement: true },
      source: "banner",
    });
    const values = new Map<string, string>();
    const deliveries = { posthog: 0, meta: 0 };
    const input = {
      eventId: createBrowserEventId(),
      onceKey: "result:session:scan",
      consent,
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
      sendPosthog: () => {
        deliveries.posthog += 1;
      },
      sendMetaPixel: () => {
        deliveries.meta += 1;
      },
    };
    await dispatchConsentedBrowserEvent(input);
    await dispatchConsentedBrowserEvent(input);
    expect(deliveries).toEqual({ posthog: 1, meta: 1 });
    expect(values.size).toBe(2);
  });

  it("retries only the destination that failed before its once-key was stored", async () => {
    const consent = createConsentSnapshot({
      policy: {
        policyVersion: "v1",
        requireOptInForAdsMeasurement: true,
        requireOptInForProductAnalytics: true,
      },
      decisions: { product_analytics: true, ads_measurement: true },
      source: "banner",
    });
    const values = new Map<string, string>();
    const deliveries = { posthog: 0, meta: 0 };
    const input = {
      eventId: createBrowserEventId(),
      onceKey: "landing:retry",
      consent,
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
      sendPosthog: () => {
        deliveries.posthog += 1;
        if (deliveries.posthog === 1) {
          throw new Error("posthog_unavailable");
        }
      },
      sendMetaPixel: () => {
        deliveries.meta += 1;
      },
    };
    await expect(dispatchConsentedBrowserEvent(input)).rejects.toThrow("posthog_unavailable");
    await dispatchConsentedBrowserEvent(input);
    expect(deliveries).toEqual({ posthog: 2, meta: 1 });
    expect(values.size).toBe(2);
  });
});

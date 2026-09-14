import { createConsentSnapshot } from "@b2a/analytics/browser";
import { describe, expect, it, vi } from "vitest";

import {
  createBrowserEventId,
  createClientOwnedEventId,
  dispatchConsentedBrowserEvent,
  recordThenDeliverWithConsent,
} from "./analytics-client.js";

describe("browser analytics dedup", () => {
  it("records canonical business state before consent without loading destinations", async () => {
    const recordBusinessEvent = vi
      .fn()
      .mockResolvedValue({ eventId: "business-event" });
    const deliverToBrowserDestinations = vi.fn();
    await expect(
      recordThenDeliverWithConsent({
        consent: undefined,
        recordBusinessEvent,
        deliverToBrowserDestinations,
      }),
    ).resolves.toEqual({ eventId: "business-event" });
    expect(recordBusinessEvent).toHaveBeenCalledOnce();
    expect(deliverToBrowserDestinations).not.toHaveBeenCalled();
  });

  it("creates UUIDv7 event IDs for client-owned triggers", () => {
    expect(createBrowserEventId(1_700_000_000_000)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(createClientOwnedEventId("landing_view")).toMatch(/-7[0-9a-f]{3}-/);
  });

  it("does not call either SDK when consent is denied", async () => {
    const posthog = vi.fn();
    const meta = vi.fn();
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
      sendPosthog: posthog,
      sendMetaPixel: meta,
    });
    expect(posthog).not.toHaveBeenCalled();
    expect(meta).not.toHaveBeenCalled();
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
    const posthog = vi.fn();
    const meta = vi.fn();
    const input = {
      eventId: createBrowserEventId(),
      onceKey: "result:session:scan",
      consent,
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
      sendPosthog: posthog,
      sendMetaPixel: meta,
    };
    await dispatchConsentedBrowserEvent(input);
    await dispatchConsentedBrowserEvent(input);
    expect(posthog).toHaveBeenCalledOnce();
    expect(meta).toHaveBeenCalledOnce();
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
    const posthog = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("posthog_unavailable"))
      .mockResolvedValue();
    const meta = vi.fn();
    const input = {
      eventId: createBrowserEventId(),
      onceKey: "landing:retry",
      consent,
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
      sendPosthog: posthog,
      sendMetaPixel: meta,
    };
    await expect(dispatchConsentedBrowserEvent(input)).rejects.toThrow(
      "posthog_unavailable",
    );
    await dispatchConsentedBrowserEvent(input);
    expect(posthog).toHaveBeenCalledTimes(2);
    expect(meta).toHaveBeenCalledOnce();
  });
});

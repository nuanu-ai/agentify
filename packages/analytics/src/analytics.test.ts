import { ANALYTICS_EVENT_NAMES, type AnalyticsEventName } from "@agentify/scanner-contracts";
import { describe, expect, it } from "vitest";
import {
  assertDestinationIsolation,
  buildMetaPayload,
  buildMetaPixelCommand,
  buildOutboxInserts,
  buildPosthogPayload,
  createAnalyticsEvent,
  createConsentSnapshot,
  emitBusinessEvent,
  eventOnceKey,
  loadConsentedAnalytics,
  META_EVENT_MAPPING,
  POSTHOG_BROWSER_OPTIONS,
  readAttributionTouch,
  retryDelayMs,
  sanitizeEventProperties,
  saveConsentDecision,
  shouldDeadLetter,
  updateAttribution,
} from "./index.js";

const baseEvent = (name: AnalyticsEventName) =>
  createAnalyticsEvent({
    eventId: "018f3f56-2ec8-7b16-8f66-5b8f93f3251f",
    name,
    occurredAt: "2026-07-12T12:00:00.000Z",
    pseudonymousId: "anon_4b9c18f087",
    segment: "store",
    landingVariant: "store-v1",
    properties: {},
  });

describe("analytics privacy and dedup contracts", () => {
  it("supports exactly the canonical events, one destination name each", () => {
    expect(Object.keys(META_EVENT_MAPPING)).toEqual([...ANALYTICS_EVENT_NAMES]);
    expect(META_EVENT_MAPPING.scan_started).toBe("ScanStart");
    expect(META_EVENT_MAPPING.scan_started).not.toBe("InitiateCheckout");
    expect(META_EVENT_MAPPING.card_attached).toBe("CardAttached");
  });

  it("uses one event ID for PostHog, Pixel and CAPI", () => {
    const event = baseEvent("registration_completed");
    expect(buildPosthogPayload(event, "ph_project").properties.$insert_id).toBe(event.eventId);
    expect(buildMetaPixelCommand(event).options.eventID).toBe(event.eventId);
    expect(
      buildMetaPayload(event, {
        externalId: "a".repeat(64),
        allowHashedEmail: false,
        allowTransientNetworkData: false,
      }).data[0]?.event_id,
    ).toBe(event.eventId);
  });

  it("removes email, scanned URL/domain/query and free text from destination properties", () => {
    const properties = sanitizeEventProperties("scan_completed", {
      coverage: 0.8,
      cache_hit: false,
      terminal_status: "partial",
      email: "owner@example.com",
      scanned_url: "https://secret.example/?token=x",
      host: "secret.example",
      pain_answer: "My checkout fails",
      unexpected: "value",
    });
    expect(properties).toEqual({
      coverage: 0.8,
      cache_hit: false,
      terminal_status: "partial",
    });
    const event = createAnalyticsEvent({
      ...baseEvent("scan_completed"),
      properties,
    });
    const serialized = JSON.stringify([
      buildPosthogPayload(event, "ph_project"),
      buildMetaPayload(event, {
        externalId: "a".repeat(64),
        allowHashedEmail: false,
        allowTransientNetworkData: false,
      }),
    ]);
    expect(serialized).not.toMatch(/owner@|secret\.example|token=|checkout fails/i);
  });

  it("never enables PostHog autocapture or replay", () => {
    expect(POSTHOG_BROWSER_OPTIONS).toMatchObject({
      autocapture: false,
      disable_session_recording: true,
      capture_pageview: false,
    });
  });

  it("creates no outbox rows when analytics consent is denied", () => {
    const consent = createConsentSnapshot({
      policy: {
        policyVersion: "v1",
        requireOptInForAdsMeasurement: true,
        requireOptInForProductAnalytics: true,
      },
      decisions: {},
      source: "banner",
    });
    expect(
      buildOutboxInserts({
        event: baseEvent("landing_view"),
        consent,
        posthogPayload: {},
        metaPayload: {},
      }),
    ).toEqual([]);
  });

  it("gates PostHog and Meta independently", () => {
    const event = baseEvent("landing_view");
    const productOnly = createConsentSnapshot({
      policy: {
        policyVersion: "v1",
        requireOptInForAdsMeasurement: true,
        requireOptInForProductAnalytics: true,
      },
      decisions: { product_analytics: true },
      source: "banner",
    });
    expect(
      buildOutboxInserts({
        event,
        consent: productOnly,
        posthogPayload: {},
        metaPayload: {},
      }).map((row) => row.destination),
    ).toEqual(["posthog"]);
  });

  it("persists append-only consent before enabling allowed browser SDKs", async () => {
    const values = new Map<string, string>();
    const calls: string[] = [];
    const snapshot = createConsentSnapshot({
      policy: {
        policyVersion: "v1",
        requireOptInForAdsMeasurement: true,
        requireOptInForProductAnalytics: true,
      },
      decisions: { product_analytics: true, ads_measurement: false },
      source: "banner",
    });
    await saveConsentDecision({
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
      snapshot,
      persistAppendOnly: async () => {
        calls.push("persisted");
      },
    });
    await loadConsentedAnalytics({
      snapshot,
      loadPosthog: async () => {
        calls.push("posthog");
      },
      loadMetaPixel: async () => {
        calls.push("meta");
      },
    });
    expect(calls).toEqual(["persisted", "posthog"]);
    expect([...values.values()][0]).toContain('"ads_measurement":false');
  });

  it("prevents preview/test from using production destinations", () => {
    expect(() => assertDestinationIsolation("preview", "production")).toThrow(
      "analytics_environment_mismatch",
    );
    expect(() => assertDestinationIsolation("test", "production")).toThrow(
      "analytics_environment_mismatch",
    );
    expect(() => assertDestinationIsolation("production", "production")).not.toThrow();
  });

  it("produces stable business once keys for all events", () => {
    const ids = {
      session_id: "session",
      variant: "store-v1",
      day: "2026-07-12",
      scan_id: "scan",
      lead_id: "lead",
      setup_intent_id: "seti",
      share_id: "share",
    };
    const keys = ANALYTICS_EVENT_NAMES.map((name) => eventOnceKey(name, ids));
    expect(new Set(keys).size).toBe(ANALYTICS_EVENT_NAMES.length);
    expect(eventOnceKey("registration_completed", ids)).toBe("registration_completed:lead:scan");
  });

  it("preserves first touch, updates last touch and hashes fbclid", () => {
    const first = readAttributionTouch(
      new URLSearchParams("utm_source=meta&utm_campaign=launch&fbclid=raw-click-id"),
      "store-v1",
    );
    const state = updateAttribution(undefined, first);
    const updated = updateAttribution(
      state,
      readAttributionTouch(new URLSearchParams("utm_source=organic"), "owner-v1"),
    );
    expect(updated.first.utmSource).toBe("meta");
    expect(updated.last.utmSource).toBe("organic");
    expect(updated.first.fbclidHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(updated)).not.toContain("raw-click-id");
  });

  it("delegates atomic once semantics to the business event store", async () => {
    const inserted = new Map<string, string>();
    const store = {
      async insertOnce(input: { onceKey: string; event: { eventId: string } }) {
        const existing = inserted.get(input.onceKey);
        if (existing) return { inserted: false, eventId: existing };
        inserted.set(input.onceKey, input.event.eventId);
        return { inserted: true, eventId: input.event.eventId };
      },
    };
    const event = baseEvent("scan_started");
    const consent = createConsentSnapshot({
      policy: {
        policyVersion: "v1",
        requireOptInForAdsMeasurement: true,
        requireOptInForProductAnalytics: true,
      },
      decisions: { product_analytics: true, ads_measurement: true },
      source: "api",
    });
    const input = {
      store,
      event,
      identifiers: { scan_id: "scan" },
      context: {
        sessionId: "session",
        consentSnapshotId: "consent",
        scanId: "scan",
      },
      consent,
      posthogPayload: {},
      metaPayload: {},
    };
    await expect(emitBusinessEvent(input)).resolves.toEqual({
      inserted: true,
      eventId: event.eventId,
    });
    await expect(emitBusinessEvent(input)).resolves.toEqual({
      inserted: false,
      eventId: event.eventId,
    });
    expect(inserted.size).toBe(1);
  });

  it("bounds exponential retry and dead-letters after the 24h window", () => {
    expect(retryDelayMs(1)).toBe(1_000);
    expect(retryDelayMs(17)).toBe(65_536_000);
    expect(retryDelayMs(30)).toBe(86_400_000);
    expect(shouldDeadLetter(16)).toBe(false);
    expect(shouldDeadLetter(17)).toBe(true);
  });
});

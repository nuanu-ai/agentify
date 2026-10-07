import { ANALYTICS_EVENT_NAMES, type AnalyticsEventName } from "@agentify/scanner-contracts";
import { describe, expect, it } from "vitest";
import { POSTHOG_BROWSER_OPTIONS } from "./browser-entry.js";
import {
  assertDestinationIsolation,
  buildMetaPayload,
  buildOutboxInserts,
  buildPosthogPayload,
  createAnalyticsEvent,
  createConsentSnapshot,
  eventOnceKey,
  META_EVENT_MAPPING,
  retryDelayMs,
  sanitizeEventProperties,
  saveConsentDecision,
  shouldDeadLetter,
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

  it("uses one event ID for PostHog and the Conversions API", () => {
    const event = baseEvent("registration_completed");
    expect(buildPosthogPayload(event, "ph_project").properties.$insert_id).toBe(event.eventId);
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
      terminal_status: "partial",
      email: "owner@example.com",
      scanned_url: "https://secret.example/?token=x",
      host: "secret.example",
      pain_answer: "My checkout fails",
      unexpected: "value",
    });
    expect(properties).toEqual({
      coverage: 0.8,
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
    // The options the browser runtime starts PostHog with, read through the
    // entry the web app imports them from, and all of them: a capture left out
    // of this list is one the PostHog project can switch on by itself.
    expect(POSTHOG_BROWSER_OPTIONS).toStrictEqual({
      autocapture: false,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      capture_exceptions: false,
      capture_performance: false,
      disable_session_recording: true,
      capture_pageview: false,
      capture_pageleave: false,
      person_profiles: "never",
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

  it("records consent on the server before the browser keeps it", async () => {
    // The browser acts on what it keeps, so what it keeps has to be a choice
    // the server already holds: written first, and not kept at all when the
    // write fails.
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const snapshot = createConsentSnapshot({
      policy: {
        policyVersion: "v1",
        requireOptInForAdsMeasurement: true,
        requireOptInForProductAnalytics: true,
      },
      decisions: { product_analytics: true, ads_measurement: false },
      source: "banner",
    });

    let keptWhenRecorded: number | undefined;
    await saveConsentDecision({
      storage,
      snapshot,
      persistAppendOnly: async () => {
        keptWhenRecorded = values.size;
      },
    });
    expect(keptWhenRecorded).toBe(0);
    expect([...values.values()][0]).toContain('"ads_measurement":false');

    values.clear();
    await expect(
      saveConsentDecision({
        storage,
        snapshot,
        persistAppendOnly: async () => {
          throw new Error("consent_not_recorded");
        },
      }),
    ).rejects.toThrow("consent_not_recorded");
    expect(values.size).toBe(0);
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

  it("bounds exponential retry and dead-letters after the 24h window", () => {
    expect(retryDelayMs(1)).toBe(1_000);
    expect(retryDelayMs(17)).toBe(65_536_000);
    expect(retryDelayMs(30)).toBe(86_400_000);
    expect(shouldDeadLetter(16)).toBe(false);
    expect(shouldDeadLetter(17)).toBe(true);
  });
});

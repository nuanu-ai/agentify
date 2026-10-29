// @vitest-environment jsdom

import {
  CONSENT_POLICY_VERSION,
  CONSENT_STORAGE_KEY,
  createConsentSnapshot,
} from "@agentify/analytics/browser";
import { type BrowserAnalyticsConfig, CONSENT_CHANGED_EVENT } from "@agentify/consent";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LANDING_SEGMENT_ATTRIBUTE, LANDING_VARIANT_ATTRIBUTE } from "../lib/landing-announcement";
import { onSite } from "../testing/on-site";
import { AnalyticsRuntime } from "./analytics-runtime";

const config: BrowserAnalyticsConfig = {
  runtimeEnvironment: "test",
  posthog: { key: null, host: null, destinationEnvironment: "test" },
  meta: { pixelId: null, destinationEnvironment: "test" },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});

describe("a visit before and after the visitor's choice", () => {
  it("records the consented landing and campaign, reusing the server event identity", async () => {
    // Nothing of a visit is recorded before a choice, so the first page a
    // visitor allows measurement on would otherwise be the one page whose
    // landing and campaign are never recorded.
    const landing = document.createElement("div");
    landing.setAttribute(LANDING_SEGMENT_ATTRIBUTE, "store");
    landing.setAttribute(LANDING_VARIANT_ATTRIBUTE, "store-v1");
    document.body.append(landing);
    window.history.replaceState({}, "", "/store?utm_source=merchant&utm_campaign=autumn");
    const asked: { path: string; method: string; body: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      asked.push({
        path,
        method: init?.method ?? "GET",
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return path === "/api/v1/events"
        ? new Response(
            JSON.stringify({
              status: "recorded",
              event_id: "01990000-0000-7000-8000-000000000001",
              segment: "store",
              landing_variant: "store-v1",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response(null, { status: 204 });
    });

    render(onSite(<AnalyticsRuntime config={config} />));
    await act(async () => {
      await Promise.resolve();
    });
    expect(asked).toEqual([]);

    const allowed = createConsentSnapshot({
      policyVersion: CONSENT_POLICY_VERSION,
      decisions: { product_analytics: true },
      source: "banner",
    });
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(allowed));
    window.dispatchEvent(new CustomEvent(CONSENT_CHANGED_EVENT, { detail: allowed }));

    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[0]).toEqual({
      path: "/api/v1/attribution",
      method: "POST",
      body: {
        segment: "store",
        landing_variant: "store-v1",
        touch: { utm_source: "merchant", utm_campaign: "autumn" },
      },
    });
    expect(asked[1]).toMatchObject({
      path: "/api/v1/events",
      method: "POST",
      body: { name: "landing_view", segment: "store", landing_variant: "store-v1", properties: {} },
    });
    window.dispatchEvent(new CustomEvent(CONSENT_CHANGED_EVENT, { detail: allowed }));
    await waitFor(() => expect(asked).toHaveLength(3));
    expect(asked[2]).toMatchObject({
      path: "/api/v1/events",
      body: {
        event_id: "01990000-0000-7000-8000-000000000001",
        name: "landing_view",
        segment: "store",
        landing_variant: "store-v1",
      },
    });
  });
});

describe("a choice withdrawn in another tab while an event is being recorded", () => {
  const POSTHOG_HOST = "https://posthog.agentify.invalid";
  const measured: BrowserAnalyticsConfig = {
    ...config,
    posthog: { key: "phc_test_key", host: POSTHOG_HOST, destinationEnvironment: "test" },
  };
  const choice = (productAnalytics: boolean) =>
    createConsentSnapshot({
      policyVersion: CONSENT_POLICY_VERSION,
      decisions: { product_analytics: productAnalytics },
      source: "banner",
    });

  // PostHog keeps the `fetch` it found when it started, so one recorder
  // stands for the whole block rather than one per test.
  const asked: string[] = [];
  let whileRecording = () => {};
  const original = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      if (new URL(url, "http://localhost").pathname !== "/api/v1/events") {
        return Response.json({ status: 1 });
      }
      whileRecording();
      return Response.json({
        status: "recorded",
        event_id: "01990000-0000-7000-8000-000000000002",
        segment: "store",
        landing_variant: "store-v1",
      });
    };
  });
  afterAll(() => {
    globalThis.fetch = original;
  });

  const landOnStore = () => {
    const landing = document.createElement("div");
    landing.setAttribute(LANDING_SEGMENT_ATTRIBUTE, "store");
    landing.setAttribute(LANDING_VARIANT_ATTRIBUTE, "store-v1");
    document.body.append(landing);
    window.history.replaceState({}, "", "/store");
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(choice(true)));
  };

  /**
   * Well past the few seconds PostHog holds a capture before it sends its
   * batch, which it offers no way to hurry, so a loaded machine still sends it
   * in time.
   */
  const PAST_POSTHOG_BATCH_MS = 10_000;
  const toPosthog = (from: number) =>
    asked.slice(from).filter((url) => url.startsWith(POSTHOG_HOST));

  it("is not sent to PostHog by this tab", async () => {
    landOnStore();
    whileRecording = () => localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(choice(false)));
    const from = asked.length;

    render(onSite(<AnalyticsRuntime config={measured} />));
    await waitFor(() => expect(asked.slice(from)).toContain("/api/v1/events"));
    await new Promise((resolve) => setTimeout(resolve, PAST_POSTHOG_BATCH_MS));

    expect(toPosthog(from)).toEqual([]);
  });

  it("leaves the event sent to PostHog where the choice still allows it", async () => {
    landOnStore();
    whileRecording = () => {};
    const from = asked.length;

    render(onSite(<AnalyticsRuntime config={measured} />));

    await waitFor(() => expect(toPosthog(from)).not.toEqual([]), {
      timeout: PAST_POSTHOG_BATCH_MS,
    });
  });
});

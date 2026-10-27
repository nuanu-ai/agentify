// @vitest-environment jsdom

import {
  CONSENT_POLICY_VERSION,
  CONSENT_STORAGE_KEY,
  createConsentSnapshot,
} from "@agentify/analytics/browser";
import { type BrowserAnalyticsConfig, CONSENT_CHANGED_EVENT } from "@agentify/consent";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

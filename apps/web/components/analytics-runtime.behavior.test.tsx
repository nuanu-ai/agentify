// @vitest-environment jsdom

import { CONSENT_STORAGE_KEY, createConsentSnapshot } from "@agentify/analytics/browser";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LANDING_SEGMENT_ATTRIBUTE, LANDING_VARIANT_ATTRIBUTE } from "../lib/landing-announcement";
import { AnalyticsRuntime, type BrowserAnalyticsConfig } from "./analytics-runtime";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

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
});

describe("a visit before and after the visitor's choice", () => {
  it("records the landing and its campaign once the visitor allows measurement on the page they landed on", async () => {
    // Nothing of a visit is recorded before a choice, so the first page a
    // visitor allows measurement on would otherwise be the one page whose
    // landing and campaign are never recorded.
    const landing = document.createElement("div");
    landing.setAttribute(LANDING_SEGMENT_ATTRIBUTE, "store");
    landing.setAttribute(LANDING_VARIANT_ATTRIBUTE, "store-v1");
    document.body.append(landing);
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input), "http://localhost").pathname;
      asked.push(path);
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

    render(<AnalyticsRuntime config={config} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toEqual([]);

    const allowed = createConsentSnapshot({
      policy: {
        policyVersion: "test-policy",
        requireOptInForProductAnalytics: true,
        requireOptInForAdsMeasurement: true,
      },
      decisions: { product_analytics: true },
      source: "banner",
    });
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(allowed));
    window.dispatchEvent(new CustomEvent("agentify:consent-changed", { detail: allowed }));

    await waitFor(() => expect(asked).toEqual(["/api/v1/attribution", "/api/v1/events"]));
  });
});

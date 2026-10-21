// @vitest-environment jsdom

/**
 * Once a visitor allowed ads measurement and the Meta pixel started, what it
 * sends is the page's to decide: it counts no move by itself, and a later
 * choice that turns ads measurement off, here or in another tab, stops it
 * until a choice turns it on again.
 */

import {
  CONSENT_POLICY_VERSION,
  CONSENT_STORAGE_KEY,
  createConsentSnapshot,
} from "@agentify/analytics/browser";
import { afterEach, describe, expect, it } from "vitest";
import { type BrowserAnalyticsConfig, metaPixelOf } from "./destinations.js";
import { CONSENT_CHANGED_EVENT } from "./events.js";

const config: BrowserAnalyticsConfig = {
  runtimeEnvironment: "test",
  posthog: { key: null, host: null, destinationEnvironment: "test" },
  meta: { pixelId: "1234567890", destinationEnvironment: "test" },
};

const choice = (ads: boolean) =>
  createConsentSnapshot({
    policyVersion: CONSENT_POLICY_VERSION,
    decisions: { product_analytics: true, ads_measurement: ads },
    source: "banner",
  });

type Started = { queue: unknown[][]; disablePushState?: boolean };

const started = (): Started => {
  metaPixelOf(config);
  return (window as unknown as { fbq: Started }).fbq;
};

afterEach(() => {
  Reflect.deleteProperty(window, "fbq");
  Reflect.deleteProperty(window, "_fbq");
  window.localStorage.clear();
});

describe("the Meta pixel", () => {
  it("counts no move by itself, so a page's own views are the only ones sent", () => {
    expect(started().disablePushState).toBe(true);
  });

  it("is revoked when the visitor turns ads measurement off and granted when they turn it on", () => {
    const pixel = started();
    window.dispatchEvent(new CustomEvent(CONSENT_CHANGED_EVENT, { detail: choice(false) }));
    expect(pixel.queue.at(-1)).toEqual(["consent", "revoke"]);
    window.dispatchEvent(new CustomEvent(CONSENT_CHANGED_EVENT, { detail: choice(true) }));
    expect(pixel.queue.at(-1)).toEqual(["consent", "grant"]);
  });

  it("is revoked by a withdrawal made in another tab", () => {
    const pixel = started();
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(choice(false)));
    window.dispatchEvent(new StorageEvent("storage", { key: CONSENT_STORAGE_KEY }));
    expect(pixel.queue.at(-1)).toEqual(["consent", "revoke"]);
  });

  it("is not started where the deployment names no pixel for its environment", () => {
    expect(
      metaPixelOf({ ...config, meta: { ...config.meta, destinationEnvironment: "production" } }),
    ).toBeUndefined();
    expect("fbq" in window).toBe(false);
  });
});

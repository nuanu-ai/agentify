import { afterEach, describe, expect, it, vi } from "vitest";

import { captureLandingAttribution } from "./attribution-client";

afterEach(() => vi.unstubAllGlobals());

/** The stored choice of a visitor who allowed product analytics. */
const measured = JSON.stringify({
  policyVersion: "test-policy",
  capturedAt: "2026-10-10T00:00:00.000Z",
  source: "banner",
  categories: { essential_processing: true, product_analytics: true },
});

describe("landing attribution", () => {
  it("retries a transient attribution failure on the next capture", async () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => measured } });
    const provider = { attempts: 0, accepted: false };
    const fetcher = async () => {
      provider.attempts += 1;
      if (provider.attempts === 1) {
        return new Response(null, { status: 503 });
      }
      provider.accepted = true;
      return new Response(null, { status: 204 });
    };
    vi.stubGlobal("fetch", fetcher);
    const source = {
      pathname: "/",
      search: "?utm_campaign=retry-test",
    };

    await captureLandingAttribution("owner", "owner-retry-test", source);
    await captureLandingAttribution("owner", "owner-retry-test", source);

    expect(provider).toEqual({ attempts: 2, accepted: true });
  });
});

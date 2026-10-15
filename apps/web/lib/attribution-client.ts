import { consentAllowsMeasurement, readCurrentConsent } from "@agentify/analytics/browser";
import type { Segment } from "@agentify/scanner-contracts/browser";

const captures = new Map<string, Promise<void>>();

export type AttributionSource = Readonly<{
  pathname: string;
  search: string;
}>;

export function captureLandingAttribution(
  segment: Segment,
  landingVariant: string,
  source: AttributionSource = {
    pathname: window.location.pathname,
    search: window.location.search,
  },
): Promise<void> {
  // Before the visitor allows measurement nothing is sent and nothing is cached
  // as done, so `AnalyticsRuntime` can capture once the choice is made.
  if (!measurementAllowed()) return Promise.resolve();
  const key = `${source.pathname}?${source.search}:${landingVariant}`;
  const existing = captures.get(key);
  if (existing) return existing;
  const capture = persist(segment, landingVariant, source.search).catch(() => {
    captures.delete(key);
  });
  captures.set(key, capture);
  return capture;
}

function measurementAllowed(): boolean {
  try {
    const categories = readCurrentConsent(window.localStorage)?.categories;
    return categories !== undefined && consentAllowsMeasurement(categories);
  } catch {
    return false;
  }
}

async function persist(segment: Segment, landingVariant: string, sourceSearch: string) {
  const query = new URLSearchParams(sourceSearch);
  const touch: Record<string, string> = {};
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
    const value = query.get(key);
    if (value) touch[key] = value.slice(0, 100);
  }
  const fbclid = query.get("fbclid");
  if (fbclid && fbclid.length <= 1024) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fbclid));
    touch.fbclid_hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  const response = await fetch("/api/v1/attribution", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segment, landing_variant: landingVariant, touch }),
  });
  if (!response.ok) throw new Error("attribution_capture_failed");
}

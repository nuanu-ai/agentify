import { readCurrentConsent } from "@b2a/analytics/browser";
import {
  PARTNER_CLICK_ID_ALIASES,
  partnerClickIdSchema,
  type Segment,
} from "@b2a/contracts";

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
  const partnerClickId = adsMeasurementAllowed()
    ? readPartnerClickId(source.search)
    : undefined;
  const key = `${source.pathname}?${source.search}:${landingVariant}:partner=${partnerClickId ? "yes" : "no"}`;
  const existing = captures.get(key);
  if (existing) return existing;
  const capture = persist(
    segment,
    landingVariant,
    source.search,
    partnerClickId,
  ).catch(() => {
    captures.delete(key);
  });
  captures.set(key, capture);
  return capture;
}

export function readPartnerClickId(search: string): string | undefined {
  const query = new URLSearchParams(search);
  for (const alias of PARTNER_CLICK_ID_ALIASES) {
    for (const value of query.getAll(alias)) {
      if (!value) continue;
      const parsed = partnerClickIdSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    }
  }
  return undefined;
}

function adsMeasurementAllowed(): boolean {
  try {
    return (
      readCurrentConsent(window.localStorage)?.categories.ads_measurement ===
      true
    );
  } catch {
    return false;
  }
}

async function persist(
  segment: Segment,
  landingVariant: string,
  sourceSearch: string,
  partnerClickId?: string,
) {
  const query = new URLSearchParams(sourceSearch);
  const touch: Record<string, string> = {};
  for (const key of [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
  ]) {
    const value = query.get(key);
    if (value) touch[key] = value.slice(0, 100);
  }
  const fbclid = query.get("fbclid");
  if (fbclid && fbclid.length <= 1024) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(fbclid),
    );
    touch.fbclid_hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  const response = await fetch("/api/v1/attribution", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      segment,
      landing_variant: landingVariant,
      touch,
      ...(partnerClickId ? { partner_click_id: partnerClickId } : {}),
    }),
  });
  if (!response.ok) throw new Error("attribution_capture_failed");
}

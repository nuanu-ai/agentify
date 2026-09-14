import { createHash } from "node:crypto";

export type AttributionTouch = {
  landingVariant?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  fbclidHash?: string;
};

export type AttributionState = {
  first: AttributionTouch;
  last: AttributionTouch;
};

const clean = (value: string | null): string | undefined => {
  const normalized = value?.trim().slice(0, 200);
  return normalized || undefined;
};

export const readAttributionTouch = (
  params: Pick<URLSearchParams, "get">,
  landingVariant: string,
): AttributionTouch => {
  const fbclid = clean(params.get("fbclid"));
  return {
    landingVariant: clean(landingVariant),
    utmSource: clean(params.get("utm_source")),
    utmMedium: clean(params.get("utm_medium")),
    utmCampaign: clean(params.get("utm_campaign")),
    utmContent: clean(params.get("utm_content")),
    utmTerm: clean(params.get("utm_term")),
    ...(fbclid
      ? { fbclidHash: createHash("sha256").update(fbclid).digest("hex") }
      : {}),
  };
};

export const updateAttribution = (
  previous: AttributionState | undefined,
  current: AttributionTouch,
): AttributionState => ({
  first: previous?.first ?? current,
  last: current,
});

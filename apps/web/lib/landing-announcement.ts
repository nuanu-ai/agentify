import { isSegment, type Segment } from "@agentify/scanner-contracts/browser";

/**
 * A landing page renders its segment and variant as attributes on itself, and
 * the analytics runtime records a landing view for exactly that, never for
 * anything derived from the path. An unknown segment or a missing variant is
 * no announcement: nothing is recorded rather than something invented.
 */
export const LANDING_SEGMENT_ATTRIBUTE = "data-agentify-landing-segment";
export const LANDING_VARIANT_ATTRIBUTE = "data-agentify-landing-variant";

export type LandingAnnouncement = Readonly<{
  segment: Segment;
  variant: string;
}>;

type AnnouncingElement = Readonly<{
  getAttribute(name: string): string | null;
}>;

export function readLandingAnnouncement(
  root: Readonly<{
    querySelector(selector: string): AnnouncingElement | null;
  }>,
): LandingAnnouncement | null {
  const element = root.querySelector(`[${LANDING_SEGMENT_ATTRIBUTE}]`);
  if (!element) return null;
  const segment = element.getAttribute(LANDING_SEGMENT_ATTRIBUTE);
  const variant = element.getAttribute(LANDING_VARIANT_ATTRIBUTE);
  if (!isSegment(segment) || !variant) return null;
  return { segment, variant };
}

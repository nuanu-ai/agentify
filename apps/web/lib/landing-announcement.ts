import { type Segment, segmentSchema } from "@agentify/scanner-contracts";

/**
 * A landing page says what it is; the analytics runtime reads it.
 *
 * The runtime used to match the path against the three segment addresses
 * and derive the variant's name from the segment a second time, beside the
 * variant the landing configuration already carried. The day the front page
 * became a landing that would have made `/` the one page absent from the
 * numbers. So the page renders these two attributes on itself, the same way
 * the report page announces the scan it shows, and the runtime records a
 * landing view for exactly what the page announced. A segment the product
 * does not know, or a missing variant, is no announcement at all: nothing
 * is recorded, rather than something invented.
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
  const segment = segmentSchema.safeParse(
    element.getAttribute(LANDING_SEGMENT_ATTRIBUTE),
  );
  const variant = element.getAttribute(LANDING_VARIANT_ATTRIBUTE);
  if (!segment.success || !variant) return null;
  return { segment: segment.data, variant };
}

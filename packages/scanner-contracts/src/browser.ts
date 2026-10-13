/**
 * The vocabulary a page's own script needs, with no schema library behind it:
 * importing anything from the package's main entry evaluates every schema in
 * it, and that ships the whole of zod to the browser. The schemas in the main
 * entry are built from these values, so the two cannot drift.
 */

export const SEGMENTS = ["store", "owner", "local"] as const;

export type Segment = (typeof SEGMENTS)[number];

export const isSegment = (value: unknown): value is Segment =>
  SEGMENTS.some((segment) => segment === value);

/** The query parameters a partner network puts its click identifier in. */
export const PARTNER_CLICK_ID_ALIASES = ["clickid", "click_id", "cid", "sub_id", "subid"] as const;

export const PARTNER_CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

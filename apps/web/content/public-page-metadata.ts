export const PUBLIC_PAGE_PATHS = [
  "/owner",
  "/store",
  "/local",
  "/methodology",
  "/scanner",
  "/privacy",
  "/terms",
] as const;

export type PublicPagePath = (typeof PUBLIC_PAGE_PATHS)[number];

export type PublicPageMetadata = Readonly<{
  lastModified: `${number}-${number}-${number}`;
  priority: number;
}>;

// These dates describe visible content revisions, not deployments. Update only
// when the corresponding public page content changes.
export const PUBLIC_PAGE_METADATA = {
  "/owner": { lastModified: "2026-09-21", priority: 1 },
  "/store": { lastModified: "2026-09-21", priority: 0.9 },
  "/local": { lastModified: "2026-09-21", priority: 0.9 },
  "/methodology": { lastModified: "2026-09-21", priority: 0.8 },
  "/scanner": { lastModified: "2026-07-13", priority: 0.8 },
  "/privacy": { lastModified: "2026-07-14", priority: 0.6 },
  "/terms": { lastModified: "2026-07-13", priority: 0.6 },
} as const satisfies Record<PublicPagePath, PublicPageMetadata>;

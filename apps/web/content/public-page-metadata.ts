export const PUBLIC_PAGE_PATHS = ["/", "/store", "/local", "/privacy", "/terms"] as const;

export type PublicPagePath = (typeof PUBLIC_PAGE_PATHS)[number];

/**
 * Every page that is the same for everybody: a shared cache may keep it, a
 * client may ask for it as Markdown and a link to it is fetched ahead of a
 * click. The public pages above, which the sitemap dates below and llms.txt
 * lists as such, and the page about selling to agents, which both name apart.
 */
export const KEPT_PAGE_PATHS = [...PUBLIC_PAGE_PATHS, "/agentic-shop"] as const;

export type KeptPagePath = (typeof KEPT_PAGE_PATHS)[number];

export type PublicPageMetadata = Readonly<{
  lastModified: `${number}-${number}-${number}`;
  priority: number;
}>;

// These dates describe visible content revisions, not deployments. Update only
// when the corresponding public page content changes.
export const PUBLIC_PAGE_METADATA = {
  "/": { lastModified: "2026-09-21", priority: 1 },
  "/store": { lastModified: "2026-10-19", priority: 0.9 },
  "/local": { lastModified: "2026-10-19", priority: 0.9 },
  "/privacy": { lastModified: "2026-10-15", priority: 0.6 },
  "/terms": { lastModified: "2026-07-13", priority: 0.6 },
} as const satisfies Record<PublicPagePath, PublicPageMetadata>;

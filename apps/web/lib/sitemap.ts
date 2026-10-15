import { DOCS_PAGES, docsAddress } from "@agentify/ui/docs";
import { PUBLIC_PAGE_METADATA, PUBLIC_PAGE_PATHS } from "../content/public-page-metadata";
import { getPublicAppConfig } from "./app-config";

type Entry = Readonly<{ path: string; lastModified?: string; priority: number }>;

/** Written when the page about selling to agents last changed, as the public pages' dates are. */
const SELL_TO_AGENTS: Entry = { path: "/agentic-shop", lastModified: "2026-09-09", priority: 0.9 };

/**
 * Every page of the documentation, the scanner's own among them, in the order
 * its contents list them. Their text is the documentation's Markdown, which
 * changes without this file, so they name no date rather than one that could
 * be wrong.
 */
const DOCUMENTATION: readonly Entry[] = DOCS_PAGES.map((page) => ({
  path: docsAddress(page.path),
  priority: 0.8,
}));

/**
 * The pages a crawler is invited to list, as a sitemap: every public page,
 * the one about selling to agents, then every page of the documentation.
 */
export function buildSitemap(): string {
  const { baseUrl } = getPublicAppConfig();
  const entries: Entry[] = [
    ...PUBLIC_PAGE_PATHS.map((path) => ({ path, ...PUBLIC_PAGE_METADATA[path] })),
    SELL_TO_AGENTS,
    ...DOCUMENTATION,
  ];
  const urls = entries.map(
    ({ path, lastModified, priority }) =>
      `<url>\n<loc>${new URL(path, baseUrl).toString()}</loc>\n${lastModified === undefined ? "" : `<lastmod>${lastModified}</lastmod>\n`}<changefreq>weekly</changefreq>\n<priority>${priority}</priority>\n</url>\n`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("")}</urlset>\n`;
}

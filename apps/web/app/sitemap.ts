import type { MetadataRoute } from "next";

import {
  PUBLIC_PAGE_METADATA,
  PUBLIC_PAGE_PATHS,
} from "../content/public-page-metadata";
import { getPublicAppConfig } from "../lib/app-config";

export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const { baseUrl } = getPublicAppConfig();
  const existing: MetadataRoute.Sitemap = PUBLIC_PAGE_PATHS.map((path) => ({
    url: new URL(path, baseUrl).toString(),
    lastModified: PUBLIC_PAGE_METADATA[path].lastModified,
    changeFrequency: "weekly",
    priority: PUBLIC_PAGE_METADATA[path].priority,
  }));
  return [
    ...existing,
    {
      url: new URL("/agentic-shop", baseUrl).toString(),
      lastModified: "2026-09-09",
      changeFrequency: "weekly",
      priority: 0.9,
    },
  ];
}

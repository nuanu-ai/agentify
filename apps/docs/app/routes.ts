import { index, type RouteConfig, route } from "@react-router/dev/routes";

/**
 * Every page is one route drawing the Markdown its address names in
 * `pages.ts`; the search index is written beside them as a file.
 */
export default [
  route("search-index.json", "routes/search-index.ts"),
  // The splat does not match the bare mount point, so the front page is named.
  index("routes/page.tsx", { id: "front" }),
  route("*", "routes/page.tsx"),
] satisfies RouteConfig;

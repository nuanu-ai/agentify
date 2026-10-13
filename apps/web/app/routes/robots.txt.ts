import { buildRobotsPolicy } from "../../lib/robots-policy";
import { methods } from "../../lib/server/methods";

/** What the site allows crawlers, and where its sitemap is. */
export const loader = methods({
  GET: () =>
    new Response(buildRobotsPolicy(), {
      headers: {
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
        "Content-Type": "text/plain; charset=utf-8",
      },
    }),
});
export const action = loader;

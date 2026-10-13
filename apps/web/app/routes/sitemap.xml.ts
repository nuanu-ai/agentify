import { methods } from "../../lib/server/methods";
import { buildSitemap } from "../../lib/sitemap";

/** The pages a crawler is invited to list. */
export const loader = methods({
  GET: () =>
    new Response(buildSitemap(), {
      headers: {
        "Content-Type": "application/xml",
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    }),
});
export const action = loader;

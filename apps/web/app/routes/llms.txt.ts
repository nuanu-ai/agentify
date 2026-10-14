import { buildLlmsText } from "../../lib/llms";
import { methods } from "../../lib/server/methods";

/** The site's public pages, introduced for a language model reading it. */
export const loader = methods({
  GET: () =>
    new Response(buildLlmsText(), {
      headers: {
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
        "Content-Type": "text/plain; charset=utf-8",
      },
    }),
});
export const action = loader;

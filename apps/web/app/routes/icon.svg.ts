import { methods } from "../../lib/server/methods";
import icon from "./icon.svg?raw";

/** The site's icon for a browser's tab, the brand's mark. */
export const loader = methods({
  GET: () =>
    new Response(icon, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    }),
});
export const action = loader;

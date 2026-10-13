import { getPublicAppConfig } from "../../lib/app-config";
import { methods } from "../../lib/server/methods";

/** What a browser needs to keep the site as an app: its names, colours and icon. */
export const loader = methods({
  GET: () => {
    const { displayBrand } = getPublicAppConfig();
    const manifest = {
      name: `${displayBrand} website diagnostic`,
      short_name: displayBrand,
      description:
        "A public-HTTP diagnostic showing what your website makes readable to AI agents.",
      start_url: "/",
      display: "standalone",
      background_color: "#F6F4EF",
      theme_color: "#0F736E",
      icons: [
        { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
      ],
    };
    return new Response(JSON.stringify(manifest), {
      headers: {
        "Content-Type": "application/manifest+json",
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    });
  },
});
export const action = loader;

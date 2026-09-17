import type { MetadataRoute } from "next";

import { getPublicAppConfig } from "../lib/app-config";

export const dynamic = "force-dynamic";

export default function manifest(): MetadataRoute.Manifest {
  const { displayBrand } = getPublicAppConfig();
  return {
    name: `${displayBrand} website diagnostic`,
    short_name: displayBrand,
    description:
      "A public-HTTP diagnostic showing what your website makes readable to AI agents.",
    start_url: "/owner",
    display: "standalone",
    background_color: "#F6F4EF",
    theme_color: "#0F736E",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}

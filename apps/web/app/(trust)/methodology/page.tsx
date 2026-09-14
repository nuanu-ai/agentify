import type { Metadata } from "next";

import { PublicEditorialPage } from "../../../components/public-editorial-page";
import { getPublicEditorialPage } from "../../../content/public-editorial";
import { getPublicAppConfig } from "../../../lib/app-config";

export function generateMetadata(): Metadata {
  const { displayBrand } = getPublicAppConfig();
  return {
    title: "Methodology",
    description: `How the ${displayBrand} public-HTTP agent-readiness diagnostic works and its limits.`,
    alternates: { canonical: "/methodology" },
  };
}

export default function MethodologyPage() {
  const config = getPublicAppConfig();
  return (
    <PublicEditorialPage
      page={getPublicEditorialPage("/methodology", config)}
    />
  );
}

import type { Metadata } from "next";

import { PublicEditorialPage } from "../../../components/public-editorial-page";
import { getPublicEditorialPage } from "../../../content/public-editorial";
import { getPublicAppConfig } from "../../../lib/app-config";

export function generateMetadata(): Metadata {
  const { displayBrand } = getPublicAppConfig();
  return {
    title: "Privacy",
    description: `Privacy, retention, consent, processors, and data-control information for ${displayBrand}.`,
    alternates: { canonical: "/privacy" },
  };
}

export default function PrivacyPage() {
  const config = getPublicAppConfig();
  return (
    <PublicEditorialPage page={getPublicEditorialPage("/privacy", config)} />
  );
}

import type { Metadata } from "next";

import { PublicEditorialPage } from "../../../components/public-editorial-page";
import { getPublicEditorialPage } from "../../../content/public-editorial";
import { getPublicAppConfig } from "../../../lib/app-config";

export const metadata: Metadata = {
  title: "Terms",
  robots: { index: true, follow: true },
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  const config = getPublicAppConfig();
  return (
    <PublicEditorialPage page={getPublicEditorialPage("/terms", config)} />
  );
}

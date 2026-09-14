import type { Metadata } from "next";

import { PublicEditorialPage } from "../../../components/public-editorial-page";
import { getPublicEditorialPage } from "../../../content/public-editorial";
import { getPublicAppConfig } from "../../../lib/app-config";

export const metadata: Metadata = {
  title: "Scanner identity",
  description:
    "Identity, behavior, safety limits, retention, and opt-out details for agentify-scanner.",
  alternates: { canonical: "/scanner" },
};

export default function ScannerPage() {
  const config = getPublicAppConfig();
  return (
    <PublicEditorialPage page={getPublicEditorialPage("/scanner", config)} />
  );
}

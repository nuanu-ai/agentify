import { type MetaArgs, useLoaderData } from "react-router";

import { PublicEditorialPage } from "../../components/public-editorial-page";
import { getPublicEditorialPage } from "../../content/public-editorial";
import { getPublicAppConfig } from "../../lib/app-config";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";

export const loader = () => getPublicEditorialPage("/scanner", getPublicAppConfig());

export const meta = ({ matches }: MetaArgs) =>
  pageMeta(siteConfigOf(matches), {
    title: "Scanner identity",
    description:
      "Identity, behavior, safety limits, retention, and opt-out details for agentify-scanner.",
    canonical: "/scanner",
  });

export default function ScannerPage() {
  return <PublicEditorialPage page={useLoaderData<typeof loader>()} />;
}

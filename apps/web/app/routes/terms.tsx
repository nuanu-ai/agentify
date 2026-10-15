import { type MetaArgs, useLoaderData } from "react-router";

import { PublicEditorialPage } from "../../components/public-editorial-page";
import { getPublicEditorialPage } from "../../content/public-editorial";
import { getPublicAppConfig } from "../../lib/app-config";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";

export const loader = () => getPublicEditorialPage("/terms", getPublicAppConfig());

export const meta = ({ matches }: MetaArgs) =>
  pageMeta(siteConfigOf(matches), {
    title: "Terms",
    description:
      "Terms for Agentify's website diagnostic: acceptable use, service scope, availability limits, and what a diagnostic result does not guarantee.",
    canonical: "/terms",
    robots: "index, follow",
  });

export default function TermsPage() {
  return <PublicEditorialPage page={useLoaderData<typeof loader>()} />;
}

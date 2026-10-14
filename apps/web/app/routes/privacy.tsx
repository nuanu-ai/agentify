import { type MetaArgs, useLoaderData } from "react-router";

import { PublicEditorialPage } from "../../components/public-editorial-page";
import { getPublicEditorialPage } from "../../content/public-editorial";
import { getPublicAppConfig } from "../../lib/app-config";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";

export const loader = () => getPublicEditorialPage("/privacy", getPublicAppConfig());

export const meta = ({ matches }: MetaArgs) => {
  const config = siteConfigOf(matches);
  return pageMeta(config, {
    title: "Privacy",
    description: `Privacy, retention, consent, processors, and data-control information for ${config.displayBrand}.`,
    canonical: "/privacy",
  });
};

export default function PrivacyPage() {
  return <PublicEditorialPage page={useLoaderData<typeof loader>()} />;
}

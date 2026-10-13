import { type MetaArgs, useLoaderData } from "react-router";

import { PublicEditorialPage } from "../../components/public-editorial-page";
import { getPublicEditorialPage } from "../../content/public-editorial";
import { getPublicAppConfig } from "../../lib/app-config";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";

export const loader = () => getPublicEditorialPage("/methodology", getPublicAppConfig());

export const meta = ({ matches }: MetaArgs) => {
  const config = siteConfigOf(matches);
  return pageMeta(config, {
    title: "Methodology",
    description: `How the ${config.displayBrand} public-HTTP agent-readiness diagnostic works and its limits.`,
    canonical: "/methodology",
  });
};

export default function MethodologyPage() {
  return <PublicEditorialPage page={useLoaderData<typeof loader>()} />;
}

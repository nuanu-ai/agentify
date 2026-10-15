import { type MetaArgs, useLoaderData } from "react-router";

import { LandingPage } from "../../components/landing-page";
import { LANDINGS } from "../../content/landing";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";

export const loader = () => LANDINGS.store;

export const meta = ({ matches }: MetaArgs) =>
  pageMeta(siteConfigOf(matches), {
    title: "Agent-readiness diagnostic for online stores",
    description:
      "Check your store's public products, prices and stock for AI agents. Get diagnostic findings without placing orders or testing checkout.",
    canonical: "/store",
  });

export default function StorePage() {
  return <LandingPage config={useLoaderData<typeof loader>()} />;
}

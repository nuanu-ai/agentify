import { type MetaArgs, useLoaderData } from "react-router";

import { LandingPage } from "../../components/landing-page";
import { LANDINGS } from "../../content/landing";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";

export const loader = () => LANDINGS.local;

export const meta = ({ matches }: MetaArgs) =>
  pageMeta(siteConfigOf(matches), {
    title: "Website diagnostic for local businesses",
    description:
      "Check your public business information, services, opening hours and booking links for AI agents. No bookings or availability tests.",
    canonical: "/local",
  });

export default function LocalPage() {
  return <LandingPage config={useLoaderData<typeof loader>()} />;
}

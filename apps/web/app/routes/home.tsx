import { type MetaArgs, useLoaderData } from "react-router";

import { LandingPage } from "../../components/landing-page";
import { LANDINGS } from "../../content/landing";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";

/** The front page is the owner landing; `/owner` redirects here. */
export const loader = () => LANDINGS.owner;

export const meta = ({ matches }: MetaArgs) =>
  pageMeta(siteConfigOf(matches), {
    title: "What your website shows to AI agents, and how to sell to them",
    titleAlone: true,
    description:
      "Check what your public website exposes to AI agents, see diagnostic findings, and learn how selling through Agentify works.",
    canonical: "/",
  });

export default function HomePage() {
  return <LandingPage config={useLoaderData<typeof loader>()} />;
}

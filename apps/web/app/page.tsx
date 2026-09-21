import type { Metadata } from "next";

import { LandingPage } from "../components/landing-page";
import { LANDINGS } from "../content/landing";

export const metadata: Metadata = {
  title: "What your website shows to AI agents, and how to sell to them",
  alternates: { canonical: "/" },
};

/**
 * The front page is the owner landing. It has been since `/` redirected to
 * `/owner`; what changed is that it now renders here, with a hero that names
 * both things the site does (docs/research/31-user-journey.md §2). `/owner`
 * keeps answering, as a redirect to this page, for the links already shared.
 */
export default function HomePage() {
  return <LandingPage config={LANDINGS.owner} />;
}

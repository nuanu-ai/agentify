import type { Metadata } from "next";

import { LandingPage } from "../components/landing-page";
import { LANDINGS } from "../content/landing";

export const metadata: Metadata = {
  title: "What your website shows to AI agents, and how to sell to them",
  alternates: { canonical: "/" },
};

/** The front page is the owner landing; `/owner` redirects here. */
export default function HomePage() {
  return <LandingPage config={LANDINGS.owner} />;
}

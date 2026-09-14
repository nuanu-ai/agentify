import type { Metadata } from "next";

import { LandingPage } from "../../../components/landing-page";
import { LANDINGS } from "../../../content/landing";

export const metadata: Metadata = {
  title: "Agent-readiness diagnostic for online stores",
  alternates: { canonical: "/store" },
};

export default function StorePage() {
  return <LandingPage config={LANDINGS.store} />;
}

import type { Metadata } from "next";

import { LandingPage } from "../../../components/landing-page";
import { LANDINGS } from "../../../content/landing";

export const metadata: Metadata = {
  title: "Website diagnostic for local businesses",
  alternates: { canonical: "/local" },
};

export default function LocalPage() {
  return <LandingPage config={LANDINGS.local} />;
}

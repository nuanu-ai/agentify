import type { Metadata } from "next";

import { LandingPage } from "../../../components/landing-page";
import { LANDINGS } from "../../../content/landing";

export const metadata: Metadata = {
  title: "Website diagnostic for business owners",
  alternates: { canonical: "/owner" },
};

export default function OwnerPage() {
  return <LandingPage config={LANDINGS.owner} />;
}

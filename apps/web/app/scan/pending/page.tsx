import type { Metadata } from "next";

import { PendingScanExperience } from "../../../components/pending-scan-experience";

export const metadata: Metadata = {
  title: "Starting private scan",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function PendingScanPage() {
  return <PendingScanExperience />;
}

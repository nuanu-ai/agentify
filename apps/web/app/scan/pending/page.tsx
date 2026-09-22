import type { Metadata } from "next";

import { PendingScanExperience } from "../../../components/pending-scan-experience";
import { getServerConfig } from "../../../lib/server/config";

export const metadata: Metadata = {
  title: "Starting private scan",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function PendingScanPage() {
  const config = getServerConfig();
  return <PendingScanExperience turnstileSiteKey={config.TURNSTILE_SITE_KEY ?? null} />;
}

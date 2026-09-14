import type { Metadata } from "next";

import { segmentSchema } from "@agentify/scanner-contracts";

import { ScanExperience } from "../../../components/scan-experience";
import { getServerConfig } from "../../../lib/server/config";

export const metadata: Metadata = {
  title: "Private scan progress",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ScanPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fixture?: string; segment?: string }>;
}>) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const segmentResult = segmentSchema.safeParse(query.segment);
  const config = getServerConfig();

  return (
    <ScanExperience
      browserObservationsEnabled={config.APIFY_BROWSER_MODE === "report"}
      fixture={query.fixture}
      publicShareEnabled={config.PUBLIC_SHARE_ENABLED}
      remediationPromptEnabled={config.REMEDIATION_PROMPT_ENABLED}
      registrationEnabled={
        process.env.NEXT_PUBLIC_REGISTRATION_ENABLED !== "false"
      }
      scanId={id}
      segment={segmentResult.success ? segmentResult.data : "owner"}
    />
  );
}

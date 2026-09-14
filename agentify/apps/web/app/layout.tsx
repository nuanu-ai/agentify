import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/schibsted-grotesk/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./globals.css";
import { ConsentBanner } from "../components/consent-banner";
import { AnalyticsRuntime } from "../components/analytics-runtime";
import { getPublicAppConfig } from "../lib/app-config";

export function generateMetadata(): Metadata {
  const config = getPublicAppConfig();
  return {
    metadataBase: new URL(config.baseUrl),
    title: {
      default: `${config.displayBrand} — website agent-readiness diagnostic`,
      template: `%s · ${config.displayBrand}`,
    },
    description:
      "A public-HTTP diagnostic showing what your website makes readable to AI agents.",
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en-US">
      <body>
        {children}
        <AnalyticsRuntime />
        <ConsentBanner />
      </body>
    </html>
  );
}

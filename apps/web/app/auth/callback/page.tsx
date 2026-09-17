import type { Metadata } from "next";

import { AuthCallback } from "../../../components/auth-callback";
import { getServerConfig } from "../../../lib/server/config";

export const metadata: Metadata = {
  title: "Confirming your Agentify registration",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function AuthCallbackPage() {
  const config = getServerConfig();
  return (
    <AuthCallback
      turnstileSiteKey={
        config.TURNSTILE_ENFORCED ? (config.TURNSTILE_SITE_KEY ?? null) : null
      }
    />
  );
}

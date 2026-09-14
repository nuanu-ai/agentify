import type { Metadata } from "next";

import { AuthCallback } from "../../../components/auth-callback";

export const metadata: Metadata = {
  title: "Confirming your Agentify registration",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function AuthCallbackPage() {
  return <AuthCallback />;
}

import { type MetaArgs, useLoaderData } from "react-router";

import { PendingScanExperience } from "../../components/pending-scan-experience";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";
import { getServerConfig } from "../../lib/server/config";

/**
 * Where the scan form hands its request over: the page sends it, with the
 * challenge where the scanner asks for one, and goes on to the scan once it is
 * accepted. The request itself waits in the browser's session storage.
 */
export const loader = () => ({ turnstileSiteKey: getServerConfig().TURNSTILE_SITE_KEY ?? null });

export const meta = ({ matches }: MetaArgs) =>
  pageMeta(siteConfigOf(matches), {
    title: "Starting private scan",
    robots: "noindex, nofollow",
    referrer: "no-referrer",
  });

export default function PendingScanRoute() {
  return (
    <PendingScanExperience turnstileSiteKey={useLoaderData<typeof loader>().turnstileSiteKey} />
  );
}

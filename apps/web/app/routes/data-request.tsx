import type { MetaArgs } from "react-router";

import { AccountActions } from "../../components/account-actions";
import { usePublicConfig } from "../../components/public-config";
import { SiteFooter, SiteHeader } from "../../components/site-chrome";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";

export const meta = ({ matches }: MetaArgs) =>
  pageMeta(siteConfigOf(matches), {
    title: "Data request",
    robots: "noindex, nofollow",
    referrer: "no-referrer",
  });

/**
 * Asking for the data held about your own address, or for its deletion. What
 * each request covers is on the privacy page; anything the buttons do not
 * cover goes by email, which never carries a scan's private link.
 */
export default function DataRequestPage() {
  const config = usePublicConfig();
  const subject = encodeURIComponent(`${config.displayBrand} data request`);
  return (
    <>
      <SiteHeader />
      <main className="message-page" id="main">
        <section className="message-panel">
          <h1>Request access or deletion</h1>
          <p>
            Ask for a copy of the data held for your address, or have it deleted.{" "}
            <a href="/privacy#rights">What each request covers</a>
          </p>
          <AccountActions mode="data" />
          <p>
            For a correction or anything else, email{" "}
            <a href={`mailto:${config.privacyEmail}?subject=${subject}`}>{config.privacyEmail}</a>{" "}
            from the address your reports were sent to. Leave out private links and passwords.
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

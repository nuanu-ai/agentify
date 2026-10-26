import type { MetaArgs } from "react-router";

import { AccountActions } from "../../components/account-actions";
import { SiteFooter, SiteHeader, Trail } from "../../components/site-chrome";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";

export const meta = ({ matches }: MetaArgs) =>
  pageMeta(siteConfigOf(matches), { title: "Email preferences", robots: "noindex, nofollow" });

export default function EmailPreferencesPage() {
  return (
    <>
      <SiteHeader />
      <main className="message-page" id="main">
        <section className="message-panel">
          <Trail parent={["Privacy", "/privacy"]} page="Email preferences" />
          <h1>Email preferences</h1>
          <p>
            Stop optional marketing email. Sign-in, report and data-request emails still arrive when
            they are needed.
          </p>
          <AccountActions mode="unsubscribe" />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

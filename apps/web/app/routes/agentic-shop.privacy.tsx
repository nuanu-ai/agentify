import {
  MERCHANT_APPLICATION_POLICY,
  MERCHANT_APPLICATION_RETENTION_DAYS,
} from "@agentify/scanner-contracts";
import { type MetaArgs, useLoaderData } from "react-router";

import { usePublicConfig } from "../../components/public-config";
import { SiteFooter, SiteHeader } from "../../components/site-chrome";
import { SiteLink } from "../../components/site-link";
import { SELL_TO_AGENTS_PICTURE } from "../../content/pictures";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";
import styles from "./agentic-shop.module.css";

/** The notice the retired merchant application form was sent under. */
export const loader = () => ({
  retentionDays: MERCHANT_APPLICATION_RETENTION_DAYS,
  version: MERCHANT_APPLICATION_POLICY,
});

export const meta = ({ matches }: MetaArgs) =>
  pageMeta(siteConfigOf(matches), {
    title: "Historical application privacy",
    description:
      "How Agentify retains and removes information submitted through the retired merchant application form.",
    canonical: "/agentic-shop/privacy",
    card: { image: SELL_TO_AGENTS_PICTURE },
  });

export default function MerchantPrivacyPage() {
  const config = usePublicConfig();
  const notice = useLoaderData<typeof loader>();
  return (
    <div className={styles.page}>
      <SiteHeader />
      <main className={`container ${styles.privacy}`} id="main">
        <p className={styles.eyebrow}>Historical merchant applications · September 9, 2026</p>
        <h1>
          The application form is closed.
          <br />
          Existing submissions still expire.
        </h1>
        <p>
          This notice covers information sent through the former merchant application form. Agentify
          no longer accepts applications at that path. A new merchant now opens the dashboard with
          an email link instead; that action does not add anything to the historical application
          data.
        </p>
        <h2>What was collected and why</h2>
        <p>
          The form collected a business name, website, email, category, country, optional offer
          description and confirmation of this notice. Those fields were used to review suitability,
          respond to the application and discuss onboarding.
        </p>
        <h2>Contact permission</h2>
        <p>
          The required checkbox gave permission to contact the submitter about that application. It
          did not subscribe anyone to a marketing mailing list. You can withdraw that permission by
          contacting us.
        </p>
        <h2>Storage and access</h2>
        <p>
          Retained application contents are encrypted in our database. Access is restricted to
          authorised operators handling the old submissions and privacy requests. Hosting and
          database providers process the information on our behalf. The contents are not sent to
          advertising analytics or made public in an agent catalog.
        </p>
        <h2>Retention and removal</h2>
        <p>
          Applications expire after {notice.retentionDays} days and are removed by the daily
          retention job. Limited backup copies may remain until the backup retention period expires.
          Any longer-term merchant record requires a separate onboarding process and notice. Hashed
          request identifiers are used briefly to limit abuse and avoid duplicate submissions.
        </p>
        <h2>Your choices</h2>
        <p>
          To request access, correction or deletion, or to withdraw contact permission, email{" "}
          <a href={`mailto:${config.privacyEmail}`}>{config.privacyEmail}</a> from the address used
          in your application. We may need to verify that the request is yours.
        </p>
        <h2>Operator and other site services</h2>
        <p>
          {config.legalIdentityConfirmed
            ? config.legalOperator
            : "Agentify project team. Registered operator details are pending confirmation and will be provided before commercial onboarding."}{" "}
          Privacy contact: <a href={`mailto:${config.privacyEmail}`}>{config.privacyEmail}</a>.
        </p>
        <p>
          The separate <SiteLink to="/privacy">Agentify privacy policy</SiteLink> explains general
          site cookies and diagnostic services. The application consent above does not authorise
          diagnostic dataset reuse.
        </p>
        <p className={styles.privacyFootnote}>Notice version: {notice.version}</p>
        <SiteLink className={styles.textLink} to="/agentic-shop">
          ← Back to selling to agents
        </SiteLink>
      </main>
      <SiteFooter />
    </div>
  );
}

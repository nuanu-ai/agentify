import {
  MERCHANT_APPLICATION_POLICY,
  MERCHANT_APPLICATION_RETENTION_DAYS,
} from "@agentify/scanner-contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { MarketingHeader, SiteFooter } from "../../../components/site-chrome";
import { getPublicAppConfig } from "../../../lib/app-config";
import styles from "../shop.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Historical application privacy",
  description:
    "How Agentify retains and removes information submitted through the retired merchant application form.",
  alternates: { canonical: "/agentic-shop/privacy" },
};

export default function MerchantPrivacyPage() {
  const config = getPublicAppConfig();
  return (
    <div className={styles.page}>
      <MarketingHeader />
      <main className={`${styles.container} ${styles.privacy}`} id="main">
        <p className={styles.eyebrow}>
          Historical merchant applications · September 9, 2026
        </p>
        <h1>
          The application form is closed.
          <br />
          Existing submissions still expire.
        </h1>
        <p>
          This notice covers information sent through the former merchant
          application form. Agentify no longer accepts applications at that
          path. A new merchant now opens the cabinet with an email link instead;
          that action does not add anything to the historical application data.
        </p>
        <h2>What was collected and why</h2>
        <p>
          The form collected a business name, website, email, category, country,
          optional offer description and confirmation of this notice. Those
          fields were used to review suitability, respond to the application and
          discuss onboarding.
        </p>
        <h2>Contact permission</h2>
        <p>
          The required checkbox gave permission to contact the submitter about
          that application. It did not subscribe anyone to a marketing mailing
          list. You can withdraw that permission by contacting us.
        </p>
        <h2>Storage and access</h2>
        <p>
          Retained application contents are encrypted in our database. Access is
          restricted to authorised operators handling the old submissions and
          privacy requests. Hosting and database providers process the
          information on our behalf. The contents are not sent to advertising
          analytics or made public in an agent catalog.
        </p>
        <h2>Retention and removal</h2>
        <p>
          Applications expire after {MERCHANT_APPLICATION_RETENTION_DAYS} days
          and are removed by the daily retention job. Limited backup copies may
          remain until the backup retention period expires. Any longer-term
          merchant record requires a separate onboarding process and notice.
          Hashed request identifiers are used briefly to limit abuse and avoid
          duplicate submissions.
        </p>
        <h2>Your choices</h2>
        <p>
          To request access, correction or deletion, or to withdraw contact
          permission, email{" "}
          <a href={`mailto:${config.privacyEmail}`}>{config.privacyEmail}</a>{" "}
          from the address used in your application. We may need to verify that
          the request is yours.
        </p>
        <h2>Operator and other site services</h2>
        <p>
          {config.legalIdentityConfirmed
            ? config.legalOperator
            : "Agentify project team. Registered operator details are pending confirmation and will be provided before commercial onboarding."}{" "}
          Privacy contact:{" "}
          <a href={`mailto:${config.privacyEmail}`}>{config.privacyEmail}</a>.
        </p>
        <p>
          The separate <Link href="/privacy">Agentify privacy policy</Link>{" "}
          explains general site cookies and diagnostic services. The application
          consent above does not authorise diagnostic dataset reuse.
        </p>
        <p className={styles.privacyFootnote}>
          Notice version: {MERCHANT_APPLICATION_POLICY}
        </p>
        <Link href="/agentic-shop" className={styles.textLink}>
          ← Back to selling to agents
        </Link>
      </main>
      <SiteFooter />
    </div>
  );
}

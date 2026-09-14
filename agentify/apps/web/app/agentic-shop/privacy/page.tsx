import type { Metadata } from "next";
import Link from "next/link";
import {
  MERCHANT_APPLICATION_POLICY,
  MERCHANT_APPLICATION_RETENTION_DAYS,
} from "@b2a/contracts";
import { BrandMark } from "../../../components/brand-mark";
import { getPublicAppConfig } from "../../../lib/app-config";
import styles from "../shop.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Agentic Shop — Application privacy",
  description:
    "How Agentify handles merchant applications and contact information.",
  alternates: { canonical: "/agentic-shop/privacy" },
};

export default function MerchantPrivacyPage() {
  const config = getPublicAppConfig();
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.container}>
          <Link href="/agentic-shop" className={styles.brand}>
            <BrandMark className={styles.mark} />
            <span>
              Agentify<span className={styles.subbrand}>Agentic Shop</span>
            </span>
          </Link>
          <Link href="/agentic-shop#apply" className={styles.headerCta}>
            Back to application ↗
          </Link>
        </div>
      </header>
      <main className={`${styles.container} ${styles.privacy}`}>
        <p className={styles.eyebrow}>
          Merchant applications · September 9, 2026
        </p>
        <h1>
          Your application.
          <br />
          Handled with care.
        </h1>
        <p>
          This notice covers the Agentic Shop application form. Applying asks
          the Agentify team to assess your business and contact you about a
          possible connection. It does not activate a payment service or create
          a merchant agreement.
        </p>
        <h2>What we collect and why</h2>
        <p>
          We collect your business name, website, email, category, country,
          optional offer description and confirmation of this notice. We use
          them to review suitability, respond to your application and discuss
          onboarding. Please do not include payment credentials, identity
          documents or sensitive personal information in the form.
        </p>
        <h2>Contact permission</h2>
        <p>
          The required checkbox gives permission to contact you about this
          application. It does not subscribe you to a marketing mailing list.
          You can withdraw that permission by contacting us. Essential
          processing of the submitted form is necessary to handle your request.
        </p>
        <h2>Storage and access</h2>
        <p>
          Application contents are encrypted before being stored in our
          database. Access is restricted to authorised operators handling
          onboarding and privacy requests. Hosting and database providers
          process the information on our behalf. Application contents are not
          sent to advertising analytics or made public in an agent catalog.
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
        <p className={styles.formFootnote}>
          Notice version: {MERCHANT_APPLICATION_POLICY}
        </p>
        <Link href="/agentic-shop#apply" className={styles.textLink}>
          ← Back to Agentic Shop
        </Link>
      </main>
    </div>
  );
}

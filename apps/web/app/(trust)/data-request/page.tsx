import type { Metadata } from "next";

import {
  EditorialPage,
  Notice,
  ProseList,
} from "../../../components/editorial-page";
import { AccountActions } from "../../../components/account-actions";
import { getPublicAppConfig } from "../../../lib/app-config";

export const metadata: Metadata = {
  title: "Data request",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function DataRequestPage() {
  const config = getPublicAppConfig();
  const subject = encodeURIComponent(`${config.displayBrand} data request`);
  return (
    <EditorialPage
      eyebrow="Data control · private request"
      intro="Request access, correction, deletion, unsubscribe, share revocation, or card detachment without putting private capability tokens in an email."
      sections={[
        {
          id: "request",
          title: "Send a request",
          content: (
            <Notice>
              <p>
                Email{" "}
                <a href={`mailto:${config.privacyEmail}?subject=${subject}`}>
                  {config.privacyEmail}
                </a>{" "}
                from the address connected to the report when possible. State
                the request type and public domain. Do not include scan/report
                tokens, Stripe details, passwords, or a private URL.
              </p>
              <AccountActions mode="data" />
            </Notice>
          ),
        },
        {
          id: "types",
          title: "Supported requests",
          content: (
            <ProseList>
              <li>Access or correct lead information.</li>
              <li>
                Complete verified deletion with an explicit final confirmation.
              </li>
              <li>Revoke active report sessions and public shares.</li>
              <li>Unsubscribe from optional marketing email.</li>
              <li>
                Detach an optional Stripe payment method, verify provider
                readback, and remove the provider customer before anonymization.
              </li>
              <li>Object to optional dataset reuse or analytics processing.</li>
            </ProseList>
          ),
        },
        {
          id: "verify",
          title: "Identity and safety",
          content: (
            <p>
              We may ask for a verification step before disclosing or changing a
              private record. We do not use a public website domain alone as
              proof that someone controls an email, report session, share, or
              payment signal.
            </p>
          ),
        },
      ]}
      title="Request access or deletion"
    />
  );
}

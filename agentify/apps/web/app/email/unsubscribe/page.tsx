import type { Metadata } from "next";

import { AccountActions } from "../../../components/account-actions";
import { EditorialPage } from "../../../components/editorial-page";

export const metadata: Metadata = {
  title: "Email preferences",
  robots: { index: false, follow: false },
};

export default function UnsubscribePage() {
  return (
    <EditorialPage
      eyebrow="Privacy control"
      title="Email preferences"
      intro="Transactional verification and report emails are separate from optional marketing."
      sections={[
        {
          id: "marketing",
          title: "Marketing email",
          content: (
            <>
              <p>
                Use a verified report session to unsubscribe. Transactional
                security or data-request messages may still be sent when
                necessary.
              </p>
              <AccountActions mode="unsubscribe" />
            </>
          ),
        },
      ]}
    />
  );
}

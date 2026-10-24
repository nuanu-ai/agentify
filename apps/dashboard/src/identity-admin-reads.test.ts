/**
 * The identity's reads for the operator's workspace over the sign-in
 * component's memory rows; the same promises run over Postgres in
 * `identity-admin-reads.db-test.ts`.
 */

import { loadConfig } from "./config.js";
import { identityFor } from "./identity.js";
import { describeAdminReads } from "./testing/identity-admin-reads.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";

const config = loadConfig({
  DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
  AUTH_SECRET: TEST_AUTH_SECRET,
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "sandbox:scripted",
});

describeAdminReads("the identity's reads for the workspace, in memory", async (held) =>
  identityFor(config, {
    rows: {
      dashboard_accounts: held.accounts.map((account) => ({
        ...account,
        emailVerified: true,
        name: "",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })),
      dashboard_sessions: [],
      dashboard_credentials: [],
      dashboard_verifications: [],
      dashboard_link_sends: held.linkSends.map((send) => ({
        ...send,
        emailHash: "h",
        clientHash: null,
        expiresAt: new Date(send.sentAt.getTime() + 7 * 86_400_000),
      })),
      dashboard_ad_reports: held.adReports.map((report) => ({ ...report })),
    },
  }),
);

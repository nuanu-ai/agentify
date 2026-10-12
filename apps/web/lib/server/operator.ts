/**
 * Whether the operator's dashboard opens for a request. The operator flag lives
 * on the person's account in the seller dashboard and is asked afresh on every
 * request, so a cleared flag shuts the operator's dashboard on the next one.
 * Anything short of a clear yes is no: not knowing whether somebody is an
 * operator is not knowing that they are one.
 */

import { sessionCookiePairs } from "@agentify/scanner-contracts/report-identity";

import { getDashboardReportIdentityClient } from "./dashboard-report-identity";

export async function isOperator(cookieHeader: string | null | undefined): Promise<boolean> {
  // Only the session cookie is forwarded, and the session is not renewed: a page
  // drawn on the server cannot pass a renewed cookie on.
  const cookie = sessionCookiePairs(cookieHeader ?? "");
  if (cookie === "") return false;
  try {
    const answer = await getDashboardReportIdentityClient().readSession({ cookie, renew: false });
    return answer.status === "signed_in" && answer.operator;
  } catch {
    return false;
  }
}

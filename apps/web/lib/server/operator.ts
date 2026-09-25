/**
 * Whether the operator's dashboard opens for a request (ADR-0026 §6).
 *
 * Being an operator is a flag on the person's account in the cabinet, which
 * holds the site's one session. The scanner learns it on the question it
 * already asks about every visitor, whose session this cookie is, and keeps
 * nothing of its own about it: every request asks afresh, so a flag cleared
 * at the terminal shuts the dashboard on the person's next request.
 *
 * Anything short of the cabinet saying yes is no. A browser with no session
 * is not asked about at all, and a cabinet that cannot be reached, answers an
 * error or says something this cannot read leaves the dashboard shut: not
 * knowing whether somebody is an operator is not knowing that they are one.
 */

import { sessionCookiePairs } from "@agentify/scanner-contracts/report-identity";

import { getCabinetReportIdentityClient } from "./cabinet-report-identity";

export async function isOperator(cookieHeader: string | null | undefined): Promise<boolean> {
  // Only the session's cookie goes to the cabinet, and the reading moves
  // nothing: a page drawn on the server cannot pass a renewed cookie on, and
  // the header's own call already does (ADR-0026 §2).
  const cookie = sessionCookiePairs(cookieHeader ?? "");
  if (cookie === "") return false;
  try {
    const answer = await getCabinetReportIdentityClient().readSession({ cookie, renew: false });
    return answer.status === "signed_in" && answer.operator;
  } catch {
    return false;
  }
}

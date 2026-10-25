/**
 * Whether the operator's dashboard opens for a request. The operator flag lives
 * on the person's account in the seller dashboard and is asked afresh on every
 * request, so a cleared flag shuts the operator's dashboard on the next one.
 * Anything short of a clear yes is no: not knowing whether somebody is an
 * operator is not knowing that they are one.
 */

import { sessionCookiePairs } from "@agentify/scanner-contracts/report-identity";
import { CHANNEL_NAMES, type ChannelView } from "@agentify/ui/workspace-view";

import { getServerConfig } from "./config";
import { getDashboardReportIdentityClient } from "./dashboard-report-identity";

/** The signed-in operator's address, or null for anybody the seller dashboard does not confirm as one. */
export async function operatorOf(cookieHeader: string | null | undefined): Promise<string | null> {
  // Only the session cookie is forwarded, and the session is not renewed: the
  // answer is a yes or a no, which carries no renewed cookie back to the browser.
  const cookie = sessionCookiePairs(cookieHeader ?? "");
  if (cookie === "") return null;
  try {
    const answer = await getDashboardReportIdentityClient().readSession({ cookie, renew: false });
    return answer.status === "signed_in" && answer.operator ? answer.email : null;
  } catch {
    return null;
  }
}

/**
 * The channel this scanner serves, as the workspace's frame names it: its name
 * and the site's host. The chain is the seller dashboard's to say, and the
 * scanner is not told it, so the line leaves it out rather than guess it.
 */
export function channelHere(): ChannelView {
  const config = getServerConfig();
  return {
    mode: config.AGENTIFY_SURFACE_MODE,
    name: CHANNEL_NAMES[config.AGENTIFY_SURFACE_MODE],
    line: new URL(config.appBaseUrl).host,
  };
}

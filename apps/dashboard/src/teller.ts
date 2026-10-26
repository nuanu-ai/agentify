/**
 * The gateway decides what to announce; the dashboard, which holds the
 * addresses, tells. The gateway calls this teller in-process and records a
 * wallet change only on `handed_over`, so this answer decides whether a change
 * waits; a throw from here is read as a change whose messages may have reached
 * some accounts, and the change is refused.
 */

import type { CommissionRate } from "@agentify/core/published";
import type { Announcement, AnnouncementAnswer } from "@agentify/gateway/announcements";
import { announcementMessage } from "./announcement-mail.js";
import type { DashboardConfig } from "./config.js";
import type { Identity } from "./identity.js";
import type { Postman } from "./mail.js";

export type Teller = (announcement: Announcement) => Promise<AnnouncementAnswer["outcome"]>;

/**
 * Every account is sent its message even after one is refused, because a person
 * who was told has been told; the answer is then `not_handed_over`, which the
 * gateway turns into a refusal saying a message may still have reached
 * somebody. The rate is the gateway's network's, which every split it
 * announces is recorded with.
 */
export function tellerFor(
  config: DashboardConfig,
  identity: Pick<Identity, "emailsNaming">,
  postman: Postman,
  rate: CommissionRate,
): Teller {
  const base = `${config.publicBaseUrl}${config.basePath}`;
  const screens = { wallet: `${base}/settings`, keys: `${base}/keys` };
  return async (announcement) => {
    const addresses = await identity.emailsNaming(announcement.merchant_id);
    if (addresses.length === 0) {
      console.log(`[dashboard] ${announcement.kind}: no account names the merchant, nobody told`);
      return "nobody_to_tell";
    }
    let refused = 0;
    for (const address of addresses) {
      if (
        (await postman(announcementMessage(address, announcement, screens, rate))) !== "accepted"
      ) {
        refused += 1;
      }
    }
    // Counts only: addresses stay out of the process log.
    console.log(
      `[dashboard] ${announcement.kind}: ${addresses.length - refused} of ${addresses.length} messages handed over`,
    );
    return refused === 0 ? "handed_over" : "not_handed_over";
  };
}

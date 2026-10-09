/**
 * Telling every account that names a merchant of a change to their payout
 * wallet or their keys (ADR-0019).
 *
 * The gateway decides what to announce and the dashboard, which holds the
 * addresses, tells. The two run in one process (ADR-0030), and the process
 * hands this teller to the gateway as its way of announcing, so the gateway
 * calls it rather than asking over a route: no listener, no secret, and no
 * answer that can go missing on the way. The gateway records a wallet change
 * only on `handed_over`, so the answer is what decides whether a change
 * waits; a throw from in here is read by the gateway as a change whose
 * messages may have gone out to some, and refused as one.
 */

import type { Announcement, AnnouncementAnswer } from "@agentify/gateway/announcements";
import { announcementMessage } from "./announcement-mail.js";
import type { DashboardConfig } from "./config.js";
import type { Identity } from "./identity.js";
import type { Postman } from "./mail.js";

/** Tells every account naming a merchant, and says what became of the messages. */
export type Teller = (announcement: Announcement) => Promise<AnnouncementAnswer["outcome"]>;

/**
 * The teller this dashboard runs: the accounts naming the merchant, a message
 * each, handed to the mail provider one after another.
 *
 * Every account is sent a message even after one is refused, because the
 * answer is not the only thing that matters — a person who was told has been
 * told — and the answer is then `not_handed_over`, which the gateway turns into
 * a refusal that says a message may still have reached somebody.
 */
export function tellerFor(
  config: DashboardConfig,
  identity: Pick<Identity, "emailsNaming">,
  postman: Postman,
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
      if ((await postman(announcementMessage(address, announcement, screens))) !== "accepted") {
        refused += 1;
      }
    }
    // Counts and nothing else: the addresses stay out of a process log.
    console.log(
      `[dashboard] ${announcement.kind}: ${addresses.length - refused} of ${addresses.length} messages handed over`,
    );
    return refused === 0 ? "handed_over" : "not_handed_over";
  };
}

/**
 * Telling a merchant of a change to their payout wallet or their keys
 * (ADR-0019).
 *
 * Five outcomes rather than the cabinet's three, and the last two are the
 * ones that matter. `refused_by_cabinet` is a listener that turned the request
 * away before reading it — the wrong secret, a body it would not take, an
 * address it does not answer on — so nobody was told. `unconfirmed` is a
 * cabinet that did not answer — gone, slow past the deadline, failing, or
 * answering something the wire does not recognise — and then a message may
 * have gone out although nothing here knows it did. The two are different
 * facts about somebody's inbox, and the refusal built on each says its own:
 * a merchant who got the message and was told nothing happened would be told
 * something untrue about their money, and so would one told a message may
 * have reached them when none could have.
 *
 * Nothing here throws on a silence. The adapter turns every way the call can
 * fail into `unconfirmed`, so the flow above has four answers to write and no
 * exception to guess about.
 */

import type { Announcement, AnnouncementAnswer } from "../announcements.js";

export type AnnouncementOutcome =
  | AnnouncementAnswer["outcome"]
  | "refused_by_cabinet"
  | "unconfirmed";

export interface Announcer {
  announce(announcement: Announcement): Promise<AnnouncementOutcome>;
}

/**
 * The announcer of a deployment that announces nothing: a test deployment and
 * the sandbox, where a change applies at once (ADR-0019).
 *
 * It throws rather than answering, because nothing on those deployments may
 * ask it anything — the flows decide by the surface whether to announce — and
 * a call reaching it is a defect in that decision, which an answer would hide.
 */
export const nobodyAnnounces: Announcer = {
  announce: async (announcement) => {
    throw new Error(
      `this deployment announces nothing, and it was asked to announce ${announcement.kind}`,
    );
  },
};

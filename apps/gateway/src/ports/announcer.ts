/**
 * Telling a merchant of a change to their payout wallet or their keys, through
 * the dashboard running in the same process. A throw is read as
 * `not_handed_over`, since some messages may already have gone out.
 */

import type { Announcement, AnnouncementAnswer } from "../announcements.js";

export type AnnouncementOutcome = AnnouncementAnswer["outcome"];

export interface Announcer {
  announce(announcement: Announcement): Promise<AnnouncementOutcome>;
}

/**
 * The announcer of a test deployment and the sandbox, where a change applies
 * at once. It throws rather than answering, because a call reaching it is a
 * defect in the flow's decision to announce.
 */
export const nobodyAnnounces: Announcer = {
  announce: async (announcement) => {
    throw new Error(
      `this deployment announces nothing, and it was asked to announce ${announcement.kind}`,
    );
  },
};

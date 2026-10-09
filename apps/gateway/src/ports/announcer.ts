/**
 * Telling a merchant of a change to their payout wallet or their keys
 * (ADR-0019).
 *
 * The dashboard holds the addresses and sends the messages, and it runs in the
 * gateway's own process (ADR-0030), so this is a call rather than a request:
 * the process hands the gateway the dashboard's way of telling, and its three
 * answers are the outcomes here. A throw from it is our own code failing —
 * reading the addresses, or a defect before one message or between two — and
 * the gateway reads it as `not_handed_over`, since a message may have gone out
 * to some of them already.
 */

import type { Announcement, AnnouncementAnswer } from "../announcements.js";

export type AnnouncementOutcome = AnnouncementAnswer["outcome"];

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

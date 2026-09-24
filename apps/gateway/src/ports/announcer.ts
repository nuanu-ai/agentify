/**
 * Telling a merchant of a change to their payout wallet or their keys
 * (ADR-0019).
 *
 * Four outcomes rather than the cabinet's three, and the fourth is the one
 * that matters. `unconfirmed` is a cabinet that did not answer — gone, slow
 * past the deadline, or answering something the wire does not recognise — and
 * then a message may have gone out although nothing here knows it did. It is
 * a different fact from "a message could not be handed over", and the refusal
 * built on it must not read as "not sent": a merchant who got the message and
 * was told nothing happened would be told something untrue about their money.
 *
 * Nothing here throws on a silence. The adapter turns every way the call can
 * fail into `unconfirmed`, so the flow above has four answers to write and no
 * exception to guess about.
 */

import type { Announcement, AnnouncementAnswer } from "../announcements.js";

export type AnnouncementOutcome = AnnouncementAnswer["outcome"] | "unconfirmed";

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

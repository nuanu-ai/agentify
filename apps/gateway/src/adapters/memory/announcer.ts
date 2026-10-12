/**
 * Announcing through the dashboard, recorded instead of called: a test reads
 * what the gateway asked to have said and decides what the dashboard answers.
 * The record is written before any answer, since the gateway does not wait to
 * hear back for a new key or a cancel.
 */

import type { Announcement } from "../../announcements.js";
import type { AnnouncementOutcome, Announcer } from "../../ports/announcer.js";

export class RecordingAnnouncer implements Announcer {
  readonly announced: Announcement[] = [];
  /**
   * What the dashboard answers. A function lets a test hold the answer open
   * while something else happens.
   */
  answer: AnnouncementOutcome | ((announcement: Announcement) => Promise<AnnouncementOutcome>) =
    "handed_over";

  async announce(announcement: Announcement): Promise<AnnouncementOutcome> {
    this.announced.push(announcement);
    return typeof this.answer === "function" ? await this.answer(announcement) : this.answer;
  }
}

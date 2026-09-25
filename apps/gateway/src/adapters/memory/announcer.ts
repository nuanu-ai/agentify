/**
 * The cabinet's announcement route, recorded instead of called.
 *
 * Every harness announces through one of these, whatever its configuration
 * names, so a test reads what the gateway asked to have said and decides what
 * the cabinet answers. The record is written the moment the gateway asks,
 * before any answer, because the claim a test makes about a new key or a
 * cancel is that it was asked for — not that the gateway waited to hear back,
 * which it deliberately does not.
 */

import type { Announcement } from "../../announcements.js";
import type { AnnouncementOutcome, Announcer } from "../../ports/announcer.js";

export class RecordingAnnouncer implements Announcer {
  /** Everything the gateway asked the cabinet to say, in order. */
  readonly announced: Announcement[] = [];
  /**
   * What the cabinet answers. Every message handed over, unless a test says
   * otherwise; a function lets a test hold the answer open while something
   * else happens, which is how a raced change is made.
   */
  answer: AnnouncementOutcome | ((announcement: Announcement) => Promise<AnnouncementOutcome>) =
    "handed_over";

  async announce(announcement: Announcement): Promise<AnnouncementOutcome> {
    this.announced.push(announcement);
    return typeof this.answer === "function" ? await this.answer(announcement) : this.answer;
  }
}

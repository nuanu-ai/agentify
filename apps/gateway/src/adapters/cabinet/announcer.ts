/**
 * Asking the cabinet to tell a merchant of a change, over its internal route
 * (ADR-0019).
 *
 * One call, made synchronously by the flow that is about to record a wallet
 * change, and read strictly: the cabinet's three answers pass through, a 4xx
 * is `refused_by_cabinet` because the listener answers those before telling
 * anybody, and every other way the call can end — a 5xx, a body the wire does
 * not recognise, nothing listening, nothing back before the deadline — is
 * `unconfirmed`. The last of those is the one worth naming. A cabinet
 * that answers after the gateway stopped waiting may well have handed every
 * message over, and a merchant who reads one was told of a change the gateway
 * then refused; the refusal says exactly that, which is only possible because
 * this adapter did not guess.
 *
 * The secret is presented as a bearer and never written anywhere else, the
 * log included. What the log gets is which of the failures it was, because an
 * operator looking at a refused change needs to know whether the cabinet was
 * down or answered something odd.
 */

import {
  ANNOUNCEMENTS_PATH,
  type Announcement,
  AnnouncementAnswerSchema,
} from "../../announcements.js";
import type { AnnouncementConfig } from "../../config.js";
import type { AnnouncementOutcome, Announcer } from "../../ports/announcer.js";

/**
 * How long the gateway waits for the cabinet to hand every message over.
 *
 * The cabinet gives the mail provider ten seconds a message, and a merchant is
 * named by one account today and by a few at most, so twenty seconds covers
 * the ordinary case with room and ends a call that is going nowhere well
 * inside the half minute a person pressing a button will wait. It is a
 * constant rather than a setting: what a knob here could do is make every
 * wallet change on the live site wait on a dead cabinet for as long as
 * somebody typed.
 */
const ANSWER_WITHIN_MS = 20_000;

export class CabinetAnnouncer implements Announcer {
  readonly #endpoint: string;
  readonly #secret: string;
  readonly #answerWithinMs: number;

  constructor(config: AnnouncementConfig, answerWithinMs: number = ANSWER_WITHIN_MS) {
    this.#endpoint = `${config.url}${ANNOUNCEMENTS_PATH}`;
    this.#secret = config.secret;
    this.#answerWithinMs = answerWithinMs;
  }

  async announce(announcement: Announcement): Promise<AnnouncementOutcome> {
    let answered: Response;
    try {
      answered = await fetch(this.#endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(this.#answerWithinMs),
        headers: {
          authorization: `Bearer ${this.#secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(announcement),
      });
    } catch {
      // Not printed: the exception can carry the request, and the request
      // carries the secret.
      console.error(
        `[gateway] the cabinet did not answer an announcement (${announcement.kind}) in time or at all`,
      );
      return "unconfirmed";
    }

    const text = await answered.text().catch(() => "");
    if (answered.status >= 400 && answered.status < 500) {
      // The cabinet's listener answers these before it reads an announcement,
      // and so before it tells anybody: nothing was sent. The one worth its
      // own sentence is the secret, because it means every change on this
      // deployment is being refused until somebody makes the two agree.
      console.error(
        answered.status === 401
          ? `[gateway] the cabinet refused the announcement secret (${announcement.kind}): ANNOUNCEMENT_SECRET on the gateway and on the cabinet are not the same value, and nothing was announced`
          : `[gateway] the cabinet refused an announcement (${announcement.kind}) with ${answered.status} before telling anybody`,
      );
      return "refused_by_cabinet";
    }
    if (answered.status !== 200) {
      console.error(
        `[gateway] the cabinet answered an announcement (${announcement.kind}) with ${answered.status}`,
      );
      return "unconfirmed";
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const read = AnnouncementAnswerSchema.safeParse(body);
    if (!read.success) {
      console.error(
        `[gateway] the cabinet answered an announcement (${announcement.kind}) with something that is not an answer`,
      );
      return "unconfirmed";
    }
    return read.data.outcome;
  }
}

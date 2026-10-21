/**
 * Which read of a page is a press's own. A press the page's script sent is
 * followed at once by a read of the page that answers it, made by the same
 * script with the cookie the press gave; that read is not a visit.
 */

/**
 * How long after a press the first read of its page is still the press's own,
 * and how many presses wait for that read at most: a press nothing read after,
 * such as one whose browser closed, is forgotten past either.
 */
const REREAD_WITHIN_MS = 10_000;
const REREADS_KEPT = 1_000;

export interface PressReads {
  /**
   * Remembers a press answered without a problem, by the value of the cookie
   * it was given and the page it was posted to. A press answered with a
   * problem is read again by nothing, so it is never remembered.
   */
  pressed(cookie: string, page: string): void;
  /**
   * Whether this read of `page` is the first since the press this cookie was
   * given by, and of the page that press was posted to; a press that led to
   * another screen leaves that screen's read a visit. Any read ends the wait.
   */
  isPressRead(cookie: string | undefined, page: string): boolean;
}

export function pressReads(now: () => number = Date.now): PressReads {
  const awaiting = new Map<string, Readonly<{ page: string; until: number }>>();
  return {
    pressed(cookie, page) {
      awaiting.set(cookie, { page, until: now() + REREAD_WITHIN_MS });
      for (const [oldest] of awaiting) {
        if (awaiting.size <= REREADS_KEPT) break;
        awaiting.delete(oldest);
      }
    },
    isPressRead(cookie, page) {
      if (cookie === undefined) return false;
      const awaited = awaiting.get(cookie);
      awaiting.delete(cookie);
      return awaited !== undefined && awaited.page === page && awaited.until >= now();
    },
  };
}

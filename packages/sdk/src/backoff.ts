/**
 * How long the worker waits before asking again a gateway that did not answer.
 *
 * The bounds are chosen for the merchant, not promised by the gateway: half a
 * second costs nothing visible after a dropped connection, and thirty seconds
 * is close to one long-poll window, so a worker that waited out an outage is
 * back within about a window of the gateway's return.
 *
 * Half of every wait is drawn at random. Workers that lost the same gateway
 * failed in the same second, and without the draw they would all come back in
 * the same millisecond, hitting a struggling gateway in step for ever.
 */

/** The wait after the first failed call. */
export const FIRST_RETRY_MS = 500;

/**
 * The longest wait between two attempts.
 *
 * `DOUBT_MS` in packages/slice/src/subscription.ts is this ceiling plus the
 * poll deadline plus a margin. Raise this without raising that, and a
 * healthcheck reports a dead subscription as a live one.
 */
export const RETRY_CEILING_MS = 30_000;

/** What the wait is multiplied by for each further failure in a row. */
export const RETRY_GROWTH = 2;

/**
 * The wait before attempt number `attempt`, given one draw from [0, 1]. The
 * draw is passed in so that a test can reproduce the bounds.
 *
 * An attempt that is not a whole number from 1 up, or a draw outside [0, 1],
 * is a bug in the caller and throws a `TypeError`: either would give a wait
 * outside the bounds.
 */
export const retryDelayMs = (attempt: number, random: number): number => {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError(`the attempt is a whole number from 1 upwards, and was ${attempt}`);
  }

  if (!(random >= 0 && random <= 1)) {
    throw new TypeError(`the random draw is a number from 0 to 1, and was ${random}`);
  }

  const capped = Math.min(RETRY_CEILING_MS, FIRST_RETRY_MS * RETRY_GROWTH ** (attempt - 1));

  return capped / 2 + (capped / 2) * random;
};

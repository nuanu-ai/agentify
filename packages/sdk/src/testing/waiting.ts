/**
 * Waiting for something the worker did, without waiting for a fixed time: the
 * condition is asked every millisecond, and the wait gives up after a cap that
 * only a failing test reaches. `what` names what was awaited, so the timeout
 * says it.
 */

/** How long the wait goes on before it is a failure, in millisecond attempts. */
const ATTEMPTS = 3_000;

export const waitUntil = async (ready: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`waited for ${what} and it never happened`);
};

/**
 * Closing one of the dashboard's doors at shutdown, within a bound.
 *
 * `close` alone stops taking new connections and waits for the open ones to
 * end, and a browser that keeps reusing a keep-alive connection can keep one
 * open for as long as it likes: Node goes on answering on a connection that was
 * busy when the door closed. The gateway stops only after these doors, since it
 * shares their process (ADR-0030), so that wait would keep every parked
 * purchase and every merchant's parked poll waiting until the process was
 * killed. So the idle connections close at once, a page already being answered
 * is given the grace to finish, and whatever is still open after it is cut.
 */

import type { Server } from "node:http";

export function closedWithin(listener: Server, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const cut = setTimeout(() => listener.closeAllConnections(), graceMs);
    listener.close(() => {
      clearTimeout(cut);
      resolve();
    });
    listener.closeIdleConnections();
  });
}

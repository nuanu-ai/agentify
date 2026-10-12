/**
 * `close` alone waits for every open connection to end, and a browser reusing a
 * keep-alive connection can hold one open indefinitely. The gateway shares this
 * process and stops only after these listeners, so that wait would hold every
 * parked purchase until the process was killed: idle connections close at once,
 * a page being answered gets the grace period, and the rest is cut.
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

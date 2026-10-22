/**
 * The payment fault control, started by hand:
 *
 *   pnpm payment-faults [--fault settle-lost] [--nth 1] [--after 20] [--port 8789]
 *
 * It runs until it is stopped. How to point a stack at it, choose the fault
 * and read the log is in this package's README; the server itself lives in
 * `payment-faults-command.ts`.
 */

import { runPaymentFaults } from "./payment-faults-command.js";

const started = await runPaymentFaults(process.argv.slice(2), (line) => {
  console.log(line);
});
if (!started.ok) {
  console.error(started.why);
  process.exitCode = 2;
}

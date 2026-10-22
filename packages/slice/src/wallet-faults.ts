/**
 * The wallet fault browser, started by hand:
 *
 *   pnpm wallet-faults --dashboard http://localhost:8080/dashboard --address 0x…
 *
 * It runs until the dashboard's tab is closed or it is stopped. What the stand-in's
 * buttons do and how to read the readings is in this package's README; the
 * browser itself lives in `wallet-faults-command.ts`.
 */

import { openWalletFaults, readPlan } from "./wallet-faults-command.js";

const read = readPlan(process.argv.slice(2));
if (!read.ok) {
  console.error(read.why);
  process.exit(2);
}
const opened = await openWalletFaults(read.plan, (line) => console.log(line)).catch(
  (thrown: unknown) => {
    console.error(thrown instanceof Error ? thrown.message : String(thrown));
    process.exit(2);
  },
);
opened.browser.on("disconnected", () => process.exit(0));
// Closing the last window leaves Chromium running on a Mac, so the
// dashboard's own tab is what ends the run.
opened.page.on("close", () => void opened.close());
process.on("SIGINT", () => void opened.close());
process.stdin.on("data", () => void opened.read());

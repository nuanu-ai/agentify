/**
 * The wallet fault browser, started by hand:
 *
 *   pnpm wallet-faults --dashboard http://localhost:8080/dashboard --address 0x…
 *
 * It runs until its browser is closed or it is stopped. What the stand-in's
 * buttons do and how to read the readings is in this package's README; the
 * browser itself lives in `wallet-faults-command.ts`.
 */

import { openWalletFaults, readPlan } from "./wallet-faults-command.js";

const read = readPlan(process.argv.slice(2));
if (!read.ok) {
  console.error(read.why);
  process.exit(2);
}
const opened = await openWalletFaults(read.plan, (line) => console.log(line));
opened.browser.on("disconnected", () => process.exit(0));
process.on("SIGINT", () => void opened.close());
process.stdin.on("data", () => void opened.read());

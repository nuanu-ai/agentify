/**
 * The proxy that answers with additions, started by hand:
 *
 *   pnpm additions --to http://localhost:8080 --add event-kind [--add field@/v0/worker/poll …] [--port 8791]
 *
 * It runs until it is stopped. What each addition adds where, and how to read
 * the log, is in this package's README; the proxy itself lives in
 * `additions-command.ts`.
 */

import { runAdditions } from "./additions-command.js";

const started = await runAdditions(process.argv.slice(2), (line) => {
  console.log(line);
});
if (!started.ok) {
  console.error(started.why);
  process.exitCode = 2;
}

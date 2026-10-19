/**
 * The response-cutting proxy, started by hand:
 *
 *   pnpm cut --to http://localhost:8080 --method POST --path /v0/catalog/publish \
 *     --phase mid-body [--nth 1] [--port 8788]
 *
 * It runs until it is stopped. How to choose the cut and read the log is in
 * this package's README; the proxy itself lives in `cut-command.ts`.
 */

import { runCut } from "./cut-command.js";

const started = await runCut(process.argv.slice(2), (line) => {
  console.log(line);
});
if (!started.ok) {
  console.error(started.why);
  process.exitCode = 2;
}

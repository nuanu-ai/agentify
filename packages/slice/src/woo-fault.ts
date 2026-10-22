/**
 * The controlled Woo fault, started inside its stack and commanded from the
 * organiser's terminal:
 *
 *   pnpm woo-fault serve --shop-host … --shop … (as packages/slice/woo-fault/stack.yaml runs it)
 *   pnpm woo-fault status | fail … | hold … | release … | shift … | clear
 *
 * What each command does, and how the stack and a local copy of the lab are
 * wired to it, is in this package's README; the edge lives in
 * `woo-fault-command.ts`.
 */

import { commandWooFault, serveWooFault } from "./woo-fault-command.js";

const [verb, ...rest] = process.argv.slice(2);
const done =
  verb === "serve"
    ? await serveWooFault(rest, (line) => {
        console.log(line);
      })
    : await commandWooFault(process.argv.slice(2));
if (done.ok) {
  console.log(done.said);
} else {
  console.error(done.said);
  process.exitCode = verb === "serve" ? 2 : 1;
}

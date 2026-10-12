#!/usr/bin/env node
/**
 * The command installed by `@nuanu-ai/agentify` as `agentify`. The work is in
 * `verify.ts`; this is glue.
 *
 * What a merchant runs is `dist/cli.js`, because Node's type stripping does not
 * rewrite the `.js` specifiers these sources import each other by. Nothing in
 * `pnpm test` runs the compiled command; `pnpm outside` installs the packed
 * tarball elsewhere and runs `agentify verify` there.
 */

import { runVerify } from "./verify.js";

process.exitCode = await runVerify(process.argv.slice(2), (line) => {
  process.stdout.write(`${line}\n`);
});

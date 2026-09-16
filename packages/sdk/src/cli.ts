#!/usr/bin/env node
/**
 * The command installed by `@nuanu-ai/agentify` as `agentify`.
 *
 * It is glue and nothing else: the work is in `verify.ts`, which answers with
 * a number and a stream of lines, so that everything the command does can be
 * tested without a process, a shell or a temporary directory of output.
 *
 * What a merchant runs is not this file but `dist/cli.js` compiled from it, and
 * the distinction is the whole reason the package has a build. These sources
 * import each other with `.js` specifiers; Node's type stripping does not
 * rewrite such a specifier, so it would look for a `.js` file that is not
 * there and stop. `tsc` writes exactly that file, and `publishConfig.bin` in
 * `package.json` is what points the installed `agentify` command at it.
 *
 * Nothing in this repository runs the compiled command, so nothing in
 * `pnpm test` can tell you it still starts. `pnpm outside` is what does: it
 * installs the packed tarball into a directory with no path back here and runs
 * the installed `agentify verify` command there.
 */

import { runVerify } from "./verify.js";

process.exitCode = await runVerify(process.argv.slice(2), (line) => {
  process.stdout.write(`${line}\n`);
});

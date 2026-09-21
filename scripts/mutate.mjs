#!/usr/bin/env node

/**
 * Stryker's mutation report for one workspace package, with the working tree
 * left alone.
 *
 * Usage: pnpm mutate <package> [--file <package-relative-path>]...
 *
 * A package is a directory under `packages/` or `apps/` that holds a
 * `package.json`, and <package> is its name, exactly as `ls` prints it. The
 * door accepts nothing else: not a path, not `.` or `..`, which `basename`
 * would let through. `scripts/stryker.vitest.config.ts` lists the packages by
 * the same definition; if it changes, it changes in both.
 *
 * Stryker is a triage tool here, not a gate: the run prints the clear-text
 * table and writes the JSON report, and someone reads the survivors. It is
 * run from the root of the checkout, from which Stryker copies the checkout
 * into a sandbox, mutates the copies and runs vitest there. Nothing it does
 * reaches the checkout, and a run killed half-way leaves nothing behind but
 * its sandbox in the operator storage directory. Its `inPlace` mode, the one the spike
 * (`docs/research/27-stryker-spike.md`) had to use, is the opposite: it
 * rewrites the tree itself and leaves it dirty when the process dies.
 *
 * Why each option is what it is:
 *
 * - The tsconfig rewrite is switched off, by naming a `tsconfigFile` that
 *   exists nowhere. That rewrite is the one place Stryker loads TypeScript,
 *   and it calls `parseConfigFileTextToJson`, which the workspace's
 *   TypeScript 7 no longer exports. Its only job is to fix `extends` and
 *   `references` paths that would leave the sandbox; none of ours do, every
 *   `extends` here points at `tsconfig.base.json` inside the copy. Vite does
 *   read the nearest tsconfig for each `.ts` file it transforms, and would
 *   fail the dry run aloud with a `TSCONFIG_ERROR` if one pointed outside
 *   the sandbox. It runs only when the named file is among
 *   the files Stryker copies, so a name that matches nothing skips it, and
 *   Stryker needs no TypeScript of its own: a second TypeScript in the graph
 *   made pnpm re-resolve gateway's production peers (`viem`, `@x402/*`) into
 *   several flavours, which a test tool has no business doing.
 * - The runner named in `plugins`. The default `@stryker-mutator/*` glob is
 *   resolved next to the installed `core`, and under pnpm nothing else is
 *   installed there.
 * - The root of the checkout as the working directory. Stryker's sandbox is a
 *   copy of everything under the directory it runs from, plus a symlink for
 *   every `node_modules` beneath it. Run from `packages/core` the sandbox
 *   would hold core alone: not the vitest config, not the network guard it
 *   loads, none of the tests in gateway and slice that import core. Run from
 *   the root, all of them are copied and the runner selects the commerce or
 *   scanner suite for the target package. The one thing the copy gets wrong, a workspace
 *   symlink that leads back to the real checkout, is corrected by
 *   `scripts/stryker.vitest.config.ts`, which is why that file is passed as
 *   the vitest config rather than `vitest.config.ts` directly.
 * - What git ignores stays out of the sandbox. Stryker's crawl does not read
 *   `.gitignore`: on its own it skips `node_modules` and `.git` and copies
 *   the rest, an `.env` and every agent worktree under `.claude/worktrees/`
 *   included, and a killed run leaves that copy on the disk. `ignorePatterns`
 *   is therefore what `git ls-files --ignored` names at the moment of the
 *   run, so the two cannot drift. Each entry is a literal path, so the
 *   characters minimatch reads as a pattern are escaped in it. Untracked
 *   files that git does not ignore are copied, as they would be run by
 *   `pnpm test`.
 * - Everything Stryker writes goes to the operator storage directory: the sandbox
 *   (`tempDirName`) and the report (`jsonReporter.fileName`) are absolute
 *   paths under STORAGE, because the root disk is small and because a file
 *   that appears inside the checkout is a file `git status` has to explain.
 * - One run at a time. A second Stryker sweeping the sandboxes directory
 *   while the first is testing mutants does not fail the first: it leaves it
 *   hanging, with hundreds of mutants counted as survivors because no test
 *   was left to run against them. So a run takes a lock under STORAGE with
 *   its PID, a second run is refused at the door by name of the first, and
 *   sandboxes left by killed runs are swept only once the lock is held. A
 *   lock whose process is gone is stale and is taken over.
 * - The previous report is removed before the run. A killed or failed run
 *   writes no report, and a report that survived such a run is by its path
 *   indistinguishable from a fresh one; the file exists only when a run has
 *   completed.
 * - The narrow mode. Static mutants, those that only run when a module is
 *   loaded, cost a full reload of the environment and all of the tests each;
 *   `ignoreStatic` skips them, string literals are excluded as a class, and
 *   coverage is taken per test so that a mutant runs only the tests that
 *   reach it. On core this is the difference between five minutes and more
 *   than fifteen. The price is that the state machine's transition table,
 *   which is built at load time, goes unmutated.
 * - The clear-text report lists the mutants that survived, each with its
 *   diff and the tests that ran against it, and the score table; the list of
 *   every test in the dry run, twelve hundred lines that say nothing about a
 *   mutant, is switched off.
 * - Tracked `.ts` and `.tsx` production files are mutated, with tests and
 *   fixtures excluded. `apps/web` has production roots under `app`,
 *   `components`, `content` and `lib`; other workspaces use `src`. Repeated
 *   `--file` narrows that production scope without accepting an untracked or
 *   out-of-package path. `preflight.mjs` in core is
 *   spawned as a child process by its test, where a mutant switched on in this
 *   process is not seen, so mutating it would only report survivors that are
 *   not holes.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Stryker } from "@stryker-mutator/core";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STORAGE = path.join(homedir(), ".codex-project-storage", "stryker");
const SCANNER_PACKAGES = new Set([
  "apps/web",
  "apps/scanner-worker",
  "apps/browser-observer-actor",
  "packages/scanner-contracts",
  "packages/scanner-database",
  "packages/scanner",
  "packages/analytics",
  "packages/observability",
  "packages/remediation",
]);

/** The workspace packages: directories under packages/ and apps/ that hold a package.json. */
function workspacePackages() {
  return ["packages", "apps"].flatMap((group) =>
    readdirSync(path.join(ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, dir: path.join(group, entry.name) }))
      .filter(({ dir }) => existsSync(path.join(ROOT, dir, "package.json"))),
  );
}

const [name, ...cliArgs] = process.argv.slice(2);
const packageDir = workspacePackages().find((p) => p.name === name)?.dir;

if (packageDir === undefined) {
  console.error(
    `Usage: pnpm mutate <package> [--file <package-relative-path>]..., where <package> is one of: ${workspacePackages()
      .map((p) => p.name)
      .join(", ")}`,
  );
  process.exit(2);
}

const requestedFiles = [];
for (let index = 0; index < cliArgs.length; index += 2) {
  if (cliArgs[index] !== "--file" || !cliArgs[index + 1]) {
    console.error(
      "Every mutation scope argument must be --file followed by a package-relative path.",
    );
    process.exit(2);
  }
  requestedFiles.push(cliArgs[index + 1]);
}

const tracked = new Set(
  execFileSync("git", ["ls-files", "-z", "--", packageDir], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean),
);

const isProductionTypeScript = (relative) => {
  const parts = relative.split("/");
  const file = parts.at(-1) ?? "";
  return (
    /\.tsx?$/.test(file) &&
    !/\.d\.ts$/.test(file) &&
    !/\.(test|spec)\.tsx?$/.test(file) &&
    !/^fixtures?\.tsx?$/.test(file) &&
    !parts.some((part) => part === "fixture" || part === "fixtures")
  );
};

const selectedFiles = requestedFiles.length
  ? requestedFiles.map((relative) => {
      const normalized = path.posix.normalize(relative);
      const repositoryPath = path.posix.join(packageDir, normalized);
      if (
        normalized !== relative ||
        path.posix.isAbsolute(relative) ||
        normalized.startsWith("../") ||
        !tracked.has(repositoryPath) ||
        !isProductionTypeScript(normalized)
      ) {
        console.error(
          `Mutation file must be a tracked production .ts/.tsx file inside ${packageDir}: ${relative}`,
        );
        process.exit(2);
      }
      return repositoryPath;
    })
  : [...tracked].filter((repositoryPath) => {
      const relative = path.posix.relative(packageDir, repositoryPath);
      const inProductionRoot =
        packageDir === "apps/web"
          ? ["app", "components", "content", "lib"].includes(relative.split("/")[0])
          : relative.startsWith("src/");
      return inProductionRoot && isProductionTypeScript(relative);
    });

if (selectedFiles.length === 0) {
  console.error(`did not apply: ${name} has no selected production TypeScript files`);
  process.exit(4);
}

const family = SCANNER_PACKAGES.has(packageDir) ? "scanner" : "commerce";
process.env.AGENTIFY_MUTATION_FAMILY = family;
process.env.AGENTIFY_MUTATION_PACKAGE_DIR = packageDir;

const lock = path.join(STORAGE, "lock");
const sandboxes = path.join(STORAGE, "sandboxes");
const report = path.join(STORAGE, "reports", name, "mutation.json");
const literalGlob = (value) => value.replace(/[[\]{}()*?!+@|\\]/g, "\\$&");

/** The PID in the lock file if that process is alive and is a mutate run. */
function liveRun() {
  let pid;
  try {
    pid = Number.parseInt(readFileSync(lock, "utf8"), 10);
    process.kill(pid, 0);
  } catch {
    return undefined;
  }
  let cmdline = "";
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {}
  return cmdline.includes("mutate.mjs") ? pid : undefined;
}

function takeLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const other = liveRun();
    if (other !== undefined) {
      console.error(
        `Another pnpm mutate is running as PID ${other}; wait for it to finish, or kill it, before starting this one.`,
      );
      process.exit(3);
    }
    rmSync(lock, { force: true });
  }
  console.error("Another pnpm mutate took the lock at the same moment; try again.");
  process.exit(3);
}

/** What `.gitignore` names, as Stryker's ignore patterns anchored at the root, taken literally. */
function ignoredByGit() {
  return execFileSync(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    { cwd: ROOT, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .map((entry) => `/${entry.replace(/\/$/, "").replace(/[[\]{}()*?!+@|\\]/g, "\\$&")}`);
}

process.chdir(ROOT);
mkdirSync(STORAGE, { recursive: true });
takeLock();
process.on("exit", () => rmSync(lock, { force: true }));
rmSync(sandboxes, { recursive: true, force: true });
rmSync(report, { force: true });
mkdirSync(path.dirname(report), { recursive: true });

const stryker = new Stryker({
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  vitest: {
    configFile: "scripts/stryker.vitest.config.ts",
    related: false,
  },
  tsconfigFile: "stryker.tsconfig-rewrite-off.json",
  mutate: selectedFiles.map(literalGlob),
  ignorePatterns: ignoredByGit(),
  coverageAnalysis: "perTest",
  ignoreStatic: true,
  mutator: { excludedMutations: ["StringLiteral"] },
  tempDirName: sandboxes,
  cleanTempDir: "always",
  reporters: ["clear-text", "progress", "json"],
  clearTextReporter: { reportTests: false },
  jsonReporter: { fileName: report },
});

try {
  const results = await stryker.runMutationTest();
  if (!existsSync(report)) {
    console.error("mutation run finished without its JSON report");
    process.exitCode = 1;
  } else if (results.every((mutant) => mutant.status === "Ignored")) {
    console.error("did not apply: Stryker produced zero mutants");
    process.exitCode = 4;
  } else {
    const counts = Object.create(null);
    for (const mutant of results) {
      counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
    }
    const applied = results.length - (counts.Ignored ?? 0);
    console.log(
      `Mutation result: ${applied} applied; ` +
        `killed=${counts.Killed ?? 0}, survived=${counts.Survived ?? 0}, ` +
        `noCoverage=${counts.NoCoverage ?? 0}, timedOut=${counts.Timeout ?? 0}, ` +
        `runtimeError=${counts.RuntimeError ?? 0}, compileError=${counts.CompileError ?? 0}.`,
    );
    console.log(`The report is at ${report}`);
  }
} catch {
  // Stryker has already said what went wrong; the exit code says it went wrong.
  process.exit(1);
}

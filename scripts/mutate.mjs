#!/usr/bin/env node

/**
 * Stryker's mutation report for one workspace package, with the working tree
 * left alone.
 *
 * Usage: pnpm mutate <package> [--file <package-relative-path>]...
 *
 * <package> is the name of a directory under `packages/` or `apps/` that holds
 * a `package.json`, exactly as `ls` prints it: not a path, not `.` or `..`.
 * `scripts/stryker.vitest.config.ts` uses the same definition; if it changes,
 * it changes in both.
 *
 * Stryker is a triage tool here, not a gate: someone reads the survivors, and
 * one worth acting on is confirmed by applying the mutation by hand and running
 * `pnpm test`. Stryker mutates a copy of the checkout in a sandbox, so a run
 * killed half-way leaves only its sandbox behind. Its `inPlace` mode rewrites
 * the tree itself and leaves it dirty when the process dies.
 *
 * Why each option is what it is:
 *
 * - `tsconfigFile` names a file that exists nowhere, which switches off
 *   Stryker's tsconfig rewrite. The rewrite calls `parseConfigFileTextToJson`,
 *   which the workspace's TypeScript 7 does not export, and nothing here needs
 *   it: every `extends` points at `tsconfig.base.json` inside the copy. It also
 *   spares Stryker a TypeScript of its own, and a second one in the graph makes
 *   pnpm re-resolve the gateway's production peers (`viem`, `@x402/*`).
 * - The runner is named in `plugins`: the default glob resolves next to the
 *   installed `core`, where pnpm installs nothing else.
 * - It runs from the root of the checkout, because the sandbox copies only the
 *   directory Stryker runs from; run from `packages/core` it would lack the
 *   vitest config, its network guard and the tests elsewhere that import core.
 *   A workspace symlink in the copy still leads to the real checkout, which
 *   `scripts/stryker.vitest.config.ts` corrects; that is why it is the vitest
 *   config here.
 * - `ignorePatterns` is what `git ls-files --ignored` names at run time, as
 *   escaped literal paths. Stryker's crawl does not read `.gitignore` and would
 *   otherwise copy an `.env` and every agent worktree, and a killed run leaves
 *   that copy on disk.
 * - The sandbox and the report go under STORAGE, outside the checkout: the root
 *   disk is small, and a file inside the checkout is one `git status` has to
 *   explain.
 * - One run at a time, by a PID lock under STORAGE. A second run sweeping the
 *   sandboxes does not fail the first but leaves it hanging, with hundreds of
 *   mutants counted as survivors. A lock whose process is gone is taken over,
 *   and leftover sandboxes are swept only once the lock is held.
 * - The previous report is removed first, so a report exists only when a run
 *   completed.
 * - `ignoreStatic`, no string-literal mutants and per-test coverage keep a run
 *   short. The price is that the state machine's transition table, built at
 *   load time, goes unmutated.
 * - Tracked production `.ts` and `.tsx` files are mutated: `apps/web` has its
 *   roots under `app`, `components`, `content`, `lib` and `server`, the other
 *   packages under `src`. Repeated `--file` narrows that scope and refuses an
 *   untracked or out-of-package path. `preflight.mjs` in core is left out: its
 *   test runs it as a child process, which never sees a mutant switched on
 *   here.
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
          ? ["app", "components", "content", "lib", "server"].includes(relative.split("/")[0])
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
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    process.kill(pid, 0);
  } catch {
    return undefined;
  }

  let command = "";
  try {
    command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
  } catch {
    return pid;
  }
  if (!command) return pid;
  return /(?:^|[ /])mutate\.mjs(?:\s|$)/.test(command) ? pid : undefined;
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

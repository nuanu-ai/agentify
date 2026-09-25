#!/usr/bin/env node

/**
 * PRODUCTION live approval for one merchant, granted inside the cabinet
 * container that is already running on the host.
 *
 * Usage: pnpm approve <email>
 *
 * The filter names the cabinet by its directory and not by its package name
 * because pnpm resolves it inside that container, against the revision that
 * was deployed last rather than against this checkout. A rename of the package
 * would otherwise break approval from every laptop until the next deployment
 * caught up; the directory is the same in both revisions.
 *
 * `--fail-if-no-match` is what makes that safe to rely on: a filter matching
 * nothing — a layout the container does not have, a working directory that is
 * not the workspace root — is pnpm's own refusal with a non-zero status rather
 * than a silent success over an empty selection, and this wrapper forwards
 * that status.
 */

import { spawnSync } from "node:child_process";

const [email, ...extra] = process.argv.slice(2);
if ((email === "--help" || email === "-h") && extra.length === 0) {
  console.log("Usage: pnpm approve <email>");
  console.log("Grants one existing merchant PRODUCTION live approval.");
} else if (email === undefined || extra.length !== 0) {
  console.error("Usage: pnpm approve <email>");
  console.error("This grants one existing merchant PRODUCTION live approval.");
  process.exitCode = 2;
} else {
  console.error("Requesting PRODUCTION live approval through agentify.");
  const result = spawnSync(
    "ssh",
    [
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPersist=60",
      "-o",
      "ControlPath=~/.ssh/agentify-approve-%C",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=10",
      "-o",
      "ServerAliveCountMax=3",
      "agentify",
      "sudo",
      "-n",
      "docker",
      "exec",
      "-i",
      "agentify-cabinet-1",
      "pnpm",
      "--filter",
      "./apps/cabinet",
      "--fail-if-no-match",
      "approve",
    ],
    {
      input: `${email}\n`,
      killSignal: "SIGTERM",
      stdio: ["pipe", "inherit", "inherit"],
      timeout: 60_000,
    },
  );

  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status === null ||
    result.status === 255
  ) {
    console.error(
      "The PRODUCTION approval outcome is unknown because SSH did not complete. Retry the same command to inspect the one-way result.",
    );
    process.exitCode = 1;
  } else {
    process.exitCode = result.status;
  }
}

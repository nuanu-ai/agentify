#!/usr/bin/env node

/**
 * PRODUCTION live approval for one merchant, granted inside the application's
 * container (`agentify-app-1`), where the dashboard runs, already running on
 * the host.
 *
 * Usage: pnpm approve <email>
 *
 * pnpm resolves the filter inside the container, against the revision deployed
 * there rather than this checkout, so the dashboard is named by its directory:
 * a package rename would otherwise break approval until the next deployment.
 * The container's name has no such protection; it follows the Compose service
 * of the revision deployed there. `--fail-if-no-match` makes a filter that
 * matches nothing a non-zero refusal rather than a silent success, and this
 * wrapper forwards that status.
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
      "agentify-app-1",
      "pnpm",
      "--filter",
      "./apps/dashboard",
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

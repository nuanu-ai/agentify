#!/usr/bin/env node

/**
 * PRODUCTION live approval for one merchant, granted or withdrawn inside the
 * application's container (`agentify-app-1`), where the dashboard runs,
 * already running on the host.
 *
 * Usage: pnpm approve <email>
 *        pnpm approve --withdraw <email>
 *
 * pnpm resolves the filter inside the container, against the revision deployed
 * there rather than this checkout, so the dashboard is named by its directory:
 * a package rename would otherwise break approval until the next deployment.
 * The container's name has no such protection; it follows the Compose service
 * of the revision deployed there. `--fail-if-no-match` makes a filter that
 * matches nothing a non-zero refusal rather than a silent success, and this
 * wrapper forwards that status. A withdrawal is its own script there rather
 * than a flag on `approve`, so a revision that predates it refuses for want of
 * the script instead of granting.
 */

import { spawnSync } from "node:child_process";

const USAGE = ["Usage: pnpm approve <email>", "       pnpm approve --withdraw <email>"];

const asked = process.argv.slice(2);
const withdraw = asked[0] === "--withdraw";
const [email, ...extra] = withdraw ? asked.slice(1) : asked;
if ((email === "--help" || email === "-h") && extra.length === 0 && !withdraw) {
  for (const line of USAGE) console.log(line);
  console.log("Grants one existing merchant PRODUCTION live approval, or withdraws it.");
} else if (email === undefined || email.startsWith("-") || extra.length !== 0) {
  for (const line of USAGE) console.error(line);
  console.error("This grants one existing merchant PRODUCTION live approval, or withdraws it.");
  process.exitCode = 2;
} else {
  const what = withdraw ? "withdrawal of PRODUCTION live approval" : "PRODUCTION live approval";
  console.error(`Requesting ${what} through agentify.`);
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
      withdraw ? "withdraw-approval" : "approve",
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
      `The ${what} outcome is unknown because SSH did not complete. Retry the same command to inspect the result.`,
    );
    process.exitCode = 1;
  } else {
    process.exitCode = result.status;
  }
}

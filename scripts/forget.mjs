#!/usr/bin/env node

/**
 * Forgets one address on the TEST deployment, inside the cabinet container
 * that is already running on the test host: its cabinet account and its
 * merchant go, so the address signs in again as a newcomer.
 *
 * Usage: pnpm forget <email>
 *
 * The command inside the container refuses on its own unless the deployment
 * settles on a test network, so this wrapper names the test host and nothing
 * else decides the target. The filter and `--fail-if-no-match` are the ones
 * `scripts/approve.mjs` uses, for the reasons written there.
 */

import { spawnSync } from "node:child_process";

const [email, ...extra] = process.argv.slice(2);
if ((email === "--help" || email === "-h") && extra.length === 0) {
  console.log("Usage: pnpm forget <email>");
  console.log(
    "Removes one address's cabinet account and its merchant on the TEST deployment, so it signs in again as a newcomer.",
  );
} else if (email === undefined || extra.length !== 0) {
  console.error("Usage: pnpm forget <email>");
  console.error(
    "This removes one address's cabinet account and its merchant on the TEST deployment.",
  );
  process.exitCode = 2;
} else {
  console.error("Asking the TEST host to forget this address.");
  const result = spawnSync(
    "ssh",
    [
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPersist=60",
      "-o",
      "ControlPath=~/.ssh/agentify-forget-%C",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=10",
      "-o",
      "ServerAliveCountMax=3",
      "agentify-test",
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
      "forget",
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
      "The TEST forget outcome is unknown because SSH did not complete. Run the same command again: it finishes the work or says the address has no account.",
    );
    process.exitCode = 1;
  } else {
    process.exitCode = result.status;
  }
}

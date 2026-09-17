#!/usr/bin/env node

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
      "docker",
      "exec",
      "-i",
      "agentify-commerce-cabinet-1",
      "pnpm",
      "--filter",
      "@agentify/commerce-cabinet",
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

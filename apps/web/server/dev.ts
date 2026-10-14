/**
 * The scanner for a developer, `pnpm --filter @agentify/web dev`: compiled
 * from source on each request, reloaded on an edit, on `PORT` (3000) of
 * loopback only, with the background retry of identity deletions where the
 * dashboard's private route is configured, as the built process has it.
 */

import { createServer } from "node:http";
import { LOOPBACK, scannerFromSource } from "./from-source";

const scanner = await scannerFromSource({ live: true });
const port = Number.parseInt(process.env.PORT ?? "", 10) || 3000;
createServer(scanner.listener).listen(port, LOOPBACK, () =>
  console.log(`[web] http://${LOOPBACK}:${port}`),
);

const [{ startDeletionRetries }, { retryPendingScannerIdentityDeletions }] = await Promise.all([
  scanner.load<typeof import("./deletion-retries")>("/server/deletion-retries.ts"),
  scanner.load<typeof import("../lib/server/scanner-identity-deletion")>(
    "/lib/server/scanner-identity-deletion.ts",
  ),
]);
startDeletionRetries(process.env, retryPendingScannerIdentityDeletions);

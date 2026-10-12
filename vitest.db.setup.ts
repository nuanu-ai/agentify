/**
 * Fails `pnpm test:db` when no Postgres is reachable. Without it every file
 * skips and the command exits zero, which a script or CI reads as a pass. The
 * per-file skips stay, for a server that goes away between this probe and a
 * test.
 */

import {
  noDatabaseHere,
  readyDatabase,
  testDatabaseUrl,
} from "./apps/gateway/src/testing/database.js";

export async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  if ((await readyDatabase(url)) !== null) {
    return;
  }

  throw new Error(
    `${noDatabaseHere(url)}\n  This command is the suite that needs one, so there is nothing it can\n  honestly report.\n`,
  );
}

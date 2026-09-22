import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { Database } from "./client.js";

export async function migrateDatabase(db: Database, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}

const IDENTITY_PREFLIGHT_LAST_MIGRATION = "0016_superb_zuras";

export type MigrationMode = "full" | "identity-preflight";

export function migrationModeFromArgs(args: readonly string[]): MigrationMode {
  if (args.length === 0) return "full";
  if (args.length === 1 && args[0] === "--identity-preflight") {
    return "identity-preflight";
  }
  throw new Error("usage: migrate-cli [--identity-preflight]");
}

export async function migrateDatabaseThroughIdentityPreflight(
  db: Database,
  migrationsFolder: string,
): Promise<void> {
  const boundedFolder = await mkdtemp(join(tmpdir(), "agentify-scanner-identity-preflight-"));
  try {
    await mkdir(join(boundedFolder, "meta"));
    const journal = JSON.parse(
      await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
    ) as { entries?: Array<{ tag?: string }> };
    const entries = journal.entries ?? [];
    const cutoff = entries.findIndex((entry) => entry.tag === IDENTITY_PREFLIGHT_LAST_MIGRATION);
    if (cutoff < 0) throw new Error("identity_preflight_migration_missing");
    const boundedEntries = entries.slice(0, cutoff + 1);
    await writeFile(
      join(boundedFolder, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: boundedEntries }),
    );
    for (const entry of boundedEntries) {
      if (!entry.tag) throw new Error("invalid_migration_journal_entry");
      await copyFile(
        join(migrationsFolder, `${entry.tag}.sql`),
        join(boundedFolder, `${entry.tag}.sql`),
      );
    }
    await migrateDatabase(db, boundedFolder);
  } finally {
    await rm(boundedFolder, { recursive: true, force: true });
  }
}

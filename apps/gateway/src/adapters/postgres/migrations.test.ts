/**
 * The folder of migrations a deployed database is brought up to date from.
 * drizzle's migrator runs a migration only if its journal entry is newer than
 * the newest one the database has applied, so an entry written with an older
 * moment ships green here, where the tests migrate an empty database, and
 * never runs on the test channel or in production.
 */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const folder = new URL("../../../drizzle/", import.meta.url);

const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", folder), "utf8")) as {
  readonly entries: readonly {
    readonly idx: number;
    readonly when: number;
    readonly tag: string;
  }[];
};

describe("the migrations a deployed database runs", () => {
  it("are journalled each later than the one before, so every one runs on a database that ran the rest", () => {
    const moments = journal.entries.map((entry) => entry.when);

    for (const [index, moment] of moments.entries()) {
      if (index > 0) {
        expect(moment, journal.entries[index]?.tag).toBeGreaterThan(moments[index - 1] ?? 0);
      }
    }
  });

  it("are every SQL file in the folder, each journalled once, in the order of their numbers", () => {
    const files = readdirSync(folder)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    expect(journal.entries.map((entry) => `${entry.tag}.sql`)).toStrictEqual(files);
    expect(journal.entries.map((entry) => entry.idx)).toStrictEqual(files.map((_, index) => index));
  });
});

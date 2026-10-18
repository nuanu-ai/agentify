/**
 * `pnpm account` as the operator runs it: the entry file, as a process. Run
 * without its configuration it must say which and fail, never exit as if a
 * command had been carried out.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "account.ts");
const tsx = join(here, "..", "node_modules", "tsx", "dist", "loader.mjs");

describe("the account command's entry file", () => {
  it("fails with the configuration it lacks rather than doing nothing", () => {
    const ran = spawnSync(process.execPath, ["--import", tsx, entry, "operator", "a@example.com"], {
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });

    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("the configuration is incomplete");
    expect(ran.stderr).toContain("DATABASE_URL");
  });
});

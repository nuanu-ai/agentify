/**
 * Who owns a scan, decided for an id read from a page's address before the
 * database is asked. The scanner here has no database, so an answer at all
 * says the database was not asked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stubOfflineScanner } from "../../testing/api";
import { owns } from "./auth";

beforeEach(stubOfflineScanner);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("owning a scan", () => {
  it.each(["not-a-scan-id", "", "0190f4c5-0000-7000-8000-00000000000z"])(
    "is nobody's for an id that is no scan's (%o), without asking the database",
    async (scanId) => {
      await expect(owns("0190f4c5-0000-7000-8000-0000000000aa", scanId)).resolves.toBe(false);
    },
  );

  it("asks the database for an id that has a scan id's shape", async () => {
    await expect(
      owns("0190f4c5-0000-7000-8000-0000000000aa", "0190f4c5-0000-7000-8000-000000000000"),
    ).rejects.toThrow();
  });
});

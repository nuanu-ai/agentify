/** The destructive database command must refuse unsafe targets before opening PostgreSQL. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "../../../../vitest.db.setup.js";

const opened = vi.hoisted(() => [] as string[]);
// Stop at native database I/O: none of these command-safety checks can erase a database.
vi.mock("pg", () => ({
  Pool: class {
    constructor(options: { connectionString: string }) {
      opened.push(options.connectionString);
    }
    async query() {
      throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" });
    }
    async end() {}
  },
}));

beforeEach(() => {
  opened.length = 0;
  vi.stubEnv("AGENTIFY_TEST_DATABASE_URL", undefined);
  vi.stubEnv("DATABASE_URL", undefined);
});
afterEach(() => vi.unstubAllEnvs());

const variables = ["AGENTIFY_TEST_DATABASE_URL", "DATABASE_URL"] as const;
const stack = "postgres://agentify:secret-marker@127.0.0.1:1/agentify";

describe("the destructive database command", () => {
  it("uses its independent default or the explicit disposable server, with specific configuration taking precedence", async () => {
    const fallback = "postgres://agentify:agentify@localhost:5432/agentify_test";
    const moved = "postgres://agentify:secret-marker@127.0.0.1:55432/agentify_test";
    const other = "postgres://someone:secret-marker@example.test:5432/somewhere_else";
    for (const [own, inherited, expected] of [
      [undefined, undefined, fallback],
      [undefined, "", fallback],
      [moved, undefined, moved],
      [moved, stack, moved],
      [undefined, other, other],
    ]) {
      vi.stubEnv("AGENTIFY_TEST_DATABASE_URL", own);
      vi.stubEnv("DATABASE_URL", inherited);
      opened.length = 0;
      await expect(setup()).rejects.toThrow(/there is none/);
      expect(opened).toEqual([expected]);
    }
  });

  it("refuses every spelling of the stack database before connecting and names a safe alternative", async () => {
    for (const variable of variables) {
      for (const url of [
        stack,
        "postgres://agentify:secret-marker@localhost:5432/agentify",
        "postgres://agentify:secret-marker@postgres:5432/agentify?sslmode=disable",
        "postgres://agentify:secret-marker@127.0.0.1:1/%61gentify",
      ]) {
        vi.stubEnv(variable, url);
        const failure = await setup().catch(String);
        expect(failure).toContain(variable);
        expect(failure).toContain('names "agentify"');
        expect(failure).toContain("agentify_test");
        expect(failure).not.toContain("secret-marker");
        expect(opened).toEqual([]);
        vi.stubEnv(variable, undefined);
      }
    }
    // Invoke the actual configured command too: dropping globalSetup must not bypass the guard.
    const result = await promisify(execFile)(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "vitest.db.config.ts",
        "--maxWorkers=1",
      ],
      { env: { ...process.env, AGENTIFY_TEST_DATABASE_URL: stack }, timeout: 20_000 },
    ).then(
      () => "unexpected success",
      (error: { stdout?: string; stderr?: string }) => `${error.stdout}\n${error.stderr}`,
    );
    expect(result).toContain('names "agentify"');
    expect(result).not.toContain("secret-marker");
  });

  it("refuses an omitted database instead of connecting to the database named after the user", async () => {
    for (const variable of variables) {
      for (const suffix of ["", "/"]) {
        vi.stubEnv(variable, `postgres://agentify:secret-marker@127.0.0.1:1${suffix}`);
        await expect(setup()).rejects.toThrow(/names no database/);
        expect(opened).toEqual([]);
        vi.stubEnv(variable, undefined);
      }
    }
  });

  it("refuses an explicitly empty dedicated URL instead of silently using the default server", async () => {
    vi.stubEnv("AGENTIFY_TEST_DATABASE_URL", "");
    await expect(setup()).rejects.toThrow(/AGENTIFY_TEST_DATABASE_URL is set to nothing/);
    expect(opened).toEqual([]);
  });

  it("identifies malformed configuration without exposing credentials or attempting a connection", async () => {
    for (const variable of variables) {
      vi.stubEnv(variable, "postgres//agentify:secret-marker@localhost/x");
      const failure = await setup().catch(String);
      expect(failure).toContain(variable);
      expect(failure).not.toContain("secret-marker");
      expect(opened).toEqual([]);
      vi.stubEnv(variable, undefined);
    }
  });
});

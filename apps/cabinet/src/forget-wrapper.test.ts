/** The Mac-side TEST wrapper of `pnpm forget` as a process, with a fake local ssh binary. */

import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const wrapper = join(root, "scripts", "forget.mjs");
const tsx = join(root, "apps", "cabinet", "node_modules", "tsx", "dist", "loader.mjs");
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map(async (path) => await rm(path, { force: true, recursive: true })),
  );
});

async function fakeSsh(
  exitCode = 0,
  terminate = false,
): Promise<{
  readonly path: string;
  readonly argumentsFile: string;
  readonly inputFile: string;
}> {
  const path = await mkdtemp(join(tmpdir(), "agentify-forget-"));
  temporary.push(path);
  const argumentsFile = join(path, "arguments");
  const inputFile = join(path, "input");
  const executable = join(path, "ssh");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${JSON.stringify(argumentsFile)}`,
      `dd of=${JSON.stringify(inputFile)} status=none`,
      terminate ? "kill -TERM $$" : `exit ${exitCode}`,
      "",
    ].join("\n"),
  );
  await chmod(executable, 0o755);
  return { path, argumentsFile, inputFile };
}

async function invoked(
  argv: readonly string[],
  sshExitCode = 0,
  terminate = false,
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ssh: Awaited<ReturnType<typeof fakeSsh>>;
}> {
  const ssh = await fakeSsh(sshExitCode, terminate);
  try {
    const result = await execute(process.execPath, [wrapper, ...argv], {
      env: { ...process.env, PATH: `${ssh.path}:${process.env.PATH ?? ""}` },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr, ssh };
  } catch (thrown) {
    const failed = thrown as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      ssh,
    };
  }
}

describe("pnpm forget's local TEST wrapper", () => {
  it("shows help locally without opening ssh", async () => {
    const result = await invoked(["--help"]);

    expect(result.code).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/test/i);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/pnpm forget <email>/i);
    await expect(readFile(result.ssh.argumentsFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires exactly one email and does not open ssh when it is absent", async () => {
    const result = await invoked([]);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/pnpm forget <email>/i);
    await expect(readFile(result.ssh.argumentsFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("passes arbitrary email text only on stdin to one fixed command on the TEST host", async () => {
    const email = "merchant@example.com; touch /tmp/this-must-not-run";
    const result = await invoked([email]);

    expect(result.code).toBe(0);
    await expect(readFile(result.ssh.inputFile, "utf8")).resolves.toBe(`${email}\n`);
    await expect(readFile(result.ssh.argumentsFile, "utf8")).resolves.toBe(
      `${[
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
      ].join("\n")}\n`,
    );
  });

  it("forwards a refusal from the remote command as its own exit code", async () => {
    const result = await invoked([EMAIL], 1);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.code).toBe(1);
    expect(output).not.toMatch(/unknown|uncertain/i);
    expect(output).not.toMatch(/again/i);
  });

  it("describes an interrupted ssh result as unknown and safe to run again", async () => {
    const result = await invoked([EMAIL], 255);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.code).not.toBe(0);
    expect(output).toMatch(/unknown/i);
    expect(output).toMatch(/again/i);
  });

  it("treats a terminated ssh process as an unknown outcome", async () => {
    const result = await invoked([EMAIL], 0, true);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.code).not.toBe(0);
    expect(output).toMatch(/unknown/i);
    expect(output).toMatch(/again/i);
  });

  const DATABASE = `postgresql://operator:${"p".repeat(24)}@127.0.0.1/agentify`;
  const TEST = "eip155:84532";
  const SECRET = "x".repeat(40);

  it.each([
    {
      case: "no payment network",
      set: { DATABASE_URL: DATABASE, AUTH_SECRET: SECRET },
      words: /PAYMENT_NETWORK is not set/i,
    },
    {
      case: "an unrecognised network",
      set: { PAYMENT_NETWORK: "eip155:1", DATABASE_URL: DATABASE, AUTH_SECRET: SECRET },
      words: /not a recogni[sz]ed network/i,
    },
    {
      case: "the live network",
      set: { PAYMENT_NETWORK: "eip155:8453", DATABASE_URL: DATABASE, AUTH_SECRET: SECRET },
      words: /live network/i,
    },
    {
      case: "no database address",
      set: { PAYMENT_NETWORK: TEST, AUTH_SECRET: SECRET },
      words: /DATABASE_URL is not set/i,
    },
    {
      case: "no cabinet secret",
      set: { PAYMENT_NETWORK: TEST, DATABASE_URL: DATABASE },
      words: /AUTH_SECRET is not set/i,
    },
  ])("the server command refuses $case before reading a database", ({ set, words }) => {
    const unset = new Set(["PAYMENT_NETWORK", "DATABASE_URL", "AUTH_SECRET"]);
    const result = spawnSync(
      process.execPath,
      ["--import", tsx, join(root, "apps", "cabinet", "src", "forget.ts")],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !unset.has(name))),
          ...set,
        },
        input: `${EMAIL}\n`,
        // A command that hangs fails here instead of holding the suite.
        timeout: 20_000,
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toMatch(words);
    expect(output).not.toContain(DATABASE);
  });
});

const EMAIL = "merchant@example.com";

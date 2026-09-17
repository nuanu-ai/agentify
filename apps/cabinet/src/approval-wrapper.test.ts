/** The Mac-side production wrapper as a process, with a fake local ssh binary. */

import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const wrapper = join(root, "scripts", "approve.mjs");
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
  const path = await mkdtemp(join(tmpdir(), "agentify-approve-"));
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

describe("pnpm approve's local production wrapper", () => {
  it("shows production help locally without opening ssh", async () => {
    const result = await invoked(["--help"]);

    expect(result.code).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/production/i);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/pnpm approve <email>/i);
    await expect(readFile(result.ssh.argumentsFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires exactly one email and does not open ssh when it is absent", async () => {
    const result = await invoked([]);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/production/i);
    await expect(readFile(result.ssh.argumentsFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("passes arbitrary email text only on stdin to one fixed production command", async () => {
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
      ].join("\n")}\n`,
    );
  });

  it("describes an interrupted ssh result as unknown and safe to inspect by retrying", async () => {
    const result = await invoked([EMAIL], 255);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.code).not.toBe(0);
    expect(output).toMatch(/production/i);
    expect(output).toMatch(/unknown|uncertain/i);
    expect(output).toMatch(/retry/i);
    expect(output).not.toMatch(/approval failed|was not approved/i);
  });

  it("treats a terminated ssh process as an unknown one-way outcome", async () => {
    const result = await invoked([EMAIL], 0, true);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.code).not.toBe(0);
    expect(output).toMatch(/production/i);
    expect(output).toMatch(/unknown|uncertain/i);
    expect(output).toMatch(/retry/i);
    expect(output).not.toMatch(/approval failed|was not approved/i);
  });

  it("the server command refuses a test payment network before reading a production database", () => {
    const secret = "postgresql://operator:password-must-stay-secret@127.0.0.1/production";
    const result = spawnSync(
      process.execPath,
      ["--import", tsx, join(root, "apps", "cabinet", "src", "approve.ts")],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: secret,
          PAYMENT_NETWORK: "eip155:84532",
        },
        input: `${EMAIL}\n`,
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/production/i);
    expect(output).toMatch(/not the live network/i);
    expect(output).not.toContain(secret);
  });
});

const EMAIL = "merchant@example.com";

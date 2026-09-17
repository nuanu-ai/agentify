/** The Mac-side production wrapper as a process, with a fake local ssh binary. */

import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const wrapper = join(root, "scripts", "approve.mjs");
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map(async (path) => await rm(path, { force: true, recursive: true })),
  );
});

async function fakeSsh(exitCode = 0): Promise<{
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
      `exit ${exitCode}`,
      "",
    ].join("\n"),
  );
  await chmod(executable, 0o755);
  return { path, argumentsFile, inputFile };
}

async function invoked(
  argv: readonly string[],
  sshExitCode = 0,
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ssh: Awaited<ReturnType<typeof fakeSsh>>;
}> {
  const ssh = await fakeSsh(sshExitCode);
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
      [
        "agentify",
        "docker",
        "exec",
        "-i",
        "agentify-commerce-cabinet-1",
        "pnpm",
        "--filter",
        "@agentify/commerce-cabinet",
        "approve",
      ].join("\n") + "\n",
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
});

const EMAIL = "merchant@example.com";

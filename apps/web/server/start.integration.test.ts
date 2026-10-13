/**
 * The built scanner started the way its image starts it: `server.js`, the
 * package's manifest and `dist`, alone in a directory with no `node_modules`
 * anywhere above it, run by Node. It must come up, answer its liveness probe
 * and a page whose every script it serves, and stop when told to. Nothing
 * else exercises the start: the budget and the browser test load the build's
 * server module themselves, so a build that `server.js` cannot start passes
 * both.
 *
 * It is asked of the build as it was written, and of the same build laid out
 * as Vite lays it out once an `import()` in server code splits it: the entry
 * a facade, and the process's own code in a chunk under `dist/server/assets`.
 * Which of the two a build is depends on what its routes import, so the start
 * must not.
 *
 *   pnpm --filter @agentify/web build
 *   pnpm scanner:test:start
 */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP = fileURLToPath(new URL("..", import.meta.url));
if (!existsSync(join(APP, "dist", "server", "index.js"))) {
  throw new Error("the start check runs the scanner's build: pnpm --filter @agentify/web build");
}

const freePort = async (): Promise<number> => {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

/**
 * Moves the server's code into a chunk under `dist/server/assets`, its
 * references to the chunks beside it rewritten as from there, and leaves a
 * facade at the entry that re-exports it.
 */
const splitAsAnImportSplitsIt = async (directory: string): Promise<void> => {
  const server = join(directory, "dist", "server");
  const code = await readFile(join(server, "index.js"), "utf8");
  await writeFile(join(server, "assets", "app-SpLiT000.js"), code.replaceAll('"./assets/', '"./'));
  await writeFile(join(server, "index.js"), 'export * from "./assets/app-SpLiT000.js";\n');
};

const LAYOUTS = [
  ["as it was built", async (_directory: string) => {}],
  ["split as an import() in server code splits it", splitAsAnImportSplitsIt],
] as const;

describe.each(LAYOUTS)("the built scanner %s, started as its image starts it", (_layout, lay) => {
  let directory = "";
  let scanner: ChildProcess;
  let output = "";
  let origin = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "scanner-image-"));
    for (const part of ["server.js", "package.json", "dist"]) {
      await cp(join(APP, part), join(directory, part), { recursive: true });
    }
    await lay(directory);
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    scanner = spawn(process.execPath, ["server.js"], {
      cwd: directory,
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "production",
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        APP_BASE_URL: "https://agentify.ad",
        DATABASE_URL: "postgresql://nobody:unused@127.0.0.1:1/nowhere",
        TOKEN_HMAC_SECRET: "t".repeat(32),
        REGISTRATION_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [scanner.stdout, scanner.stderr]) {
      stream?.on("data", (chunk) => {
        output = `${output}${chunk}`.slice(-20_000);
      });
    }
    const deadline = Date.now() + 30_000;
    for (;;) {
      const live = await fetch(`${origin}/api/health/live`).then(
        (answer) => answer.status,
        () => 0,
      );
      if (live !== 0) break;
      if (scanner.exitCode !== null || Date.now() > deadline) {
        throw new Error(`the built scanner did not start\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });

  afterAll(async () => {
    if (scanner?.exitCode === null) {
      scanner.kill("SIGKILL");
      await once(scanner, "exit");
    }
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  it("answers its liveness probe", async () => {
    const answered = await fetch(`${origin}/api/health/live`);

    expect(answered.status, output).toBe(200);
    expect(await answered.json()).toMatchObject({ status: "ok", service: "web" });
  });

  it("draws the front page and serves every script it names", async () => {
    const answered = await fetch(`${origin}/`);
    const html = await answered.text();
    const scripts = [
      ...html.matchAll(/(?:<link rel="modulepreload" href=|import\(?\s*)"(\/assets\/[^"]+\.js)"/g),
    ].map((match) => match[1] ?? "");

    expect(answered.status, output).toBe(200);
    expect(html).toContain("<h1");
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of new Set(scripts)) {
      expect((await fetch(`${origin}${script}`)).status, script).toBe(200);
    }
  });

  it("stops when told to", async () => {
    scanner.kill("SIGTERM");
    const [code] = (await once(scanner, "exit")) as [number | null];

    expect(code).toBe(143);
  });
});

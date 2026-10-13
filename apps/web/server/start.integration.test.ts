/**
 * The built scanner started the way its image starts it: `server.js`, the
 * package's manifest and `dist`, alone in a directory with no `node_modules`
 * anywhere above it, run by Node. It must come up, answer its liveness probe
 * and a page whose every script it serves, draw the pictures that page's head
 * names with the renderer and fonts its build carries, and stop when told to.
 * Nothing else exercises the start: the budget and the browser test load the
 * build's server module themselves, so a build that `server.js` cannot start
 * passes both.
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
import { fakePostgres } from "@agentify/scanner-database/fake-postgres";
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

/** The built scanner started from `directory` as its image starts it, once it answers. */
interface Started {
  readonly scanner: ChildProcess;
  readonly origin: string;
  /** Everything it has written to stdout and stderr so far. */
  output(): string;
}

const startIn = async (
  directory: string,
  settings: Readonly<Record<string, string>> = {},
  nodeArguments: readonly string[] = [],
): Promise<Started> => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let output = "";
  const scanner = spawn(process.execPath, [...nodeArguments, "server.js"], {
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
      ...settings,
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
  return { scanner, origin, output: () => output };
};

const stop = async ({ scanner }: Started): Promise<void> => {
  if (scanner.exitCode === null && scanner.signalCode === null) {
    scanner.kill("SIGKILL");
    await once(scanner, "exit");
  }
};

/** A copy of the build, as the image holds it, in a directory of its own. */
const imageIn = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "scanner-image-"));
  for (const part of ["server.js", "package.json", "dist"]) {
    await cp(join(APP, part), join(directory, part), { recursive: true });
  }
  return directory;
};

describe.each(LAYOUTS)("the built scanner %s, started as its image starts it", (_layout, lay) => {
  let directory = "";
  let started: Started;
  let origin = "";
  const output = () => started.output();

  beforeAll(async () => {
    directory = await imageIn();
    await lay(directory);
    started = await startIn(directory);
    origin = started.origin;
  });

  afterAll(async () => {
    if (started !== undefined) await stop(started);
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  it("answers its liveness probe", async () => {
    const answered = await fetch(`${origin}/api/health/live`);

    expect(answered.status, output()).toBe(200);
    expect(await answered.json()).toMatchObject({ status: "ok", service: "web" });
  });

  it("draws the front page and serves every script it names", async () => {
    const answered = await fetch(`${origin}/`);
    const html = await answered.text();
    const scripts = [
      ...html.matchAll(/(?:<link rel="modulepreload" href=|import\(?\s*)"(\/assets\/[^"]+\.js)"/g),
    ].map((match) => match[1] ?? "");

    expect(answered.status, output()).toBe(200);
    expect(html).toContain("<h1");
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of new Set(scripts)) {
      expect((await fetch(`${origin}${script}`)).status, script).toBe(200);
    }
  });

  it("draws the pictures the front page's head names, from what its build carries", async () => {
    const head = await (await fetch(`${origin}/`)).text();
    const pictures = [
      head.match(/<meta property="og:image" content="([^"]+)"/)?.[1],
      head.match(/<link rel="apple-touch-icon" href="([^"]+)"/)?.[1],
    ].map((address) => new URL(address ?? "", origin).pathname);

    for (const picture of pictures) {
      const answered = await fetch(`${origin}${picture}`);
      const bytes = new Uint8Array(await answered.arrayBuffer());
      expect(answered.status, `${picture}\n${output()}`).toBe(200);
      expect(answered.headers.get("content-type"), picture).toBe("image/png");
      expect([...bytes.subarray(1, 4)], picture).toEqual([0x50, 0x4e, 0x47]);
    }
  });

  it("stops when told to", async () => {
    started.scanner.kill("SIGTERM");
    const [code] = (await once(started.scanner, "exit")) as [number | null];

    expect(code).toBe(143);
  });
});

/** Until `done` holds or five seconds pass, then a moment longer for whatever follows it. */
const settled = async (done: () => boolean): Promise<void> => {
  for (let waited = 0; !done() && waited < 5_000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
};

describe("the built scanner, when a failure reaches it that no request waits on", () => {
  let directory = "";

  beforeAll(async () => {
    directory = await imageIn();
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  it("goes on answering when the database closes its idle connections, and its log names no user, database or port", async () => {
    const database = await fakePostgres();
    const started = await startIn(directory, { DATABASE_URL: database.url });
    try {
      // Readiness asks the database twice, which leaves its connections idle in the pool.
      const ready = (await (await fetch(`${started.origin}/api/health`)).json()) as {
        dependencies: { database: string };
      };
      expect(ready.dependencies.database, started.output()).toBe("ok");
      const before = started.output().length;

      database.drop();
      await settled(() => started.output().length > before || started.scanner.exitCode !== null);

      const after = started.output().slice(before);
      expect(started.scanner.exitCode, after).toBeNull();
      expect((await fetch(`${started.origin}/api/health/live`)).status).toBe(200);
      expect(after).toContain('"event":"web_database_connection_failed"');
      expect(after).not.toContain(database.user);
      expect(after).not.toContain(database.database);
      expect(after).not.toMatch(new RegExp(`\\b${database.port}\\b`));
    } finally {
      await stop(started);
      await database.close();
    }
  });

  it.each([
    ["an exception", "web_uncaught_exception", "throw failure"],
    ["a rejection", "web_unhandled_rejection", "void Promise.reject(failure)"],
  ])(
    "ends with status 1 on %s nothing caught, for its supervisor to start afresh, and logs its kind, never its words",
    async (_what, event, how) => {
      const words = "a failure quoting postgresql://someone@db.internal:5432/rows";
      // Loaded before the process, it fails as nothing in the process expects
      // once the test asks it to.
      await writeFile(
        join(directory, "fails-when-asked.mjs"),
        `process.on("SIGUSR2", () => {
          const failure = Object.assign(new Error(${JSON.stringify(words)}), { code: "E_STAND_IN" });
          ${how};
        });\n`,
      );
      const started = await startIn(directory, {}, ["--import", "./fails-when-asked.mjs"]);
      try {
        const before = started.output().length;
        // `close` rather than `exit`: only then has everything it wrote been read.
        const exited = once(started.scanner, "close") as Promise<[number | null]>;

        started.scanner.kill("SIGUSR2");
        const [code] = await exited;

        const after = started.output().slice(before);
        expect(code, after).toBe(1);
        expect(after).not.toContain(words);
        expect(
          after
            .split("\n")
            .filter((line) => line.startsWith("{"))
            .map((line) => JSON.parse(line)),
        ).toEqual([
          expect.objectContaining({ event, error_type: "Error", error_code: "E_STAND_IN" }),
        ]);
      } finally {
        await stop(started);
      }
    },
  );
});

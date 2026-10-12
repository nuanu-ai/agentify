/**
 * The browser's scripts and styles as the process serves them from a build:
 * the compressed copy the build wrote where the browser accepts it, the file
 * itself where it accepts neither, and a year's lifetime either way because
 * every name carries a content hash. The build here is a directory written by
 * the test, so no build has to run.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { precompressedFrom } from "./pages.js";

const SCRIPT = "console.log('the page came alive');\n".repeat(40);

let directory = "";
let url = "";
let close = async (): Promise<void> => {};

beforeAll(async () => {
  // Under a directory whose name starts with a dot, as a checkout under a
  // tool's hidden directory is: a file server that refuses dotfiles by default
  // reads the whole path and refuses every file there.
  directory = await mkdtemp(join(await mkdtemp(join(tmpdir(), ".dashboard-")), "assets-"));
  await writeFile(join(directory, "entry-AbC123.js"), SCRIPT);
  await writeFile(join(directory, "entry-AbC123.js.br"), brotliCompressSync(SCRIPT));
  await writeFile(join(directory, "entry-AbC123.js.gz"), gzipSync(SCRIPT));
  // Built without compressed copies, as nothing compressed a file this small.
  await writeFile(join(directory, "styles-XyZ789.css"), "body{margin:0}");
  await writeFile(join(directory, "notes.txt"), "not something the build writes");
  const app = express();
  app.use("/dashboard/assets", await precompressedFrom(directory));
  app.use((_request, response) => {
    response.status(418).send("fell through");
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dashboard/assets`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await close();
  await rm(join(directory, ".."), { recursive: true, force: true });
});

/** As the bytes arrive: `fetch` would undo the encoding before a test saw it. */
const asked = (
  name: string,
  acceptEncoding: string,
): Promise<{ answered: { status: number; headers: Headers }; body: Buffer }> =>
  new Promise((resolve, reject) => {
    get(`${url}/${name}`, { headers: { "accept-encoding": acceptEncoding } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === "string") headers.set(key, value);
        }
        resolve({
          answered: { status: response.statusCode ?? 0, headers },
          body: Buffer.concat(chunks),
        });
      });
    }).on("error", reject);
  });

describe("the browser's scripts and styles", () => {
  it("are sent compressed with brotli to a browser that accepts it, as the same script", async () => {
    const { answered, body } = await asked("entry-AbC123.js", "gzip, deflate, br, zstd");

    expect(answered.status).toBe(200);
    expect(answered.headers.get("content-encoding")).toBe("br");
    expect(answered.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(answered.headers.get("vary")).toMatch(/accept-encoding/i);
    expect(brotliDecompressSync(body).toString()).toBe(SCRIPT);
  });

  it("are sent with gzip to a browser that accepts only that, and whole to one that accepts neither", async () => {
    const gzipped = await asked("entry-AbC123.js", "gzip");
    const plain = await asked("entry-AbC123.js", "identity");
    const refused = await asked("entry-AbC123.js", "br;q=0, gzip;q=0");

    expect(gzipped.answered.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(gzipped.body).toString()).toBe(SCRIPT);
    expect(plain.answered.headers.get("content-encoding")).toBeNull();
    expect(plain.body.toString()).toBe(SCRIPT);
    expect(refused.answered.headers.get("content-encoding")).toBeNull();
    expect(refused.body.toString()).toBe(SCRIPT);
  });

  it("are sent whole where the build wrote no compressed copy", async () => {
    const { answered, body } = await asked("styles-XyZ789.css", "br, gzip");

    expect(answered.headers.get("content-encoding")).toBeNull();
    expect(answered.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(body.toString()).toBe("body{margin:0}");
  });

  it("may be kept by any cache for a year, since a changed file has a new name", async () => {
    for (const name of ["entry-AbC123.js", "styles-XyZ789.css"]) {
      const { answered } = await asked(name, "br");
      expect(answered.status, name).toBe(200);
      expect(answered.headers.get("cache-control"), name).toBe(
        "public, max-age=31536000, immutable",
      );
    }
  });

  it("answers nothing the build did not write as a script or a style, and reaches no other path", async () => {
    for (const name of ["missing-000.js", "notes.txt", "..%2Fpages.ts", "..%2F..%2Fpackage.json"]) {
      const { answered } = await asked(name, "br");
      expect(answered.status, name).toBe(404);
      expect(answered.headers.get("cache-control"), name).toBeNull();
    }
  });
});

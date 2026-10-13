/**
 * The browser's built files, both halves: the build step that writes a
 * compressed copy beside each script and stylesheet, and the handler that
 * sends them. Every name the build writes carries a content hash, so what is
 * sent may be kept by any cache for a year.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { RequestHandler } from "express";

/**
 * Writes a brotli copy at its highest quality and a gzip copy beside every
 * script and stylesheet in `directory`, so a server sends the smaller file
 * without compressing on each request; the edge in front of the origin has no
 * brotli encoder of its own. Returns how many files it compressed.
 */
export async function precompress(directory: string): Promise<number> {
  const written = (await readdir(directory)).filter((name) => /\.(?:js|css)$/.test(name));
  await Promise.all(
    written.map(async (name) => {
      const path = join(directory, name);
      const body = await readFile(path);
      await writeFile(
        `${path}.br`,
        brotliCompressSync(body, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
          },
        }),
      );
      await writeFile(`${path}.gz`, gzipSync(body, { level: constants.Z_BEST_COMPRESSION }));
    }),
  );
  return written.length;
}

const TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * The encodings a browser accepts, best first. Only the ones the build writes
 * are asked about; one named with `q=0` is refused, as the header's grammar
 * says.
 */
const accepted = (header: string | undefined): readonly string[] => {
  const said = (header ?? "").split(",").map((part) => {
    const [name = "", ...parameters] = part.trim().toLowerCase().split(";");
    const refused = parameters.some((parameter) => /^\s*q=0(?:\.0*)?\s*$/.test(parameter));
    return refused ? "" : name.trim();
  });
  return ["br", "gzip"].filter((encoding) => said.includes(encoding) || said.includes("*"));
};

/**
 * The built scripts and styles in `directory`, which carry a content hash in
 * their names and so may be kept by any cache for a year. Each is sent
 * compressed as the build wrote it where the browser accepts that encoding.
 * Only files listed when the process started are answered, so no path in a
 * request reaches the disk; anything else is answered 404.
 */
export async function precompressedFrom(directory: string): Promise<RequestHandler> {
  const names = new Set(await readdir(directory));
  return (request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      next();
      return;
    }
    let name: string;
    try {
      name = decodeURIComponent(request.path.slice(1));
    } catch {
      name = "";
    }
    const type = TYPES[extname(name)];
    if (!names.has(name) || type === undefined) {
      response.status(404).type("text/plain").send("No such file.");
      return;
    }
    const encoding = accepted(request.headers["accept-encoding"]).find((each) =>
      names.has(`${name}.${each === "gzip" ? "gz" : each}`),
    );
    // Named under the directory rather than joined to it, so a directory with a
    // dot in its path, a checkout under a tool's hidden one, is not refused as
    // a dotfile; and the headers are given to the send, so a send that fails
    // leaves none of them on the error page.
    response.sendFile(
      encoding === undefined ? name : `${name}.${encoding === "gzip" ? "gz" : encoding}`,
      {
        root: directory,
        maxAge: "1y",
        immutable: true,
        headers: {
          "content-type": type,
          vary: "accept-encoding",
          ...(encoding === undefined ? {} : { "content-encoding": encoding }),
        },
      },
      (error) => {
        if (error !== undefined && !response.headersSent) next(error);
      },
    );
  };
}

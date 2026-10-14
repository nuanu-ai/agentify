/**
 * A local stand-in for the `/docs` block of deploy/Caddyfile, for measuring a
 * built documentation without Caddy: the prefix stripped, a path tried as a
 * file, then with `.html`, then as a directory's `index.html`; HTML templated
 * the way the block's `templates` directive fills the surface marker; a
 * missing page answered with the build's `404.html` and status 404; the
 * shared marks and faces served from packages/visual/public; text compressed
 * with gzip as Caddy's `encode` would; and `Last-Modified` and `ETag` on every
 * file as Caddy's file server sends them, with no `Cache-Control`.
 *
 * Only the template forms the marker uses are understood, and a page left
 * with any other `<!--{{` is refused, so a template this does not know cannot
 * pass for a filled one.
 *
 *   node docs/research/47-one-docs-stack/serve.mjs <built directory> <port> [mode]
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const [root, port = "4747", mode = "test"] = process.argv.slice(2);
if (root === undefined) throw new Error("name the built directory to serve");
const SHARED = fileURLToPath(new URL("../../../packages/visual/public", import.meta.url));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".data": "application/octet-stream",
};

const ENV = /<!--\{\{env `AGENTIFY_SURFACE_MODE`\}\}-->/g;
const BRANCHES =
  /<!--\{\{if eq \(env "AGENTIFY_SURFACE_MODE"\) "(\w+)"\}\}-->([\s\S]*?)<!--\{\{else if eq \(env "AGENTIFY_SURFACE_MODE"\) "(\w+)"\}\}-->([\s\S]*?)<!--\{\{end\}\}-->/g;

const templated = (html) => {
  const filled = html
    .replace(ENV, mode)
    .replace(BRANCHES, (_all, first, a, second, b) =>
      mode === first ? a : mode === second ? b : "",
    );
  if (filled.includes("<!--{{")) throw new Error("a template this stand-in does not know");
  return filled;
};

const file = async (path) => {
  try {
    const found = await stat(path);
    return found.isFile() ? found : null;
  } catch {
    return null;
  }
};

const send = async (request, response, path, info, status = 200) => {
  const type = TYPES[extname(path)] ?? "application/octet-stream";
  let body = await readFile(path);
  if (type.startsWith("text/html")) body = Buffer.from(templated(body.toString("utf8")));
  const etag = `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
  const headers = {
    "content-type": type,
    "last-modified": info.mtime.toUTCString(),
    etag,
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  };
  if (status === 200 && request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers).end();
    return;
  }
  const compressible = /^(text\/|application\/(json|octet-stream)|image\/svg)/.test(type);
  if (compressible && /\bgzip\b/.test(request.headers["accept-encoding"] ?? "")) {
    body = gzipSync(body);
    headers["content-encoding"] = "gzip";
    headers.vary = "Accept-Encoding";
  }
  response.writeHead(status, headers).end(body);
};

createServer(async (request, response) => {
  const { pathname } = new URL(request.url ?? "/", "http://localhost");
  const path = normalize(decodeURIComponent(pathname));
  if (
    /^\/(assets\/agentify-mark(-heavy)?\.svg|styles\/fonts\.css|styles\/fonts\/[^/]+\.woff2)$/.test(
      path,
    )
  ) {
    const info = await file(join(SHARED, path));
    if (info !== null) return send(request, response, join(SHARED, path), info);
  }
  if (path === "/docs") {
    response.writeHead(302, { location: "/docs/" }).end();
    return;
  }
  if (path.startsWith("/docs/")) {
    const inside = path.slice("/docs".length);
    for (const candidate of [inside, `${inside}.html`, join(inside, "index.html")]) {
      const info = await file(join(root, candidate));
      if (info !== null) return send(request, response, join(root, candidate), info);
    }
    const missing = join(root, "404.html");
    const info = await file(missing);
    if (info !== null) return send(request, response, missing, info, 404);
  }
  response.writeHead(404, { "content-type": "text/plain" }).end("not here\n");
}).listen(Number(port), "127.0.0.1", () => {
  console.log(`serving ${root} at http://127.0.0.1:${port}/docs/ as the ${mode} channel`);
});

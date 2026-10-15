/**
 * A stand-in for the `/docs` block of `deploy/Caddyfile`, for the browser
 * tests and the speed budget, which run without Caddy. What the block decides
 * by rules of its own is read from the Caddyfile itself: the expressions that
 * tell a client preferring Markdown, the redirect of an address ending in
 * `.html`, how long a browser may keep the built assets, a page's data and a
 * page, and the type a page's data is sent as. The rest is the block's behaviour written out again, and only
 * it: the prefix stripped, a page found as its address or its address with
 * `.html`, HTML and Markdown filled as Caddy's templates fill them, every
 * other file sent with the validators Caddy's file server gives it, a missing
 * page answered with `404.html` and status 404, a script sent as the brotli
 * or gzip copy beside it, and the shared marks and faces served from
 * `packages/visual/public`. Anything else goes to `upstream`, which stands
 * for the scanner, or is answered 404.
 */

import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { type Environment, fillTemplates } from "./caddy-templates.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SHARED = join(ROOT, "packages", "visual", "public");
export const BUILT = fileURLToPath(new URL("../dist/client", import.meta.url));

const CADDYFILE = readFileSync(join(ROOT, "deploy", "Caddyfile"), "utf8");

const found = (pattern: RegExp, what: string): string => {
  const value = pattern.exec(CADDYFILE)?.[1];
  if (value === undefined) throw new Error(`deploy/Caddyfile no longer says ${what}`);
  return value;
};

/** Go's `(?i)` written as JavaScript's flag; the rest of these expressions reads the same in both. */
const goRegExp = (written: string): RegExp =>
  written.startsWith("(?i)") ? new RegExp(written.slice(4), "i") : new RegExp(written);

/** The block's own rules, as the Caddyfile writes them. */
export const RULES = {
  prefersMarkdown: goRegExp(
    found(/@docs_markdown \{\s*header_regexp Accept `([^`]+)`/, "which clients prefer Markdown"),
  ),
  htmlBefore: goRegExp(
    found(/@docs_markdown \{[^}]*not header_regexp Accept `([^`]+)`/, "when HTML comes first"),
  ),
  formerAddress: goRegExp(found(/@docs_html path_regexp docs_html (\S+)/, "which addresses move")),
  slashAddress: goRegExp(
    found(/@docs_page_slash path_regexp docs_page_slash (\S+)/, "which page slashes move"),
  ),
  slashReserved: found(
    /@docs_page_exists\s*\{\s*not path ([^\n]+)/,
    "which generated pages have no slash alias",
  )
    .trim()
    .split(/\s+/),
  assetsKept: found(/header @docs_assets Cache-Control "([^"]+)"/, "how long assets are kept"),
  dataType: found(/header @docs_data Content-Type "([^"]+)"/, "what type a page's data is"),
  dataKept: found(/header @docs_kept Cache-Control "([^"]+)"/, "how long a page's data is kept"),
  pagesKept: found(/header @docs_pages Cache-Control (\S+)/, "how long a page is kept"),
} as const;

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".data": RULES.dataType,
};

const fileAt = async (path: string): Promise<string | null> => {
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
};

/** Whether a client with this Accept header is answered with Markdown. */
export const prefersMarkdown = (accept: string): boolean =>
  RULES.prefersMarkdown.test(accept) && !RULES.htmlBefore.test(accept);

/** The channels the tests stand the documentation on, as their environment files name them. */
export const CHANNELS = {
  test: {
    AGENTIFY_SURFACE_MODE: "test",
    AGENTIFY_PUBLIC_ORIGIN: "https://test.agentify.ad",
    ABUSE_EMAIL: "abuse@test.agentify.ad",
    LEGAL_OPERATOR: "Operator identity pending confirmation",
    LEGAL_IDENTITY_CONFIRMED: "false",
  },
  live: {
    AGENTIFY_SURFACE_MODE: "live",
    AGENTIFY_PUBLIC_ORIGIN: "https://agentify.ad",
    ABUSE_EMAIL: "abuse@agentify.ad",
    LEGAL_OPERATOR: "Operator identity pending confirmation",
    LEGAL_IDENTITY_CONFIRMED: "false",
  },
} as const satisfies Readonly<Record<string, Environment>>;

type Upstream = (request: IncomingMessage, response: ServerResponse) => void;

export type Edge = Readonly<{ origin: string; close: () => Promise<void> }>;

/** Serves the built documentation at `/docs` on a loopback port as the channel's Caddy would. */
export async function standEdge({
  environment,
  upstream,
  heard,
}: Readonly<{
  environment: Environment;
  upstream?: Upstream;
  /** Told of every request that reaches the edge, by its method and path. */
  heard?: (request: string) => void;
}>): Promise<Edge> {
  const send = async (
    request: IncomingMessage,
    response: ServerResponse,
    file: string,
    { status = 200, headers = {} }: { status?: number; headers?: Record<string, string> } = {},
  ) => {
    const type = headers["content-type"] ?? TYPES[extname(file)] ?? "application/octet-stream";
    const accepts = request.headers["accept-encoding"] ?? "";
    const sent: Record<string, string> = { "content-type": type, ...headers };
    let body: Buffer;
    const templated = /^text\/(html|markdown)/.test(type);
    if (!templated) {
      // As Caddy's file server validates a file it sends whole; its templates
      // drop the validators of what they fill.
      const { mtime, size } = await stat(file);
      const etag = `"${mtime.getTime().toString(36)}${size.toString(36)}"`;
      Object.assign(sent, { etag, "last-modified": mtime.toUTCString() });
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, sent).end();
        return;
      }
    }
    const brotli = /\bbr\b/.test(accepts) ? await fileAt(`${file}.br`) : null;
    if (brotli !== null) {
      body = await readFile(brotli);
      Object.assign(sent, { "content-encoding": "br", vary: "Accept-Encoding" });
    } else {
      body = await readFile(file);
      if (templated) {
        body = Buffer.from(fillTemplates(body.toString("utf8"), environment));
      }
      if (/^(text\/|application\/json|image\/svg)/.test(type) && /\bgzip\b/.test(accepts)) {
        body = gzipSync(body);
        sent["content-encoding"] = "gzip";
        sent.vary = [sent.vary, "Accept-Encoding"].filter(Boolean).join(", ");
      }
    }
    response.writeHead(status, sent);
    response.end(request.method === "HEAD" ? undefined : body);
  };

  const answer = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://edge.invalid");
    const path = normalize(decodeURIComponent(url.pathname));
    if (
      /^\/(assets\/agentify-mark(-heavy)?\.svg|styles\/fonts\.css|styles\/fonts\/[^/]+\.woff2)$/.test(
        path,
      )
    ) {
      const shared = await fileAt(join(SHARED, path));
      if (shared !== null) return send(request, response, shared);
    }
    if (path === "/docs") {
      response.writeHead(302, { location: "/docs/" }).end();
      return;
    }
    const former = RULES.formerAddress.exec(path);
    if (former !== null) {
      response.writeHead(308, { location: `/docs/${former[1] ?? ""}${url.search}` }).end();
      return;
    }
    if (!path.startsWith("/docs/")) {
      if (upstream !== undefined) return upstream(request, response);
      response.writeHead(404, { "content-type": "text/plain" }).end("not here\n");
      return;
    }
    const inside = path.slice("/docs".length);
    const slash = RULES.slashAddress.exec(inside);
    if (
      slash !== null &&
      !RULES.slashReserved.includes(inside) &&
      (await fileAt(join(BUILT, `${slash[1]}.html`))) !== null
    ) {
      response.writeHead(308, { location: `/docs/${slash[1]}${url.search}` }).end();
      return;
    }
    const markdown = {
      "content-type": TYPES[".md"] ?? "",
      "cache-control": RULES.pagesKept,
      vary: "Accept",
    };
    if (prefersMarkdown(request.headers.accept ?? "")) {
      for (const candidate of [`${inside}.md`, `${inside}index.md`]) {
        const file = await fileAt(join(BUILT, candidate));
        if (file !== null) return send(request, response, file, { headers: markdown });
      }
    }
    if (inside.endsWith(".md")) {
      const file = await fileAt(join(BUILT, inside));
      if (file !== null)
        return send(request, response, file, {
          headers: { "content-type": markdown["content-type"], "cache-control": RULES.pagesKept },
        });
    }
    const headers: Record<string, string> = {};
    if (inside.startsWith("/assets/")) headers["cache-control"] = RULES.assetsKept;
    else if (/\.data$|^\/search-index\.json$/.test(inside))
      headers["cache-control"] = RULES.dataKept;
    else if (!/\.json$/.test(inside)) {
      headers["cache-control"] = RULES.pagesKept;
      headers.vary = "Accept";
    }
    for (const candidate of [
      inside.endsWith("/") ? `${inside}index.html` : inside,
      `${inside}.html`,
    ]) {
      const file = await fileAt(join(BUILT, candidate));
      if (file !== null) return send(request, response, file, { headers });
    }
    return send(request, response, join(BUILT, "404.html"), { status: 404 });
  };

  const server: Server = createServer((request, response) => {
    heard?.(`${request.method} ${request.url}`);
    answer(request, response).catch((failure: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" }).end(String(failure));
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

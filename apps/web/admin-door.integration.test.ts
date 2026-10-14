/**
 * The operator's dashboard at `/admin`, asked over HTTP of the scanner's own
 * build.
 *
 * `/admin` opens only for a session whose account carries the operator flag.
 * Everybody else, and everybody while the seller dashboard cannot confirm the
 * flag, gets the same 404 page as `/nimda`, a path no route has. The router
 * draws that answer from the page's refusal, so this runs the scanner's build
 * rather than importing the page. The `*_migration_test` database is emptied
 * and built by the migrations alone, with nothing installed beside them.
 *
 *   pnpm --filter @agentify/web build
 *   MIGRATION_TEST_DATABASE_URL=postgresql://…/agentify_scanner_migration_test \
 *     pnpm scanner:test:admin-door
 */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { createDatabase, migrateDatabase } from "@agentify/scanner-database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.MIGRATION_TEST_DATABASE_URL;
if (!connectionString?.includes("_migration_test")) {
  throw new Error("the admin door test requires a dedicated *_migration_test database");
}
const built = fileURLToPath(new URL("./server.js", import.meta.url));
if (!existsSync(fileURLToPath(new URL("./dist/server/index.js", import.meta.url)))) {
  throw new Error(
    "the admin door test runs the scanner's build: pnpm --filter @agentify/web build",
  );
}

const SESSION = "agentify.session_token";
const HEADING = "Agentify operating dashboard";
/** The cookie values the stand-in seller dashboard knows, and which of them are operators. */
const people = new Set(["operator", "person"]);
const operators = new Set(["operator"]);
let sellerDashboardFails = false;

const migrationsFolder = fileURLToPath(
  new URL("../../packages/scanner-database/migrations", import.meta.url),
);
const database = createDatabase(connectionString, { max: 1 });
let sellerDashboard: Server;
let scanner: ChildProcess;
let scannerOutput = "";
let base = "";

/** The seller dashboard's answer to the session question, from the two sets above. */
function standInSellerDashboard(): Server {
  return createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const asked = JSON.parse(body || "{}") as { operation?: string; cookie?: string };
      if (sellerDashboardFails || asked.operation !== "session") {
        response.statusCode = 503;
        response.end();
        return;
      }
      const value = (asked.cookie ?? "").split(`${SESSION}=`)[1]?.split(";")[0] ?? "";
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          people.has(value)
            ? {
                status: "signed_in",
                email: `${value}@example.com`,
                operator: operators.has(value),
                request: null,
                set_cookie: [],
              }
            : { status: "signed_out" },
        ),
      );
    });
  });
}

type Answer = Readonly<{ status: number; headers: readonly string[][]; body: string }>;
type Asking = Readonly<{ method?: "GET" | "HEAD" | "POST"; cookie?: string; data?: boolean }>;

/**
 * One request and its whole answer, header names as they came on the wire.
 * Only the date is left out, which is the one header two answers a moment
 * apart cannot share.
 */
function ask(path: string, { method = "GET", cookie, data = false }: Asking = {}): Promise<Answer> {
  // A client navigation asks for the page's data at `<page>.data`.
  const target = new URL(data ? `${path}.data` : path, base);
  return new Promise((resolve, reject) => {
    const sent = httpRequest(
      target,
      {
        method,
        agent: false,
        headers: cookie === undefined ? {} : { cookie },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => {
          const headers: string[][] = [];
          for (let at = 0; at < response.rawHeaders.length; at += 2) {
            const name = response.rawHeaders[at] ?? "";
            if (name.toLowerCase() !== "date")
              headers.push([name, response.rawHeaders[at + 1] ?? ""]);
          }
          resolve({ status: response.statusCode ?? 0, headers, body });
        });
      },
    );
    sent.on("error", reject);
    sent.end();
  });
}

/** The text of the first element of this kind on a page, or null. */
const textOf = (tag: "title" | "h1", html: string): string | null =>
  html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.replace(/<[^>]+>/g, "") ??
  null;

const DOORS = ["/admin", "/admin/users"] as const;

/**
 * Every built script the answer names, and those the router's manifest names
 * for the same address when the browser asks it which modules draw there.
 */
async function scriptsHandedOver(answer: Answer, door: string, visitor: Asking) {
  const scriptsIn = (text: string) =>
    [...text.matchAll(/"(\/assets\/[^"]+\.js)"/g)].map((match) => match[1] ?? "");
  const version = answer.body.match(/"version":\s*"([^"]+)"/)?.[1] ?? "";
  const manifest = await ask(
    `/__manifest?paths=${encodeURIComponent(door)}&version=${encodeURIComponent(version)}`,
    visitor,
  );
  return new Set([...scriptsIn(answer.body), ...scriptsIn(manifest.body)]);
}

/**
 * Asserts that `/admin` and what is under it are the site's 404 page for this
 * visitor, asked as a page, as a HEAD, as a client navigation and as a post,
 * whose data must be refused the same way and carry none of the operator's
 * dashboard, nor any script the browser is handed with it.
 */
async function expectMissingPages(visitor: Asking, who: string): Promise<void> {
  for (const door of DOORS) {
    const label = `${who}: ${door}`;
    const missing = await ask(door.replace("/admin", "/nimda"), visitor);
    const heading = textOf("h1", missing.body);
    expect(missing.status, label).toBe(404);
    expect(heading, label).not.toBeNull();

    const answered = await ask(door, visitor);
    expect(answered.status, label).toBe(404);
    // The page a browser draws is the site's 404 page: the same title and
    // the same heading, whether the server drew it into the HTML or the
    // browser draws it from the payload beside it.
    expect(textOf("title", answered.body), label).toBe(textOf("title", missing.body));
    expect(answered.body, label).toContain(heading);
    const named = answered.headers.map(([name]) => (name ?? "").toLowerCase());
    expect(named, label).not.toContain("www-authenticate");
    expect(named, label).not.toContain("x-robots-tag");

    expect((await ask(door, { ...visitor, method: "HEAD" })).status, `${label} HEAD`).toBe(404);

    const navigated = await ask(door, { ...visitor, data: true });
    expect(navigated.status, `${label} navigation`).toBe(404);
    const posted = await ask(door, { ...visitor, method: "POST" });
    expect(posted.status, `${label} POST`).toBe(404);
    const postedData = await ask(door, { ...visitor, method: "POST", data: true });
    expect(postedData.status, `${label} POST navigation`).toBe(404);
    const scripts = await scriptsHandedOver(answered, door, visitor);
    expect(scripts.size, label).toBeGreaterThan(0);
    const handed = [answered, navigated, posted, postedData];
    for (const script of scripts) handed.push(await ask(script, visitor));
    for (const answer of handed) {
      expect(answer.body, label).not.toContain(HEADING);
      expect(answer.body, label).not.toContain("Operator dashboard");
    }
  }
}

beforeAll(async () => {
  await database.pool.query(
    "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public",
  );
  await migrateDatabase(database.db, migrationsFolder);

  sellerDashboard = standInSellerDashboard();
  await new Promise<void>((resolve) => sellerDashboard.listen(0, "127.0.0.1", resolve));
  const sellerDashboardPort = (sellerDashboard.address() as AddressInfo).port;

  const port = 42_000 + (process.pid % 1_000);
  base = `http://127.0.0.1:${port}`;
  scanner = spawn(process.execPath, [built], {
    detached: true,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      DATABASE_URL: connectionString,
      TOKEN_HMAC_SECRET: "t".repeat(32),
      DASHBOARD_IDENTITY_URL: `http://127.0.0.1:${sellerDashboardPort}`,
      REPORT_IDENTITY_SECRET: "r".repeat(32),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [scanner.stdout, scanner.stderr]) {
    stream?.on("data", (chunk) => {
      scannerOutput = `${scannerOutput}${chunk}`.slice(-20_000);
    });
  }
  const deadline = Date.now() + 45_000;
  for (;;) {
    const ready = await ask("/api/health/live").then(
      (answer) => answer.status === 200,
      () => false,
    );
    if (ready) break;
    if (scanner.exitCode !== null || Date.now() > deadline) {
      throw new Error(`the scanner's build did not start\n${scannerOutput}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
});

afterAll(async () => {
  if (scanner?.exitCode === null) {
    try {
      process.kill(-(scanner.pid ?? 0), "SIGTERM");
    } catch {
      scanner.kill("SIGTERM");
    }
    await Promise.race([
      once(scanner, "exit"),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  if (sellerDashboard?.listening)
    await new Promise<void>((resolve) => sellerDashboard.close(() => resolve()));
  await database.pool.end();
});

describe("the operator's dashboard at /admin", () => {
  it("is the 404 page for a browser with no session", async () => {
    await expectMissingPages({}, "no session");
  });

  it("is the 404 page for a signed-in person without the flag", async () => {
    await expectMissingPages({ cookie: `${SESSION}=person` }, "not an operator");
  });

  it("opens for an operator on a database the migrations built, and shuts on the next request once the flag is cleared", async () => {
    const operator = { cookie: `theme=dark; ${SESSION}=operator` };

    const opened = await ask("/admin", operator);
    expect(opened.status).toBe(200);
    expect(opened.body).toContain(HEADING);
    // Nothing in front of the scanner keeps the dashboard out of caches, so the
    // scanner's own answer must.
    const cacheControl = opened.headers
      .filter(([name]) => (name ?? "").toLowerCase() === "cache-control")
      .map(([, value]) => value ?? "")
      .join(", ");
    expect(cacheControl).toContain("private");
    expect(cacheControl).toContain("no-store");

    operators.delete("operator");
    try {
      await expectMissingPages(operator, "operator, flag cleared");
    } finally {
      operators.add("operator");
    }
  });

  it("has nothing under it, even for an operator", async () => {
    const answered = await ask("/admin/users", { cookie: `${SESSION}=operator` });

    expect(answered.status).toBe(404);
    expect(answered.body).not.toContain(HEADING);
  });

  it("fails closed: while the seller dashboard cannot say, an operator gets the 404 page too", async () => {
    const operator = { cookie: `${SESSION}=operator` };

    sellerDashboardFails = true;
    try {
      await expectMissingPages(operator, "seller dashboard answering 503");
    } finally {
      sellerDashboardFails = false;
    }

    // Last, because it does not come back: nothing is listening any more.
    await new Promise<void>((resolve) => sellerDashboard.close(() => resolve()));
    await expectMissingPages(operator, "seller dashboard unreachable");
  });
});

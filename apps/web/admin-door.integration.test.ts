/**
 * The door to the operator's dashboard, asked over HTTP of the scanner's own
 * build.
 *
 * ADR-0026 §6: `/admin` opens for a session whose account carries the operator
 * flag. Everybody else, signed in or not, and everybody while the cabinet
 * cannot confirm the flag, gets the site's 404 page, the one a path no route
 * answers gets. The answer is Next's, drawn from the page's refusal, so this
 * runs the standalone build rather than importing the page. It compares the
 * refusal with the answer at `/nimda`, a path of the same shape that no route
 * has: the same status, the same page title and heading, none of the
 * dashboard, and no header of a door with a password of its own.
 *
 * The dashboard reads four views that production's database carries and no
 * migration in this repository makes. The test stands them in for one quiet
 * day, in a `*_migration_test` database it is told about, and takes them away
 * afterwards.
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

import { createDatabase } from "@agentify/scanner-database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.MIGRATION_TEST_DATABASE_URL;
if (!connectionString?.includes("_migration_test")) {
  throw new Error("the admin door test requires a dedicated *_migration_test database");
}
const built = fileURLToPath(new URL("./.next/standalone/apps/web/server.js", import.meta.url));
if (!existsSync(built)) {
  throw new Error(
    "the admin door test runs the scanner's build: pnpm --filter @agentify/web build",
  );
}

const SESSION = "agentify.session_token";
const HEADING = "Agentify operating dashboard";
/** The cookie values the stand-in cabinet knows, and which of them are operators. */
const people = new Set(["operator", "person"]);
const operators = new Set(["operator"]);
let cabinetFails = false;

const database = createDatabase(connectionString, { max: 1 });
let madeSchema = false;
let cabinet: Server;
let scanner: ChildProcess;
let scannerOutput = "";
let base = "";

/**
 * The cabinet's side of the question the scanner asks about every visitor
 * (ADR-0026 §2), answering from the two sets above.
 */
function standInCabinet(): Server {
  return createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const asked = JSON.parse(body || "{}") as { operation?: string; cookie?: string };
      if (cabinetFails || asked.operation !== "session") {
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
type Asking = Readonly<{ method?: "GET" | "HEAD"; cookie?: string; rsc?: boolean }>;

/**
 * One request and its whole answer, header names as they came on the wire.
 * Only the date is left out, which is the one header two answers a moment
 * apart cannot share.
 */
function ask(path: string, { method = "GET", cookie, rsc = false }: Asking = {}): Promise<Answer> {
  const target = new URL(path, base);
  if (rsc) target.searchParams.set("_rsc", "door");
  return new Promise((resolve, reject) => {
    const sent = httpRequest(
      target,
      {
        method,
        agent: false,
        headers: {
          ...(cookie === undefined ? {} : { cookie }),
          ...(rsc ? { rsc: "1" } : {}),
        },
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
 * Asserts that `/admin` and what is under it are the site's 404 page for this
 * visitor, asked as a page, as a HEAD and as a client navigation.
 *
 * A client navigation is the one way of asking whose status says nothing: Next
 * carries a page's refusal inside the answer to it and the browser draws the
 * 404 page from that. What is held there is that the payload is the 404 page
 * and none of the dashboard.
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

    const navigated = await ask(door, { ...visitor, rsc: true });
    expect(navigated.body, `${label} navigation`).toContain(heading);
    for (const answer of [answered, navigated]) {
      expect(answer.body, label).not.toContain(HEADING);
      expect(answer.body, label).not.toContain("Operator dashboard");
    }
  }
}

beforeAll(async () => {
  madeSchema =
    (
      await database.pool.query(
        "select count(*)::int as found from pg_namespace where nspname = 'metabase'",
      )
    ).rows[0]?.found === 0;
  await database.pool.query("create schema if not exists metabase");
  for (const view of ["overview", "daily_funnel", "recent_scans", "self_scan"]) {
    await database.pool.query(`drop view if exists metabase.operator_${view}`);
  }
  await database.pool.query(
    `create view metabase.operator_overview as
       select 7 as visitors_total, 3 as visitors_30d, 5 as landing_views_30d, 2 as scans_total,
              1 as scans_30d, 1 as completed_scans_30d, 1 as unique_sites_30d,
              0 as verified_registrations_30d, 0 as shares_30d, 1 as accepted_requests_24h,
              0 as challenge_passes_24h, 0 as browser_usage_usd_today`,
  );
  await database.pool.query(
    `create view metabase.operator_daily_funnel as
       select current_date as day, 3 as visitors, 5 as landing_views, 1 as scans,
              1 as completed_scans, 0 as verified_registrations, 0 as shares`,
  );
  await database.pool.query(
    "create view metabase.operator_recent_scans as select now() as accepted_at where false",
  );
  await database.pool.query(
    "create view metabase.operator_self_scan as select 1 as scan_id where false",
  );

  cabinet = standInCabinet();
  await new Promise<void>((resolve) => cabinet.listen(0, "127.0.0.1", resolve));
  const cabinetPort = (cabinet.address() as AddressInfo).port;

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
      CABINET_IDENTITY_URL: `http://127.0.0.1:${cabinetPort}`,
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
  if (cabinet?.listening) await new Promise<void>((resolve) => cabinet.close(() => resolve()));
  for (const view of ["overview", "daily_funnel", "recent_scans", "self_scan"]) {
    await database.pool.query(`drop view if exists metabase.operator_${view}`);
  }
  if (madeSchema) await database.pool.query("drop schema if exists metabase");
  await database.pool.end();
});

describe("the operator's dashboard at /admin", () => {
  it("is the 404 page for a browser with no session", async () => {
    await expectMissingPages({}, "no session");
  });

  it("is the 404 page for a signed-in person without the flag", async () => {
    await expectMissingPages({ cookie: `${SESSION}=person` }, "not an operator");
  });

  it("opens for an operator, and shuts on the next request once the flag is cleared", async () => {
    const operator = { cookie: `theme=dark; ${SESSION}=operator` };

    const opened = await ask("/admin", operator);
    expect(opened.status).toBe(200);
    expect(opened.body).toContain(HEADING);
    // The one answer that carries the dashboard is kept by no cache: nothing
    // in front of the scanner says so any more, so the scanner has to.
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

  it("fails closed: while the cabinet cannot say, an operator gets the 404 page too", async () => {
    const operator = { cookie: `${SESSION}=operator` };

    cabinetFails = true;
    try {
      await expectMissingPages(operator, "cabinet answering 503");
    } finally {
      cabinetFails = false;
    }

    // Last, because it does not come back: nothing is listening any more.
    await new Promise<void>((resolve) => cabinet.close(() => resolve()));
    await expectMissingPages(operator, "cabinet unreachable");
  });
});

/**
 * The door of the operator's dashboard at `/admin`, asked of the whole process
 * over HTTP with a stand-in seller dashboard on loopback that knows one
 * operator and one person without the flag. The database listens nowhere, so
 * the dashboard's numbers are never read here; that an operator gets them,
 * from a database the migrations built, is held by
 * `admin-door.integration.test.ts`.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "../../testing/scanner";

const SESSION = "agentify.session_token";
const HEADING = "Agentify operating dashboard";
let sellerDashboard: Server;
let sellerDashboardAt = "";

beforeAll(async () => {
  sellerDashboard = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const asked = JSON.parse(body || "{}") as { cookie?: string };
      const value = (asked.cookie ?? "").split(`${SESSION}=`)[1]?.split(";")[0] ?? "";
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          value === "operator" || value === "person"
            ? {
                status: "signed_in",
                email: `${value}@example.com`,
                operator: value === "operator",
                request: null,
                set_cookie: [],
              }
            : { status: "signed_out" },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => sellerDashboard.listen(0, "127.0.0.1", resolve));
  sellerDashboardAt = `http://127.0.0.1:${(sellerDashboard.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => sellerDashboard.close(() => resolve()));
});

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "https://agentify.ad");
  vi.stubEnv("DATABASE_URL", "postgresql://nobody:unused@127.0.0.1:1/nowhere");
  vi.stubEnv("DASHBOARD_IDENTITY_URL", sellerDashboardAt);
  vi.stubEnv("REPORT_IDENTITY_SECRET", "r".repeat(32));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The text of the first element of this kind on a page, or null. */
const textOf = (tag: "title" | "h1", html: string): string | null =>
  html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.replace(/<[^>]+>/g, "") ??
  null;

/**
 * Asserts that `/admin` is the page for an address the site does not have, for
 * this visitor: as a page, as a HEAD and as a client navigation, none of them
 * carrying the dashboard.
 */
async function expectTheMissingPage(headers: Record<string, string>): Promise<void> {
  const missing = await (await ask("/nimda", { headers })).text();
  const answered = await ask("/admin", { headers });
  const html = await answered.text();

  expect(answered.status).toBe(404);
  expect(textOf("title", html)).toBe(textOf("title", missing));
  expect(textOf("h1", html)).toBe(textOf("h1", missing));
  expect((await ask("/admin", { method: "HEAD", headers })).status).toBe(404);
  const navigated = await ask("/admin.data", { headers });
  expect(navigated.status).toBe(404);
  for (const body of [html, await navigated.text()]) {
    expect(body).not.toContain(HEADING);
    expect(body).not.toContain("Operator dashboard");
  }
}

describe("the operator's dashboard at /admin", () => {
  it("is the page for an address the site does not have, to a browser with no session", async () => {
    await expectTheMissingPage({});
  });

  it("is the same to a signed-in person without the operator flag", async () => {
    await expectTheMissingPage({ cookie: `${SESSION}=person` });
  });

  it("is the same to an operator while the seller dashboard cannot say who is visiting", async () => {
    vi.stubEnv("DASHBOARD_IDENTITY_URL", "http://127.0.0.1:1");

    await expectTheMissingPage({ cookie: `${SESSION}=operator` });
  });

  it("goes on to read the numbers for an operator, and says it failed while it cannot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const answered = await ask("/admin", { headers: { cookie: `${SESSION}=operator` } });

    expect(answered.status).toBe(500);
    expect(await answered.text()).toContain("Something went wrong");
  });

  it("has nothing under it, even for an operator", async () => {
    const answered = await ask("/admin/users", { headers: { cookie: `${SESSION}=operator` } });

    expect(answered.status).toBe(404);
    expect(await answered.text()).not.toContain(HEADING);
  });
});

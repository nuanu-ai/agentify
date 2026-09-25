import { createServer, type Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isOperator } from "./operator";

const secret = "s".repeat(32);
const SESSION = "agentify.session_token";

type Asked = { operation?: string; cookie?: string; renew?: boolean };

/**
 * The cabinet's side of the question, as the scanner meets it: one session
 * whose account is an operator, one whose account is not, and nobody else.
 */
async function cabinet(
  answer: (asked: Asked) => { status: number; body?: unknown } = (asked) => {
    const value = (asked.cookie ?? "").split(`${SESSION}=`)[1]?.split(";")[0];
    if (value === "operator" || value === "person") {
      return {
        status: 200,
        body: {
          status: "signed_in",
          email: `${value}@example.com`,
          operator: value === "operator",
          request: null,
          set_cookie: [],
        },
      };
    }
    return { status: 200, body: { status: "signed_out" } };
  },
): Promise<{ url: string; asked: Asked[]; server: Server }> {
  const asked: Asked[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const question = JSON.parse(body || "{}") as Asked;
      asked.push(question);
      const said = answer(question);
      response.statusCode = said.status;
      if (said.body === undefined) {
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(said.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen_failed");
  return { url: `http://127.0.0.1:${address.port}`, asked, server };
}

const servers: Server[] = [];

function askingAt(url: string) {
  vi.stubEnv("CABINET_IDENTITY_URL", url);
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgres://nobody@127.0.0.1:1/unused");
  vi.stubEnv("REPORT_IDENTITY_SECRET", secret);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("whether the operator's dashboard opens for a request", () => {
  it("opens for a session whose account the cabinet says is an operator", async () => {
    const { url } = await cabinet();
    askingAt(url);

    await expect(isOperator(`theme=dark; ${SESSION}=operator`)).resolves.toBe(true);
  });

  it("stays shut for a session whose account is not an operator", async () => {
    const { url } = await cabinet();
    askingAt(url);

    await expect(isOperator(`${SESSION}=person`)).resolves.toBe(false);
    await expect(isOperator(`${SESSION}=somebody-signed-out`)).resolves.toBe(false);
  });

  it("stays shut for a browser with no session, without asking the cabinet", async () => {
    const { url, asked } = await cabinet();
    askingAt(url);

    for (const header of [null, undefined, "", "theme=dark"]) {
      await expect(isOperator(header), String(header)).resolves.toBe(false);
    }
    expect(asked).toHaveLength(0);
  });

  it("stays shut when the cabinet cannot say, whatever way it fails", async () => {
    // Not knowing whether somebody is an operator is not knowing they are one
    // (ADR-0026 §6): the dashboard fails closed.
    for (const failing of [
      () => ({ status: 503 }),
      () => ({ status: 200, body: { status: "maybe" } }),
      () => ({ status: 200, body: { status: "signed_in", email: "operator@example.com" } }),
    ]) {
      const { url } = await cabinet(failing);
      askingAt(url);
      await expect(isOperator(`${SESSION}=operator`)).resolves.toBe(false);
    }

    askingAt("http://127.0.0.1:1");
    await expect(isOperator(`${SESSION}=operator`)).resolves.toBe(false);

    vi.stubEnv("CABINET_IDENTITY_URL", "");
    vi.stubEnv("REPORT_IDENTITY_SECRET", "");
    await expect(isOperator(`${SESSION}=operator`)).resolves.toBe(false);
  });

  it("asks about the session's cookie alone, and moves nothing", async () => {
    // A page drawn on the server cannot hand the browser a renewed cookie, so
    // the question it asks must not move the session's end (ADR-0026 §2).
    const { url, asked } = await cabinet();
    askingAt(url);

    await isOperator(`theme=dark; ${SESSION}=operator; other=1`);

    expect(asked).toStrictEqual([
      { operation: "session", cookie: `${SESSION}=operator`, renew: false },
    ]);
  });
});

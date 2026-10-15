/**
 * A stalled Google exchange must leave email sign-in and existing sessions
 * usable. The production pool, PostgreSQL locks and upstream cancellation are
 * real; only Google's endpoint is replaced with a server on loopback.
 */
import { readdir, readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { sessionCookieName } from "@agentify/scanner-contracts/report-identity";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import type { GoogleFinishResult } from "./dashboard-entry.js";
import { connect } from "./database.js";
import { identityFor } from "./identity.js";
import { cookieHeader, googleExchange } from "./testing/google.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";

const wanted = new URL(testDatabaseUrl());
wanted.pathname = "/agentify_test_google_availability";
const databaseUrl = await readyDatabase(wanted.toString());
const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));

async function localGoogle() {
  const exchange = googleExchange();
  const nativeFetch = globalThis.fetch;
  const responses: ServerResponse[] = [];
  let stall: "headers" | "body" | null = null;
  let cancelled = false;
  const server = createServer((request, response) => {
    request.resume();
    responses.push(response);
    response.once("close", () => {
      if (!response.writableEnded) cancelled = true;
    });
    if (stall === "body") {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write('{"access_token":"');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback must listen");
  const endpoint = `http://127.0.0.1:${address.port}/token`;
  vi.stubGlobal("fetch", ((input, init) => {
    const target =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (target !== "https://oauth2.googleapis.com/token") {
      throw new Error(`Unexpected Google request: ${target}`);
    }
    return stall === null ? exchange.fetch(input, init) : nativeFetch(endpoint, init);
  }) satisfies typeof fetch);
  return {
    exchange,
    get requests() {
      return responses.length;
    },
    get cancelled() {
      return cancelled;
    },
    hold(where: "headers" | "body") {
      stall = where;
    },
    release() {
      const held = stall;
      stall = null;
      for (const response of responses) {
        if (response.destroyed || response.writableEnded) continue;
        if (held === "body") response.end('"}');
        else {
          response.writeHead(400, { "content-type": "application/json" });
          response.end('{"error":"invalid_grant"}');
        }
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted.toString()));
  describe("Google availability on PostgreSQL", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const pool = connect(databaseUrl);
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    AUTH_SECRET: TEST_AUTH_SECRET,
    PAYMENT_NETWORK: "eip155:84532",
    FACILITATOR_URL: "sandbox:scripted",
    GOOGLE_CLIENT_ID: "offline-client",
    GOOGLE_CLIENT_SECRET: "offline-secret",
  });
  const inFlight: Promise<unknown>[] = [];
  const track = <T>(operation: Promise<T>): Promise<T> => {
    inFlight.push(operation);
    return operation;
  };
  let provider: Awaited<ReturnType<typeof localGoogle>>;
  let identity: ReturnType<typeof identityFor>;

  beforeEach(async () => {
    await pool.query("drop schema public cascade");
    await pool.query("create schema public");
    for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
      for (const statement of (await readFile(`${migrations}/${file}`, "utf8"))
        .split("--> statement-breakpoint")
        .map((part) => part.trim())
        .filter(Boolean)) {
        await pool.query(statement);
      }
    }
    provider = await localGoogle();
    identity = identityFor(config, { pool, postman: async () => "accepted" });
  });

  afterEach(async () => {
    provider?.release();
    await Promise.allSettled(inFlight.splice(0));
    await provider?.close();
    vi.unstubAllGlobals();
  });
  afterAll(async () => await pool.end());

  const start = async () => {
    const started = await identity.startGoogle("settings");
    if (started.status !== "redirect") throw new Error("Google must start");
    return {
      query: provider.exchange.authorize(started.location),
      cookie: cookieHeader(started.setCookies),
    };
  };
  const finish = (flow: Awaited<ReturnType<typeof start>>) =>
    track(identity.finishGoogle(flow.query, flow.cookie));

  describe("Google availability on PostgreSQL", () => {
    it("refuses parallel callback replays while existing sessions and email sign-in stay usable", async () => {
      const signedIn = await finish(await start());
      if (signedIn.status !== "opened") throw new Error("the existing session must open");
      const cookie = cookieHeader(signedIn.setCookies);
      const flow = await start();
      provider.hold("headers");
      let ownerFinished = false;
      const owner = finish(flow).then((result) => {
        ownerFinished = true;
        return result;
      });
      await expect.poll(() => provider.requests).toBe(1);

      // With one connection waiting for Google, the unrelated session works.
      expect((await identity.whoIs(cookie))?.person.id).toBe(signedIn.person.id);
      const duplicates: GoogleFinishResult[] = [];
      for (let repeat = 0; repeat < 9; repeat++) {
        void track(finish(flow).then((result) => duplicates.push(result)));
      }
      await expect
        .poll(() => duplicates.length === 9 || (pool.totalCount === 10 && pool.idleCount === 0))
        .toBe(true);

      let sessionPerson: string | undefined;
      let emailStatus: string | undefined;
      void track(
        identity.whoIs(cookie).then((session) => {
          sessionPerson = session?.person.id;
        }),
      );
      void track(
        identity.requestLink("alternative@example.com", "default").then((result) => {
          emailStatus = result.status;
        }),
      );
      expect(
        await identity.finishGoogle(new URLSearchParams({ code: "without-state" }), undefined),
      ).toMatchObject({
        status: "refused",
        reason: "invalid",
        setCookies: [],
      });
      await expect
        .poll(() => ({ duplicates: duplicates.length, sessionPerson, emailStatus }), {
          timeout: 3000,
        })
        .toEqual({ duplicates: 9, sessionPerson: signedIn.person.id, emailStatus: "accepted" });
      expect(
        duplicates.every((result) => result.status === "refused" && result.setCookies.length === 0),
      ).toBe(true);
      expect(ownerFinished).toBe(false);
      expect(provider.requests).toBe(1);

      provider.release();
      expect(await owner).toMatchObject({ status: "refused", reason: "unavailable" });
      expect(await finish(flow)).toMatchObject({ status: "refused", reason: "invalid" });
      expect(await finish(await start())).toMatchObject({
        status: "opened",
        person: signedIn.person,
      });
    });

    it.each(["headers", "body"] as const)(
      "cancels a Google exchange stalled at %s, releases the connection, and permits a fresh sign-in",
      async (stall) => {
        const flow = await start();
        provider.hold(stall);
        let finished: GoogleFinishResult | undefined;
        void track(
          finish(flow).then((result) => {
            finished = result;
          }),
        );
        await expect.poll(() => provider.requests).toBe(1);

        await expect
          .poll(() => ({ status: finished?.status, upstreamClosed: provider.cancelled }), {
            timeout: 15_000,
          })
          .toEqual({ status: "refused", upstreamClosed: true });
        expect(finished).toMatchObject({ reason: "unavailable", email: null });
        expect(finished?.setCookies.map((line) => line.split("=", 1)[0])).not.toContain(
          sessionCookieName(config.cookieSecure),
        );
        await expect.poll(() => pool.totalCount - pool.idleCount).toBe(0);
        for (const table of ["dashboard_accounts", "dashboard_credentials", "dashboard_sessions"]) {
          expect((await pool.query(`select count(*)::int as count from ${table}`)).rows).toEqual([
            { count: 0 },
          ]);
        }

        provider.release();
        expect(await finish(flow)).toMatchObject({ status: "refused", reason: "invalid" });
        const recovered = await finish(await start());
        expect(recovered).toMatchObject({
          status: "opened",
          person: { email: "person@gmail.com" },
        });
        if (recovered.status !== "opened") throw new Error("a fresh sign-in must recover");
        expect((await identity.whoIs(cookieHeader(recovered.setCookies)))?.person).toEqual(
          recovered.person,
        );
      },
    );
  });
}

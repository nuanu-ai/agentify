/**
 * The headers the process writes on every answer are sent once, whatever route
 * drew the answer. React Router's Express adapter appends a route's own headers
 * to those the process already wrote, so a route that writes one of them sends
 * it twice. Every address in the route table is asked with each method it says
 * it takes and with one it does not; what a route answers only with a database
 * or a signed-in visitor behind it is not reached here.
 */

import { request } from "node:http";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import routes from "../app/routes";
import { SECURITY_HEADERS } from "../lib/server/answer-headers";
import { ORIGIN, stubOfflineScanner } from "../testing/api";
import { testScanner } from "../testing/scanner";

beforeEach(stubOfflineScanner);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** An address each route answers, its parameters filled with an id of the shape they take. */
const addressOf = (route: RouteConfigEntry): string =>
  route.index === true
    ? "/"
    : `/${(route.path ?? "")
        .replace(/:\w+/g, "0190f4c5-0000-7000-8000-000000000000")
        .replace("*", "no-such-page")}`;

/** Every header line of one answer, as the process wrote it, with no client joining repeats. */
const headerLines = async (path: string, method: string): Promise<string[]> => {
  const { origin } = await testScanner();
  const body = ["POST", "PUT", "PATCH"].includes(method) ? "{}" : undefined;
  return new Promise((resolve, reject) => {
    const asked = request(
      `${origin}${path}`,
      {
        method,
        agent: false,
        headers: {
          origin: ORIGIN,
          ...(body === undefined
            ? {}
            : { "content-type": "application/json", "content-length": String(body.length) }),
        },
      },
      (answered) => {
        answered.resume();
        resolve(
          answered.rawHeaders.filter((_, at) => at % 2 === 0).map((name) => name.toLowerCase()),
        );
      },
    );
    asked.on("error", reject);
    asked.end(body);
  });
};

/** The methods an address says it takes, from its answer to OPTIONS or to a method it refuses. */
async function allowOf(path: string): Promise<string[]> {
  const { origin } = await testScanner();
  const answered = await fetch(`${origin}${path}`, { method: "OPTIONS", redirect: "manual" });
  return (answered.headers.get("allow") ?? "GET")
    .split(", ")
    .filter((method) => method !== "OPTIONS");
}

it.each(routes.map(addressOf))(
  "sends each header the process writes on one line, whatever %s answers",
  async (path) => {
    for (const method of [...(await allowOf(path)), "OPTIONS", "PUT"]) {
      const lines = await headerLines(path, method);
      for (const name of Object.keys(SECURITY_HEADERS)) {
        expect(
          lines.filter((line) => line === name.toLowerCase()),
          `${method} ${path}: ${name}`,
        ).toHaveLength(1);
      }
    }
  },
);

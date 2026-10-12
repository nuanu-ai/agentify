/**
 * Keeps `pnpm test` on this machine: a `fetch` to anything but loopback is
 * refused, and the failure names the test that made it. Loopback stays allowed
 * because several suites stand up a real server in this process. Only `fetch`
 * is covered; a raw `node:net` socket, a `node:http` agent or a database
 * driver does not pass through here.
 *
 * A test that genuinely needs the outside world belongs beside `pnpm smoke`.
 */

import { afterEach } from "vitest";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

const isLocal = (target: string): boolean => {
  if (target.startsWith("/")) {
    // A relative address has no host to leave by.
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    // Not a URL, so not a request anywhere; the real fetch gives the clearer
    // error.
    return true;
  }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:") {
    return true;
  }
  return LOOPBACK.has(parsed.hostname);
};

const addressOf = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

const reachesOutside = globalThis.fetch;

/**
 * Refused requests are recorded as well as thrown: code under test may catch
 * everything (an unreachable probe becomes a "no answer" verdict and the test
 * goes green), so the record is checked after each test, where nothing under
 * test can catch it.
 */
const refused: string[] = [];

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const target = addressOf(input);
  if (!isLocal(target)) {
    refused.push(`${init?.method ?? "GET"} ${target}`);
    throw new Error(
      `pnpm test does not leave this machine, and something asked for ${target}. ` +
        "It is free, deterministic and works offline, and a request to anywhere " +
        "but this process is none of those. Stub the call, or move the test to " +
        "a smoke command where the network is expected.",
    );
  }
  return reachesOutside(input as never, init);
}) as typeof fetch;

afterEach(() => {
  if (refused.length === 0) {
    return;
  }
  const asked = refused.join(", ");
  refused.length = 0;
  throw new Error(
    `this test asked to leave the machine: ${asked}. ` +
      "The request was refused, so whatever the test saw instead is not what it " +
      "would see on somebody's laptop with a network. Stub the call, or move it " +
      "to a smoke command.",
  );
});

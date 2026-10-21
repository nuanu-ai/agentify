/**
 * Fails the test during which anything is written to the console that opens
 * an order or its goods to whoever reads it: an order identifier, an address
 * of a route an order identifier authorises (the status address), or a
 * WooCommerce download link, which carries the shop's download key. Logs are
 * read by more people than the database, so a line names an order by a
 * fingerprint instead.
 *
 * Every call to `console.log`, `info`, `warn`, `error`, `debug` and `trace` is
 * rendered the way the console renders it, an error with its stack, fields and
 * causes, and read before anything else sees it, so a test that silences or
 * collects the console with a spy is watched as well. The record is checked
 * after each test and after each file, where nothing under test can catch it.
 *
 * An identifier is any token of the shape the gateway gives one: `ord_` and
 * identifier characters, not preceded by a letter or digit. That takes in the
 * short ones fixtures make up (`ord_1`), since code that logs those logs the
 * real ones too; a freshly issued identifier is checked to fit. A status
 * address is recognised whatever identifier it carries. Left alone: an
 * identifier spelled some other way (encoded, split), a write straight to
 * `process.stdout` or `process.stderr`, a console imported from
 * `node:console`, and what a spawned process prints.
 */

import { format } from "node:util";
import { afterAll, afterEach } from "vitest";
import { randomIds } from "./apps/gateway/src/ports/clock.js";
import { API_ROUTES } from "./packages/contracts/src/api.js";

const ORDER_ID = /(?<![A-Za-z0-9])ord_[A-Za-z0-9][A-Za-z0-9_-]*/;

if (!ORDER_ID.test(randomIds("ord"))) {
  throw new Error(
    `an order identifier the gateway issues, such as ${randomIds("ord")}, no longer has the ` +
      "shape this guard looks for, so it would let every one of them through to the log",
  );
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A path parameter filled in with a value, not left as `:order_id` or `{order_id}`. */
const A_VALUE = String.raw`[^/?#\s:{][^/?#\s]*`;

const BEARER_ROUTES = Object.values(API_ROUTES)
  .filter((route) => route.auth === "order_id")
  .map((route) => new RegExp(escaped(route.path).replace(/:[a-z][a-z0-9_]*/g, A_VALUE)));

const DOWNLOAD_LINK = /[?&]download_file=\S*[?&]key=[^&\s]+/;

const opensAnOrder = (text: string): string | null => {
  if (ORDER_ID.test(text)) return "an order identifier";
  if (BEARER_ROUTES.some((route) => route.test(text))) return "a status address";
  if (DOWNLOAD_LINK.test(text)) return "a WooCommerce download link";
  return null;
};

const WATCHED = new Set(["log", "info", "warn", "error", "debug", "trace"]);

/** Unique lines: a spy that calls through is watched once more on the way. */
const leaked = new Set<string>();

const watch = (said: unknown[]): void => {
  let text: string;
  try {
    text = format(...said);
  } catch {
    return;
  }
  const what = opensAnOrder(text);
  if (what !== null) {
    leaked.add(`${what} in: ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`);
  }
};

const watching = new WeakSet<object>();
const watcherOf = new WeakMap<object, unknown>();

const watched = (method: (...said: unknown[]) => unknown): unknown => {
  if (watching.has(method)) return method;
  const known = watcherOf.get(method);
  if (known !== undefined) return known;
  const watcher = new Proxy(method, {
    apply(target, self, said: unknown[]) {
      watch(said);
      return Reflect.apply(target, self, said);
    },
  });
  watching.add(watcher);
  watcherOf.set(method, watcher);
  return watcher;
};

// The console object itself is wrapped rather than its methods replaced, so a
// spy put on a method, and a method assigned by hand, are still read through
// here; a wrapped method keeps the spy's own fields for the test's assertions.
globalThis.console = new Proxy(globalThis.console, {
  get(target, key) {
    const value: unknown = Reflect.get(target, key, target);
    return typeof key === "string" && WATCHED.has(key) && typeof value === "function"
      ? watched(value as (...said: unknown[]) => unknown)
      : value;
  },
});

const failIfLeaked = (when: string): void => {
  if (leaked.size === 0) return;
  const lines = [...leaked].join("\n  ");
  leaked.clear();
  throw new Error(
    `${when} something was written to the console that opens an order to whoever reads ` +
      `the log:\n  ${lines}\nName an order in a log line by its fingerprint, and write no ` +
      "address or link that carries a key.",
  );
};

afterEach(() => failIfLeaked("while this test ran,"));
afterAll(() => failIfLeaked("after the last test of this file,"));

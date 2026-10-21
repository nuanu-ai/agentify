/**
 * Fails the test during which anything is written to the console that opens
 * an order or its goods to whoever reads it: an order identifier, an address
 * of a route an order identifier authorises (the status address), a
 * WooCommerce order key (`wc_order_…`), or a WooCommerce download link. In
 * such a link `order` and `uid` are that one buyer's secrets; its `key` is the
 * file's download identifier, which every buyer of the product shares. Logs
 * are read by more people than the database, so a line names an order by a
 * fingerprint instead.
 *
 * Every console method that writes something is watched, each call rendered
 * the way the console renders it: `log`, `info`, `warn`, `error`, `debug`,
 * `trace`, `group` and `groupCollapsed` as formatted, `dir`, `dirxml` and
 * `table` inspected in full, `assert` when it fails, and the labels of
 * `count`, `countReset`, `time`, `timeEnd` and `timeLog` with what `timeLog`
 * adds. A call is read before anything else sees it, so a test that silences
 * or collects the console with a spy is watched as well. The record is checked
 * after each test and after each file, where nothing under test can catch it.
 *
 * An identifier is any token of the shape the gateway gives one: `ord_` and
 * identifier characters, not preceded by a letter or digit. That takes in the
 * short ones fixtures make up (`ord_1`), since code that logs those logs the
 * real ones too; a freshly issued identifier is checked to fit. An order key
 * is read the same way, and a status address whatever identifier it carries.
 * A download link is recognised with its query separators written plainly or
 * escaped for HTML (`&amp;`, `&#38;`, `&#x26;`).
 *
 * Left alone: an identifier spelled some other way (percent-encoded, split
 * across calls), a write after a file's last hook has run, a write straight to
 * `process.stdout` or `process.stderr`, a console imported from
 * `node:console`, what a spawned process prints, and the console methods that
 * write nothing to the log (`groupEnd`, `clear`, `profile`, `profileEnd`,
 * `timeStamp`).
 */

import { format, inspect } from "node:util";
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

const ORDER_KEY = /(?<![A-Za-z0-9])wc_order_[A-Za-z0-9]+/;

/** A query separator, as a URL writes it or as HTML escapes it. */
const SEPARATOR = "(?:[?&]|&amp;|&#0*38;|&#x0*26;)";
const DOWNLOAD_FILE = new RegExp(`${SEPARATOR}download_file=`, "i");
const BUYERS_SECRET = new RegExp(`${SEPARATOR}(?:order|uid)=[^&\\s]`, "i");

const opensAnOrder = (text: string): string | null => {
  if (ORDER_ID.test(text)) return "an order identifier";
  if (BEARER_ROUTES.some((route) => route.test(text))) return "a status address";
  if (ORDER_KEY.test(text)) return "a WooCommerce order key";
  if (DOWNLOAD_FILE.test(text) && BUYERS_SECRET.test(text)) return "a WooCommerce download link";
  return null;
};

const FORMATTED = new Set([
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
  "group",
  "groupCollapsed",
  "count",
  "countReset",
  "time",
  "timeEnd",
  "timeLog",
]);
const INSPECTED = new Set(["dir", "dirxml", "table"]);

/** What the console writes for one call, or null where it writes nothing. */
const rendered = (method: string, said: unknown[]): string | null => {
  if (method === "assert") return said[0] ? null : format(...said.slice(1));
  if (INSPECTED.has(method)) return said.map((value) => inspect(value, { depth: null })).join(" ");
  return format(...said);
};

const isWatched = (method: string): boolean =>
  method === "assert" || FORMATTED.has(method) || INSPECTED.has(method);

/** Unique lines: a spy that calls through is watched once more on the way. */
const leaked = new Set<string>();

const watch = (method: string, said: unknown[]): void => {
  let text: string | null;
  try {
    text = rendered(method, said);
  } catch {
    return;
  }
  if (text === null) return;
  const what = opensAnOrder(text);
  if (what !== null) {
    leaked.add(`${what} in: ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`);
  }
};

const watching = new WeakSet<object>();
const watcherOf = new WeakMap<object, unknown>();

const watched = (name: string, method: (...said: unknown[]) => unknown): unknown => {
  if (watching.has(method)) return method;
  const known = watcherOf.get(method);
  if (known !== undefined) return known;
  const watcher = new Proxy(method, {
    apply(target, self, said: unknown[]) {
      watch(name, said);
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
    return typeof key === "string" && isWatched(key) && typeof value === "function"
      ? watched(key, value as (...said: unknown[]) => unknown)
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
      "address, key or link that opens an order.",
  );
};

afterEach(() => failIfLeaked("while this test ran,"));
afterAll(() => failIfLeaked("after the last test of this file,"));

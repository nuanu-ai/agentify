/**
 * What a log line may say about a thrown value: the kind of failure and where
 * it was thrown, never what it carried.
 *
 * A failure's message and fields can hold whatever the failing code was handed
 * — a shop's key and secret, a buyer's address, a payment — and a message built
 * from a request can hold a newline that starts a log line of its own. So only
 * names are kept: the class, a name in the shape of an error's
 * (`TimeoutError`), and a code a system put on it (`ECONNREFUSED`, a Postgres
 * `23505`), for the failure and for what caused it; then the first frames of
 * its stack, which are code locations, on the same line. The one message kept
 * is a database failure's, which the store and the queue build from
 * identifiers alone.
 */

import { DatabaseFailure } from "./adapters/database-failure.js";

/** Deep enough for fetch's failure, the socket's beneath it, and one more. */
const CAUSES_NAMED = 4;

/** A class name as code writes one. */
const A_CLASS = /^[A-Za-z_$][\w$]{0,63}$/;

/** A name in the shape of an error's, which a library sets to say which kind. */
const AN_ERROR_NAME = /^[A-Z][A-Za-z]{0,63}(?:Error|Exception)$/;

/**
 * Capitals, digits and underscores, as systems write their codes; an address
 * or a shop's lower-case key does not fit.
 */
const A_CODE = /^[A-Z0-9_]{2,64}$/;

/** Enough to find where a failure was thrown and what called it. */
const FRAMES_KEPT = 8;

/** Where a frame points: a file or a module of Node's, at a line and column. */
const A_LOCATION = String.raw`(?:file:\/\/|node:|\/)[^()]*:\d+:\d+`;

/** One frame as V8 writes it: `    at name (location)` or `    at location`. */
const A_FRAME = new RegExp(
  String.raw`^ {4}at (?:.+ \((?:${A_LOCATION}|<anonymous>|index \d+)\)|${A_LOCATION})$`,
);

/** A control character, or a line or paragraph separator a log viewer may break at. */
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export function failureNamed(thrown: unknown): string {
  const named: string[] = [];
  try {
    let at: unknown = thrown;
    do {
      named.push(oneNamed(at));
      at = typeof at === "object" && at !== null ? (at as { cause?: unknown }).cause : undefined;
    } while (at !== undefined && named.length < CAUSES_NAMED);
  } catch {
    // A getter that throws must not turn a logged failure into a thrown one.
    named.push("a failure that could not be named");
  }
  const frames = framesOf(thrown);
  const kind = named.join(", caused by ");
  return frames.length === 0 ? kind : `${kind}; at ${frames.join(" | ")}`;
}

/**
 * The first frames of a failure's stack, each without its leading `at`.
 *
 * The stack begins with the failure's name and message, and the message may
 * hold lines shaped like frames. So frames are read only after a header that
 * is exactly the failure's own name and message, and only while each line is
 * a whole frame: a function named with a newline, which code can do by naming
 * it after data, splits its frame in two and ends the reading there. A stack
 * that does not begin with its own message, because the message was changed
 * after the stack was written, gives no frames at all; a message cut down to
 * its own first lines after that is the one change this cannot tell.
 */
function framesOf(thrown: unknown): readonly string[] {
  try {
    if (typeof thrown !== "object" || thrown === null) {
      return [];
    }
    const { stack, name, message } = thrown as {
      stack?: unknown;
      name?: unknown;
      message?: unknown;
    };
    if (typeof stack !== "string") {
      return [];
    }
    // The header as V8 writes it.
    const called = name === undefined ? "Error" : String(name);
    const said = message === undefined ? "" : String(message);
    const header = called === "" ? said : said === "" ? called : `${called}: ${said}`;
    const rest = stack.startsWith(header) ? stack.slice(header.length) : null;
    if (rest === null || (rest !== "" && !rest.startsWith("\n"))) {
      return [];
    }
    const frames: string[] = [];
    for (const line of rest.split("\n").slice(1)) {
      if (frames.length === FRAMES_KEPT || UNPRINTABLE.test(line) || !A_FRAME.test(line)) {
        break;
      }
      frames.push(line.slice("    at ".length));
    }
    return frames;
  } catch {
    return [];
  }
}

function oneNamed(thrown: unknown): string {
  if (thrown instanceof DatabaseFailure) {
    return thrown.message;
  }
  if (thrown === null) {
    return "a thrown null";
  }
  if (typeof thrown !== "object" && typeof thrown !== "function") {
    return `a thrown ${typeof thrown}`;
  }
  // The prototype's constructor, not a field of the value's own: a parsed
  // document can have a field called `constructor`.
  const classed: unknown = Object.getPrototypeOf(thrown)?.constructor?.name;
  const { name, code } = thrown as { name?: unknown; code?: unknown };
  const className = typeof classed === "string" && A_CLASS.test(classed) ? classed : null;
  return [
    className ?? "an unnamed failure",
    typeof name === "string" && AN_ERROR_NAME.test(name) && name !== className ? name : null,
    typeof code === "string" && A_CODE.test(code) ? code : null,
  ]
    .filter((word) => word !== null)
    .join(" ");
}

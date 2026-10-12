/**
 * What a log line may say about a thrown value: the kind of failure, never what
 * it carried.
 *
 * A failure's message, stack and fields can hold whatever the failing code was
 * handed — a shop's key and secret, a buyer's address, a payment — and a
 * message built from a request can hold a newline that starts a log line of
 * its own. So only names are kept: the class, a name in the shape of an
 * error's (`TimeoutError`), and a code a system put on it (`ECONNREFUSED`, a
 * Postgres `23505`), for the failure and for what caused it. The one message
 * kept is a database failure's, which the store and the queue build from
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
  return named.join(", caused by ");
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

/**
 * A database failure, as it may leave the store or the queue (ADR-0032).
 *
 * Every caller of the store and the queue logs what they throw, and the logs
 * outlive anything this gateway erases — a buyer's parameters now, and a
 * parcel's address once the gateway holds one. Both libraries underneath put
 * those values into their failures by default. Drizzle wraps every failed
 * statement in an error whose message is the statement followed by all of its
 * parameters, and keeps the parameters on the error as well: for an order, the
 * whole order document. Postgres quotes the failing row in the detail of a
 * refused write, and can quote a value in the message itself ("invalid input
 * syntax for type …"). Neither can be told not to.
 *
 * So a failure of the database leaves as a new error that says what failed
 * and the database's own identifiers for why — its error code and the names
 * of the constraint, table and column — and nothing else: not the driver's
 * sentence, not the statement, not its cause. A failure that is not the
 * database's is left exactly as it was, because the store also runs a caller's
 * own decision inside its transaction, and what that decision throws is the
 * caller's words.
 */

/** What a refusal may name: identifiers the database gives, never a value. */
interface Named {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly table?: unknown;
  readonly column?: unknown;
}

/**
 * Drizzle's wrapper round a failed statement, known by its shape: the statement
 * and its parameters, and the driver's failure as its cause. By shape rather
 * than by class, because this repository installs more than one copy of the
 * library and a wrapper from another copy is not an instance of this one's.
 */
function isStatementWrapper(thrown: unknown): thrown is { readonly cause?: unknown } {
  return (
    typeof thrown === "object" &&
    thrown !== null &&
    typeof (thrown as { query?: unknown }).query === "string" &&
    Array.isArray((thrown as { params?: unknown }).params)
  );
}

/**
 * A refusal raised by the database server: it has a severity and a code. Not
 * necessarily an `Error` — pg-boss spreads one into a plain object before it
 * reports a worker's failure, detail and all.
 */
function isServerRefusal(thrown: unknown): thrown is Named {
  return (
    typeof thrown === "object" &&
    thrown !== null &&
    typeof (thrown as { severity?: unknown }).severity === "string" &&
    typeof (thrown as { code?: unknown }).code === "string"
  );
}

/** A failure of the database that names what failed, and carries no value. */
export class DatabaseFailure extends Error {
  /** The database's own code for the failure, or the connection's, where it gave one. */
  readonly code: string | undefined;

  constructor(doing: string, named: Named) {
    const code = typeof named.code === "string" ? named.code : undefined;
    const said = [
      code === undefined ? null : `code ${code}`,
      typeof named.constraint === "string" ? `constraint ${named.constraint}` : null,
      typeof named.table === "string" ? `table ${named.table}` : null,
      typeof named.column === "string" ? `column ${named.column}` : null,
    ].filter((part) => part !== null);
    super(
      `${doing} failed in the database${said.length === 0 ? "" : ` (${said.join(", ")})`}; what was sent with it is left out, because it can carry a buyer's details`,
    );
    this.name = "DatabaseFailure";
    this.code = code;
  }
}

/**
 * The failure as it may leave: a database's failure without its values, and
 * any other exactly as it was thrown.
 */
export function withoutValues(thrown: unknown, doing: string): unknown {
  if (isStatementWrapper(thrown)) {
    // The cause is the driver's refusal or the connection's failure; only
    // their identifiers are read, and neither is kept.
    const cause: unknown = thrown.cause;
    return new DatabaseFailure(
      doing,
      typeof cause === "object" && cause !== null ? (cause as Named) : {},
    );
  }
  if (isServerRefusal(thrown)) {
    return new DatabaseFailure(doing, thrown);
  }
  return thrown;
}

/**
 * The object, with every failure of the database stripped of its values on its
 * way out of any method.
 *
 * A wrapper around the whole object rather than a line in each method, because
 * a method added later is covered without anybody remembering to. Each method
 * runs on the object itself, so its private fields are where it expects them.
 * Every method that reaches the database is asynchronous, so a failure arrives
 * as a rejection, and that is the only place one is looked for.
 */
export function failingWithoutValues<T extends object>(target: T, what: string): T {
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key, object);
      if (typeof value !== "function") {
        return value;
      }
      const doing = `${what}'s ${String(key)}`;
      return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, object, args);
        return result instanceof Promise
          ? result.catch((thrown: unknown) => {
              throw withoutValues(thrown, doing);
            })
          : result;
      };
    },
  });
}

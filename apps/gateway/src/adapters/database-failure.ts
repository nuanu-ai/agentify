/**
 * A database failure, as it may leave the store or the queue.
 *
 * Callers log what the store and the queue throw, and logs outlive anything the
 * gateway erases. Drizzle puts every statement parameter (a whole order, a
 * buyer's address) into its errors, and Postgres quotes values in its messages
 * and details; neither can be told not to. So a database failure leaves as a
 * new error carrying only what failed and the database's identifiers (code,
 * constraint, table, column). Any other failure, such as one thrown by a
 * caller's own decision inside a transaction, is left as it was.
 */

/** What a refusal may name: identifiers the database gives, never a value. */
interface Named {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly table?: unknown;
  readonly column?: unknown;
}

/**
 * Drizzle's wrapper round a failed statement, recognised by shape rather than
 * by class because the repository installs more than one copy of the library.
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
 * necessarily an `Error`; pg-boss spreads one into a plain object, detail and
 * all.
 */
function isServerRefusal(thrown: unknown): thrown is Named {
  return (
    typeof thrown === "object" &&
    thrown !== null &&
    typeof (thrown as { severity?: unknown }).severity === "string" &&
    typeof (thrown as { code?: unknown }).code === "string"
  );
}

/**
 * Server codes for a failure that can pass by itself: the connection
 * (class 08), resources such as too many connections (53), the server
 * shutting down or starting (57P), a lock not granted in time (55P03), and a
 * transaction undone for another's sake (40001, 40P01).
 */
const PASSING_CODE = /^(?:08|53|57P|55P03$|40001$|40P01$)/;

/**
 * What the driver or the pool says when the connection, not the statement,
 * failed: none could be had in time, it was dropped, or it was closed.
 */
const CONNECTION_FAILED =
  /trying to connect|connection terminated|not queryable|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN/i;

/** Whether a failure beneath a statement can pass by itself (`StoreFailureFacts`). */
function passingCause(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const { code, message, severity } = cause as {
    code?: unknown;
    message?: unknown;
    severity?: unknown;
  };
  if (typeof severity === "string" && typeof code === "string") return PASSING_CODE.test(code);
  return CONNECTION_FAILED.test(
    `${typeof code === "string" ? code : ""} ${typeof message === "string" ? message : ""}`,
  );
}

export class DatabaseFailure extends Error {
  readonly code: string | undefined;
  /** See `StoreFailureFacts` in `ports/store.ts`. */
  readonly passing: boolean;
  readonly nothingWritten: boolean;

  constructor(
    doing: string,
    named: Named,
    facts: { readonly passing: boolean; readonly nothingWritten?: boolean } = { passing: false },
  ) {
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
    this.passing = facts.passing;
    this.nothingWritten = facts.nothingWritten ?? false;
  }
}

/**
 * A database's failure without its values; any other failure exactly as it
 * was thrown.
 */
export function withoutValues(thrown: unknown, doing: string): unknown {
  if (isStatementWrapper(thrown)) {
    // Only the cause's identifiers are read; the cause itself is not kept.
    const cause: unknown = thrown.cause;
    return new DatabaseFailure(
      doing,
      typeof cause === "object" && cause !== null ? (cause as Named) : {},
      { passing: passingCause(cause) },
    );
  }
  if (isServerRefusal(thrown)) {
    return new DatabaseFailure(doing, thrown, { passing: passingCause(thrown) });
  }
  return thrown;
}

/**
 * The object, with every database failure stripped of its values on its way
 * out of any method, including methods added later. Only rejections are
 * rewritten, since every method that reaches the database is asynchronous.
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

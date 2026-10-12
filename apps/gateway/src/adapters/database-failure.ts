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

export class DatabaseFailure extends Error {
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
    );
  }
  if (isServerRefusal(thrown)) {
    return new DatabaseFailure(doing, thrown);
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

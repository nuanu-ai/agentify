/**
 * A log line about a failure is read by the operator who has to act on it, and
 * kept wherever logs go, which is further than anything this gateway erases.
 * So it may say what kind of failure it was and the code a system put on it,
 * and nothing the failure carried: not a shop's key, not a buyer's address,
 * not a newline a stranger put in a request to start a line of their own.
 */

import { DrizzleQueryError } from "drizzle-orm/errors";
import { DatabaseError } from "pg";
import { describe, expect, it } from "vitest";
import { withoutValues } from "./adapters/database-failure.js";
import { failureNamed } from "./failure-named.js";

const SECRET = "cs_a-secret-from-the-shop";
const BUYER = "buyer-7c1e05@example.com";
const FORGED = "\n[gateway] forged";

describe("a failure, as a log line names it", () => {
  it("is its class and the code a system put on it, without its message", () => {
    const failed = Object.assign(new Error(`${SECRET}${FORGED}`), { code: "ECONNREFUSED" });

    expect(failureNamed(failed)).toBe("Error ECONNREFUSED");
  });

  it("keeps a database's refusal code and none of the row it quoted", () => {
    const refused = new DatabaseError(
      "duplicate key value violates unique constraint",
      90,
      "error",
    );
    refused.code = "23505";
    refused.detail = `Key (email)=(${BUYER}) already exists.`;

    expect(failureNamed(refused)).toBe("DatabaseError 23505");
  });

  it("follows what caused it, so a failed request says what the network did", () => {
    // fetch says only "fetch failed"; the socket's code is one cause down.
    const refused = Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), {
      code: "ECONNREFUSED",
    });
    const failed = new TypeError("fetch failed", { cause: refused });

    expect(failureNamed(failed)).toBe("TypeError, caused by Error ECONNREFUSED");
  });

  it("keeps a name shaped like an error's, such as a timeout's", () => {
    const timedOut = new DOMException(`${SECRET} timed out`, "TimeoutError");

    expect(failureNamed(timedOut)).toBe("DOMException TimeoutError");
  });

  it("keeps the store's own sentence for a database failure, which names only identifiers", () => {
    const refused = new DatabaseError("violates check constraint", 90, "error");
    refused.severity = "ERROR";
    refused.code = "23514";
    refused.constraint = "orders_record_check";
    refused.detail = `Failing row contains (${BUYER}).`;
    const stripped = withoutValues(
      new DrizzleQueryError("insert …", [BUYER], refused),
      "the store's addOrder",
    );

    const named = failureNamed(stripped);

    expect(named).toContain("the store's addOrder failed in the database");
    expect(named).toContain("23514");
    expect(named).toContain("orders_record_check");
    expect(named).not.toContain(BUYER);
  });

  it("names a thrown value that is not an error by its type alone", () => {
    expect(failureNamed(`${SECRET}${FORGED}`)).toBe("a thrown string");
    expect(failureNamed(null)).toBe("a thrown null");
  });

  it("is still a line, and not a second failure, when the failure cannot be read", () => {
    // It runs inside a pool's error listener, where a throw takes the process down.
    const unreadable = Object.defineProperty(new Error(SECRET), "code", {
      get() {
        throw new Error(SECRET);
      },
    });

    expect(failureNamed(unreadable)).toBe("a failure that could not be named");
  });

  it("takes no name or code from a value's own fields unless they read as one", () => {
    // A parsed document can carry fields called anything, a constructor and a
    // code among them.
    const parsed: unknown = JSON.parse(
      JSON.stringify({ constructor: { name: SECRET }, name: BUYER, code: `E${FORGED}` }),
    );

    expect(failureNamed(parsed)).toBe("Object");
  });
});

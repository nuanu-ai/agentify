/**
 * A log line about a failure is read by the operator who has to act on it, and
 * kept wherever logs go, which is further than anything this gateway erases.
 * So it may say what kind of failure it was, the code a system put on it and
 * where in the code it was thrown, and nothing the failure carried: not a
 * shop's key, not a buyer's address, not a newline a stranger put in a request
 * to start a line of their own.
 */

import { DrizzleQueryError } from "drizzle-orm/errors";
import { DatabaseError } from "pg";
import { describe, expect, it } from "vitest";
import { withoutValues } from "./adapters/database-failure.js";
import { failureNamed } from "./failure-named.js";

const SECRET = "cs_a-secret-from-the-shop";
const BUYER = "buyer-7c1e05@example.com";
const FORGED = "\n[gateway] forged";

/** Where a frame of this file's names its location. */
const IN_THIS_FILE = /failure-named\.test\.ts:\d+:\d+\)/;

const caught = (work: () => unknown): unknown => {
  try {
    work();
  } catch (thrown) {
    return thrown;
  }
  throw new Error("nothing was thrown");
};

function throwsHere(): never {
  throw new TypeError(`${SECRET}${FORGED}`);
}

describe("a failure, as a log line names it", () => {
  it("is its class and the code a system put on it, without its message", () => {
    const failed = Object.assign(new Error(`${SECRET}${FORGED}`), { code: "ECONNREFUSED" });

    expect(failureNamed(failed)).toMatch(/^Error ECONNREFUSED; at /);
  });

  it("keeps a database's refusal code and none of the row it quoted", () => {
    const refused = new DatabaseError(
      "duplicate key value violates unique constraint",
      90,
      "error",
    );
    refused.code = "23505";
    refused.detail = `Key (email)=(${BUYER}) already exists.`;

    expect(failureNamed(refused)).toMatch(/^DatabaseError 23505; at /);
    expect(failureNamed(refused)).not.toContain(BUYER);
  });

  it("follows what caused it, so a failed request says what the network did", () => {
    // fetch says only "fetch failed"; the socket's code is one cause down.
    const refused = Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), {
      code: "ECONNREFUSED",
    });
    const failed = new TypeError("fetch failed", { cause: refused });

    expect(failureNamed(failed)).toMatch(/^TypeError, caused by Error ECONNREFUSED; at /);
  });

  it("keeps a name shaped like an error's, such as a timeout's", () => {
    const timedOut = new DOMException(`${SECRET} timed out`, "TimeoutError");

    expect(failureNamed(timedOut)).toMatch(/^DOMException TimeoutError(; at |$)/);
    expect(failureNamed(timedOut)).not.toContain(SECRET);
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

    expect(failureNamed(unreadable)).toMatch(/^a failure that could not be named(; at |$)/);
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

describe("where a failure was thrown, as a log line names it", () => {
  it("is the frames of its stack, without the line that carries its message", () => {
    const named = failureNamed(caught(throwsHere));

    expect(named).toMatch(/^TypeError; at throwsHere \(/);
    expect(named).toMatch(IN_THIS_FILE);
    expect(named).not.toContain(SECRET);
    expect(named).not.toContain("\n");
  });

  it("takes no line of the message for a frame, however much it looks like one", () => {
    const named = failureNamed(
      caught(() => {
        throw new Error(`${SECRET}\n    at /srv/${SECRET}/forged.ts:1:1`);
      }),
    );

    expect(named).toMatch(IN_THIS_FILE);
    expect(named).not.toContain(SECRET);
  });

  it("keeps no frame from a function whose name was given a newline or a control character", () => {
    // Code can name a function after data, by a computed key or by redefining
    // its name, and the name is written into the frame as it is: a newline
    // there can put a line shaped like a frame after it, and an escape can
    // rewrite what a terminal shows.
    for (const given of [
      `split\n    at /srv/${SECRET}/forged.ts:1:1\nrest`,
      `\u001b[2K${SECRET}`,
    ]) {
      const renamed = function renamed(): never {
        throw new Error("renamed");
      };
      Object.defineProperty(renamed, "name", { value: given });

      const named = failureNamed(caught(renamed));

      expect(named, JSON.stringify(given)).not.toContain(SECRET);
      expect(named, JSON.stringify(given)).not.toContain("\n");
    }
  });

  it("is the first eight frames, however deep the failure", () => {
    const deeper = (depth: number): never => (depth === 0 ? throwsHere() : deeper(depth - 1));

    const named = failureNamed(caught(() => deeper(20)));

    expect(named.match(/:\d+:\d+\)/g)).toHaveLength(8);
  });

  it("is left out where the stack does not begin with the failure's own message", () => {
    // A message changed after its stack was written no longer says where the
    // stack's own lines end, so none of them is trusted: whether it was
    // replaced, or cut in the middle of its first line.
    for (const changedTo of ["another message", "cut"]) {
      const changed = new Error(`cut${SECRET}\n    at /srv/${SECRET}/forged.ts:1:1`);
      void changed.stack;
      changed.message = changedTo;

      expect(failureNamed(changed), changedTo).toBe("Error");
    }
  });
});

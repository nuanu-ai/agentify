/**
 * A database failure, as it leaves the store or the queue (ADR-0032).
 *
 * Every caller of either logs what it throws, and the logs outlive anything
 * this gateway erases. So a failure that leaves them says what failed and the
 * database's own reason for it, and nothing that was bound to the statement:
 * not a buyer's parameters, not an order document, not a row the database
 * quoted back.
 */

import { inspect } from "node:util";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { DatabaseError } from "pg";
import { describe, expect, it } from "vitest";
import { withoutValues } from "./database-failure.js";

const BUYER = "buyer-7c1e05@example.com";

/** Everything a log line could print of a thrown value, its causes included. */
const printed = (thrown: unknown): string =>
  inspect(thrown, { depth: Number.POSITIVE_INFINITY, showHidden: true });

/** A refusal the way the Postgres driver raises one, with a row quoted in it. */
function refusedRow(): DatabaseError {
  const refused = new DatabaseError(
    'new row for relation "orders" violates check constraint "orders_record_check"',
    120,
    "error",
  );
  refused.severity = "ERROR";
  refused.code = "23514";
  refused.detail = `Failing row contains (ord_7c1e05, {"params":{"email":"${BUYER}"}}).`;
  refused.table = "orders";
  refused.constraint = "orders_record_check";
  return refused;
}

describe("a database failure leaving the store or the queue", () => {
  it("says nothing that was bound to the statement, however deep it was", () => {
    // Drizzle's own wrapper puts every parameter into its message and keeps
    // them on itself; the driver's error beneath it quotes the row.
    const thrown = new DrizzleQueryError(
      'insert into "orders" ("id", "record") values ($1, $2)',
      ["ord_7c1e05", JSON.stringify({ params: { email: BUYER } })],
      refusedRow(),
    );

    const told = withoutValues(thrown, "the store's addOrder");

    expect(printed(told)).not.toContain(BUYER);
    expect(printed(told)).not.toContain("Failing row");
  });

  it("still says what failed and the database's own reason, in its identifiers", () => {
    const told = withoutValues(
      new DrizzleQueryError("insert …", [BUYER], refusedRow()),
      "the store's addOrder",
    );

    expect(told).toBeInstanceOf(Error);
    const message = (told as Error).message;
    expect(message).toContain("the store's addOrder");
    expect(message).toContain("23514");
    expect(message).toContain("orders_record_check");
    expect(message).toContain("table orders");
  });

  it("keeps the database's code where a caller can branch on it", () => {
    // The commands that start against a database tell an operator to run the
    // migrations when a table is missing, and they read the code to know.
    const missing = new DatabaseError('relation "orders" does not exist', 90, "error");
    missing.severity = "ERROR";
    missing.code = "42P01";

    const told = withoutValues(
      new DrizzleQueryError("select …", [BUYER], missing),
      "the store's orderById",
    );

    expect((told as { code?: unknown }).code).toBe("42P01");
  });

  it("strips a failure pg-boss reports from a worker, which is not an Error at all", () => {
    // pg-boss spreads the driver's refusal into a plain object before emitting
    // it, detail and all, so a check for the class would let it through.
    const reported = { ...refusedRow(), message: "a worker failed", queue: "agentify_reminders" };

    expect(printed(withoutValues(reported, "the queue's own upkeep"))).not.toContain(BUYER);
  });

  it("strips drizzle's wrapper by its shape, whichever copy of drizzle raised it", () => {
    // Two copies of the library are installed in this repository; a wrapper
    // from the other one is not an instance of this one's class.
    const wrapper = Object.assign(new Error(`Failed query: insert …\nparams: ${BUYER}`), {
      query: "insert …",
      params: [BUYER],
      cause: refusedRow(),
    });

    expect(printed(withoutValues(wrapper, "the store's addOrder"))).not.toContain(BUYER);
  });

  it("leaves out the database's own sentence, which can quote a value too", () => {
    // Not every value Postgres repeats is in the detail: a value of the wrong
    // type is quoted in the message itself.
    const refused = new DatabaseError(
      `invalid input syntax for type uuid: "${BUYER}"`,
      90,
      "error",
    );
    refused.severity = "ERROR";
    refused.code = "22P02";

    const told = withoutValues(refused, "the store's orderById");

    expect(printed(told)).not.toContain(BUYER);
    expect((told as Error).message).toContain("22P02");
  });

  it("strips a refusal the driver raised on its own, as the queue meets one", () => {
    const told = withoutValues(refusedRow(), "the queue's publish");

    expect(printed(told)).not.toContain(BUYER);
    expect((told as Error).message).toContain("23514");
  });

  it("names a connection that failed under a statement, without the statement's values", () => {
    const lost = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });

    const told = withoutValues(
      new DrizzleQueryError("select …", [BUYER], lost),
      "the store's orderById",
    );

    expect(printed(told)).not.toContain(BUYER);
    expect((told as Error).message).toContain("ECONNREFUSED");
  });

  it("leaves a failure that is not the database's exactly as it was", () => {
    // The negative control: the store runs a caller's decision inside its
    // transaction, and what that decision throws is the caller's own words.
    const ours = new Error("the order ord_7c1e05 breaks what must be true about money");

    expect(withoutValues(ours, "the store's withOrder")).toBe(ours);
  });
});

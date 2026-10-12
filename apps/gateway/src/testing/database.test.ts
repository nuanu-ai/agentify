/**
 * Which database `pnpm test:db` is given. Offline on purpose: this is what
 * stops the suite emptying the database a developer's running stack shows, and
 * it has to hold whether or not a database is up.
 *
 * The variable names are spelled out rather than imported. They are what an
 * operator types, and a rename read back out of the source would pass while
 * every document still named the old variable.
 */

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEST_DATABASE_URL, TEST_DATABASE, testDatabaseUrl } from "./database.js";

/** The database the dashboard is showing. Never this suite's. */
const stack = "postgres://agentify:agentify@localhost:5432/agentify";

/** A server bound where a deployment binds it rather than where a laptop does. */
const moved = `postgres://agentify:agentify@localhost:55432/${TEST_DATABASE}`;

const started = process.env.AGENTIFY_TEST_DATABASE_URL;

afterEach(() => {
  if (started === undefined) {
    delete process.env.AGENTIFY_TEST_DATABASE_URL;
  } else {
    process.env.AGENTIFY_TEST_DATABASE_URL = started;
  }
});

describe("the database the suite is given", () => {
  it("is its own when nobody says otherwise", () => {
    expect(testDatabaseUrl({})).toBe(DEFAULT_TEST_DATABASE_URL);
    expect(DEFAULT_TEST_DATABASE_URL).toContain(TEST_DATABASE);
  });

  it("is the server AGENTIFY_TEST_DATABASE_URL names", () => {
    // The default finds the database where `compose.yaml` publishes it on a
    // laptop; a host that publishes it elsewhere has no other way to say so.
    expect(testDatabaseUrl({ AGENTIFY_TEST_DATABASE_URL: moved })).toBe(moved);
  });

  it("takes that over a DATABASE_URL meant for something else", () => {
    // On such a host DATABASE_URL names the stack's own database for
    // `db:migrate`. The more specific variable wins, so the suite runs where it
    // was sent instead of refusing over a variable that was never about it.
    expect(testDatabaseUrl({ AGENTIFY_TEST_DATABASE_URL: moved, DATABASE_URL: stack })).toBe(moved);
  });

  it("is whatever DATABASE_URL names, when it names something else", () => {
    const elsewhere = "postgres://someone:secret@example.test:5432/somewhere_else";

    expect(testDatabaseUrl({ DATABASE_URL: elsewhere })).toBe(elsewhere);
  });

  it("is never the database the stack runs on, whichever variable names it", () => {
    // Otherwise a developer with the stack up empties the database the
    // dashboard is showing, without a word.
    for (const variable of ["AGENTIFY_TEST_DATABASE_URL", "DATABASE_URL"]) {
      for (const url of [
        "postgres://agentify:agentify@localhost:5432/agentify",
        "postgres://agentify:agentify@127.0.0.1:55432/agentify",
        "postgres://agentify:agentify@postgres:5432/agentify?sslmode=disable",
      ]) {
        expect(() => testDatabaseUrl({ [variable]: url }), `${variable}=${url}`).toThrow(
          /will not be pointed there/,
        );
      }
    }
  });

  it("says which variable said it, and what to do instead", () => {
    // With two variables in play, naming the wrong one sends the reader to the
    // wrong line.
    expect(() => testDatabaseUrl({ AGENTIFY_TEST_DATABASE_URL: stack })).toThrow(
      /^AGENTIFY_TEST_DATABASE_URL names "agentify"/,
    );
    expect(() => testDatabaseUrl({ DATABASE_URL: stack })).toThrow(
      /^DATABASE_URL names "agentify"/,
    );
    expect(() => testDatabaseUrl({ DATABASE_URL: stack })).toThrow(new RegExp(TEST_DATABASE));
    expect(() => testDatabaseUrl({ DATABASE_URL: stack })).toThrow(/name any other database/);
  });

  it("refuses an address that names no database at all", () => {
    // Postgres connects such an address to the database named after the user,
    // which on this stack is `agentify`, so it would walk past the refusal
    // above and empty the dashboard's database.
    for (const url of [
      "postgres://agentify:agentify@localhost:55432",
      "postgres://agentify:agentify@localhost:55432/",
    ]) {
      expect(() => testDatabaseUrl({ AGENTIFY_TEST_DATABASE_URL: url }), url).toThrow(
        /names no database/,
      );
      expect(() => testDatabaseUrl({ DATABASE_URL: url }), url).toThrow(/names no database/);
    }
  });

  it("refuses an empty AGENTIFY_TEST_DATABASE_URL rather than quietly using 5432", () => {
    // An emptied variable is an accident, not a request for the default:
    // whoever sets this one is on a host where localhost:5432 is the wrong
    // server.
    expect(() => testDatabaseUrl({ AGENTIFY_TEST_DATABASE_URL: "" })).toThrow(
      /^AGENTIFY_TEST_DATABASE_URL is set to nothing/,
    );
  });

  it("treats an empty DATABASE_URL as nobody having said anything", () => {
    // DATABASE_URL is not this suite's variable, and through a shell an empty
    // one arrives the same way as an unset one.
    expect(testDatabaseUrl({ DATABASE_URL: "" })).toBe(DEFAULT_TEST_DATABASE_URL);
  });

  it("says which variable it could not read, without repeating what was in it", () => {
    // A connection string carries a password, and what the suite throws ends
    // up in CI output.
    const thrown = (): string => {
      try {
        testDatabaseUrl({
          AGENTIFY_TEST_DATABASE_URL: "postgres//agentify:s3cret@localhost/x",
        });
        return "";
      } catch (error) {
        return String(error);
      }
    };

    expect(thrown()).toContain("AGENTIFY_TEST_DATABASE_URL");
    expect(thrown()).not.toContain("s3cret");
  });

  it("reads the environment this process was started with when given none", () => {
    // `pnpm test:db` calls this with no argument.
    process.env.AGENTIFY_TEST_DATABASE_URL = moved;

    expect(testDatabaseUrl()).toBe(moved);
  });
});

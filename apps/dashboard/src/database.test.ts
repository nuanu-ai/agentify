/**
 * A pool reports a connection that failed while nobody was waiting on it, and
 * the driver's failure can carry the values bound to the statement that was
 * running: session identifiers, one-time-link claims, a shop's key and secret.
 */

import { EventEmitter } from "node:events";
import { loggedWhile } from "@agentify/gateway/testing";
import { describe, expect, it } from "vitest";
import { connect } from "./database.js";

const SECRET = "cs_a-secret-from-the-shop";

describe("a database connection that fails", () => {
  it("is logged as failed, with nothing the driver's failure carried", async () => {
    const pool = connect("postgres://nobody@127.0.0.1:1/nowhere");
    const held = new EventEmitter();

    const written = await loggedWhile(async () => {
      pool.emit("error", new Error(`${SECRET}\n[dashboard] forged`), held);
      pool.emit("acquire", held);
      held.emit("error", new Error(`${SECRET}\n[dashboard] forged`));
    });
    await pool.end();

    expect(written.match(/a database connection failed/g)).toHaveLength(2);
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain("forged");
  });
});

/**
 * A command that only reads, such as the operator's payout, opens the
 * gateway's application without starting the queue: pg-boss, once started,
 * runs its own maintenance and schedules, and those write to the database the
 * command promises to leave alone. The store connects at its first query, so
 * an application that starts nothing reaches no database while it opens, and
 * these cases open one against a port nothing listens on.
 */

import { describe, expect, it } from "vitest";
import { openCommandApplication, openReadingApplication } from "./command-application.js";
import { loadConfig } from "./config.js";

/** A loopback port nothing listens on, so a connection there is refused at once. */
const NOTHING_ANSWERS = loadConfig({ DATABASE_URL: "postgres://agentify@127.0.0.1:1/agentify" });

describe("the application a command opens", () => {
  it("reaches no database while it opens where the command only reads, so no queue housekeeping starts", async () => {
    const opened = await openReadingApplication(NOTHING_ANSWERS);

    await opened.close();
  });

  it("reaches the database at once where the command writes, since its queue starts", async () => {
    // The negative control for the case above: opening against this address
    // fails as soon as anything starts against it.
    await expect(openCommandApplication(NOTHING_ANSWERS)).rejects.toThrow();
  });
});

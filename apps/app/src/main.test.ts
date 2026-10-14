/**
 * The application run whole as the process production starts. Its payout
 * split table must be the code's own: a table handed in here, such as the one
 * tests run a live gateway on, would make every split on Base pay its
 * commission to a wallet nobody chose, and a split cannot be changed once it
 * exists. While the code names no commission wallet on Base, that shows as
 * the application refusing Base for want of one.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Base, with the database and the facilitator on a loopback port nothing
 * listens on, so that however the application is wired it reaches nothing
 * outside this machine. The facilitator is refused for that as well, which
 * leaves the commission wallet to be named beside it.
 */
const BASE = {
  DATABASE_URL: "postgres://agentify@127.0.0.1:9/agentify",
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "http://127.0.0.1:9",
};

/** Runs the entry point with nothing in its environment but these settings. */
const started = (
  environment: Record<string, string>,
): Promise<{ readonly code: number | null; readonly printed: string }> =>
  new Promise((resolve, reject) => {
    let printed = "";
    const running = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    running.stdout.on("data", (chunk) => {
      printed += String(chunk);
    });
    running.stderr.on("data", (chunk) => {
      printed += String(chunk);
    });
    running.once("error", reject);
    running.once("close", (code) => resolve({ code, printed }));
  });

describe("the application started on Base", () => {
  it("refuses for want of Base's commission wallet, so it runs on the code's own payout split table", async () => {
    const run = await started(BASE);

    expect(run.printed).toMatch(/eip155:8453.*commission wallet/s);
    expect(run.code).toBe(1);
  });
});

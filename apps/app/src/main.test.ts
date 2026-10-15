/**
 * The application run whole as the process production starts. Its payout
 * split table must be the code's own: a table handed in here would make every
 * split on Base pay its commission to a wallet nobody chose, and a split
 * cannot be changed once it exists. The table shows without a server: the
 * configured placeholder is held to the rule a merchant's wallet is, so the
 * application refuses to stand in for a merchant with a wallet that its table
 * names as a commission wallet, and with no other.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Base, with the database and the facilitator on a loopback port nothing
 * listens on, so that however the application is wired it reaches nothing
 * outside this machine. The facilitator is refused for that as well, which
 * stops the application before anything starts and leaves the placeholder's
 * verdict to be read beside it.
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
  it("names the product owner's Safe as Agentify's commission wallet, so it runs on the code's own payout split table", async () => {
    const run = await started({
      ...BASE,
      PAY_TO_ADDRESS: "0xf44Ac5860c13fDa0577305121f00cBa4d0B96541",
    });

    expect(run.printed).toMatch(
      /PAY_TO_ADDRESS is 0xf44Ac5860c13fDa0577305121f00cBa4d0B96541, which is a network's commission wallet/,
    );
    expect(run.code).toBe(1);
  });

  it("takes the experiment's distributor for no commission wallet, which a table made for tests would", async () => {
    const run = await started({
      ...BASE,
      PAY_TO_ADDRESS: "0xF029d915c69C1902bB09A86c801c8226825F265c",
    });

    expect(run.printed).toMatch(/FACILITATOR_URL/);
    expect(run.printed).not.toMatch(/PAY_TO_ADDRESS/);
    expect(run.code).toBe(1);
  });
});

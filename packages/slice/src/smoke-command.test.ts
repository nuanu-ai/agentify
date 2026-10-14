/**
 * The smoke command run whole, as a person types it. It builds its own
 * gateway, and that gateway's payout split table must be the code's own: a
 * table handed in here, such as the one tests run a live gateway on, would let
 * a smoke pointed at Base ask a buyer to pay a split whose commission goes to
 * a wallet nobody chose. While the code names no commission wallet on Base,
 * that shows as the command refusing Base for want of one.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";

/** Runs the command with nothing in its environment but these settings. */
const smoke = (
  environment: Record<string, string>,
): Promise<{ readonly code: number | null; readonly printed: string }> =>
  new Promise((resolve, reject) => {
    let printed = "";
    const running = spawn(process.execPath, ["--import", "tsx", "src/smoke.ts"], {
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

describe("the smoke command pointed at Base", () => {
  it("refuses for want of Base's commission wallet, so its gateway runs on the code's own payout split table", async () => {
    // A dry run, with a key that holds nothing and the facilitator on a
    // loopback port nothing listens on, so however the command is wired it
    // signs nothing and reaches nothing outside this machine. The facilitator
    // is refused for that as well, which leaves the commission wallet to be
    // named beside it.
    const run = await smoke({
      AGENTIFY_SMOKE: "1",
      SMOKE_BUYER_KEY: generatePrivateKey(),
      SMOKE_PAY_TO: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      SMOKE_NETWORK: "eip155:8453",
      SMOKE_ALLOW_MAINNET: "1",
      SMOKE_FACILITATOR_URL: "http://127.0.0.1:9",
    });

    expect(run.printed).toMatch(/eip155:8453.*commission wallet/s);
    expect(run.code).toBe(1);
  });
});

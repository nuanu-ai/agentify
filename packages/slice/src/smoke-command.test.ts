/**
 * The smoke command run whole, as a person types it. It builds its own
 * gateway, and that gateway's payout split table must be the code's own: a
 * table handed in here would let a smoke pointed at Base ask a buyer to pay a
 * split whose commission goes to a wallet nobody chose. The table shows before
 * anything is signed: the merchant's address the smoke is given is held to the
 * rule a merchant's wallet is, so the command refuses one that its table names
 * as a commission wallet, and no other.
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

/**
 * A dry run on Base, with a key that holds nothing and the facilitator on a
 * loopback port nothing listens on, so however the command is wired it signs
 * nothing and reaches nothing outside this machine. The facilitator is refused
 * for that as well, which stops the command before it boots anything and
 * leaves the merchant address's verdict to be read beside it.
 */
const onBase = (payTo: string) =>
  smoke({
    AGENTIFY_SMOKE: "1",
    SMOKE_BUYER_KEY: generatePrivateKey(),
    SMOKE_PAY_TO: payTo,
    SMOKE_NETWORK: "eip155:8453",
    SMOKE_ALLOW_MAINNET: "1",
    SMOKE_FACILITATOR_URL: "http://127.0.0.1:9",
  });

describe("the smoke command pointed at Base", () => {
  it("names the product owner's Safe as Agentify's commission wallet, so its gateway runs on the code's own payout split table", async () => {
    const run = await onBase("0xf44Ac5860c13fDa0577305121f00cBa4d0B96541");

    expect(run.printed).toMatch(
      /PAY_TO_ADDRESS is 0xf44Ac5860c13fDa0577305121f00cBa4d0B96541, which is a network's commission wallet/,
    );
    expect(run.code).toBe(1);
  });

  it("takes the experiment's distributor for no commission wallet, which a table made for tests would", async () => {
    const run = await onBase("0xF029d915c69C1902bB09A86c801c8226825F265c");

    expect(run.printed).toMatch(/FACILITATOR_URL/);
    expect(run.printed).not.toMatch(/PAY_TO_ADDRESS/);
    expect(run.code).toBe(1);
  });
});

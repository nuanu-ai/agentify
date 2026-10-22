/**
 * The payment fault control between the real gateway, booted in this process
 * with the x402 adapter a deployment runs, and the real SDK merchant and x402
 * buyer of the slice. The tester's promise is that each armed fault reaches the
 * gateway as the outcome its name says, on the call it names and only once, and
 * that the model never claims a transfer on a chain or prints a signature.
 */

import { request as httpRequest } from "node:http";
import { AgentOrderStatusSchema } from "@nuanu-ai/agentify-contracts";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { type Buyer, makeBuyer } from "./buyer.js";
import { RENTED_NUMBER } from "./cards.js";
import { bootGateway, sliceEnv } from "./gateway-harness.js";
import { startMerchant } from "./merchant.js";
import { runPaymentFaults } from "./payment-faults-command.js";
import { realFacilitator } from "./smoke.js";

/** A key made for this run alone: the model facilitator checks no balance, so it needs to hold nothing. */
const TEST_BUYER_KEY = generatePrivateKey();

const running: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of running.splice(0).reverse()) {
    await stop();
  }
});

const startFaults = async (argv: readonly string[]) => {
  const log: string[] = [];
  const started = await runPaymentFaults([...argv, "--port", "0"], (line) => log.push(line));
  if (!started.ok) throw new Error(started.why);
  running.push(() => started.server.close());
  return { port: started.server.port, log };
};

/** A gateway whose facilitator is the fault control, a merchant selling on it, and a buyer. */
const stage = async (argv: readonly string[], env: Record<string, string> = {}) => {
  const faults = await startFaults(argv);
  const booted = await bootGateway(
    realFacilitator,
    sliceEnv({ FACILITATOR_URL: `http://127.0.0.1:${faults.port}`, ...env }),
  );
  running.push(() => booted.stop());
  const merchant = startMerchant(booted.baseUrl, booted.merchantKey);
  await merchant.start();
  running.push(() => merchant.stop());
  await merchant.publishCatalog();
  const buyer = makeBuyer({ baseUrl: booted.baseUrl, privateKey: TEST_BUYER_KEY, maxUsd: 50 });
  return { log: faults.log, buyer };
};

const buyRentedNumber = async (buyer: Buyer) => {
  const card = (await buyer.catalog()).find((each) => each.title === RENTED_NUMBER.title);
  if (card === undefined) throw new Error("the rented number is not in the catalog");
  return buyer.buy(card, { area_code: "415" });
};

const settleLines = (log: readonly string[]) =>
  log.filter((line) => /^\S+ #\d+ settle /.test(line));

describe("the payment fault control, as the gateway's own x402 adapter reads it", () => {
  it("settles every purchase as a local model, naming no chain transaction, when no fault is armed", async () => {
    const { log, buyer } = await stage([]);

    const order = AgentOrderStatusSchema.parse((await buyRentedNumber(buyer)).body);

    expect(order.status).toBe("delivered");
    expect(order.payment_status).toBe("paid");
    expect(order.transaction).toMatch(/^local-model-[0-9a-f]{6}-1$/);
    const [settled] = settleLines(log);
    expect(settled).toMatch(/LOCAL MODEL transfer local-model-[0-9a-f]{6}-1/);
  }, 20_000);

  it("refuses only the nth verification, before the goods are made or any charge is asked", async () => {
    const { log, buyer } = await stage(["--fault", "verify-refused", "--nth", "2"]);

    const first = await buyRentedNumber(buyer);
    const second = await buyRentedNumber(buyer);
    const third = await buyRentedNumber(buyer);

    expect(AgentOrderStatusSchema.parse(first.body).status).toBe("delivered");
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: { code: "payment_not_verified" } });
    expect(AgentOrderStatusSchema.parse(third.body).status).toBe("delivered");
    expect(settleLines(log)).toHaveLength(2);
  }, 20_000);

  it("fails the settle definitely: the gateway holds the goods and the order reads not paid", async () => {
    const { log, buyer } = await stage(["--fault", "settle-failed"]);

    const order = AgentOrderStatusSchema.parse((await buyRentedNumber(buyer)).body);

    expect(order.status).toBe("delivered_unpaid");
    expect(order.payment_status).toBe("not_paid");
    expect(order.delivered).toBeNull();
    expect(log.join("\n")).not.toMatch(/LOCAL MODEL transfer/);
  }, 20_000);

  it("loses the settle's answer after counting the transfer: the gateway reads the payment as unresolved", async () => {
    const { log, buyer } = await stage(["--fault", "settle-lost"], { SETTLE_RESPONSE_MS: "1000" });

    const order = AgentOrderStatusSchema.parse((await buyRentedNumber(buyer)).body);

    expect(order.status).toBe("payment_unresolved");
    expect(order.payment_status).toBe("unresolved");
    expect(order.transaction).toBeUndefined();
    expect(settleLines(log).join("\n")).toMatch(
      /LOCAL MODEL transfer local-model-[0-9a-f]{6}-1 counted as done/,
    );
  }, 20_000);

  it("answers a held settle after the gateway's deadline, and the unresolved order turns paid with its goods", async () => {
    const { buyer } = await stage(["--fault", "settle-late", "--after", "2.5"], {
      SETTLE_RESPONSE_MS: "1000",
    });

    const bought = await buyRentedNumber(buyer);
    const before = AgentOrderStatusSchema.parse(bought.body);
    expect(before.payment_status).toBe("unresolved");
    if (bought.statusUrl === null) throw new Error("the purchase named no status address");

    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const after = AgentOrderStatusSchema.parse((await buyer.status(bought.statusUrl)).body);

    expect(after.status).toBe("delivered");
    expect(after.payment_status).toBe("paid");
    expect(after.transaction).toMatch(/^local-model-[0-9a-f]{6}-1$/);
  }, 20_000);
});

/** One call made by hand, as a facilitator client would make it. */
const post = (
  port: number,
  path: string,
  body: unknown,
  { leaveAfterMs }: { leaveAfterMs?: number } = {},
): Promise<{ status: number | null; body: string }> =>
  new Promise((resolve) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path,
      headers: { "content-type": "application/json" },
    });
    request.on("error", () => resolve({ status: null, body: "" }));
    request.on("response", (response) => {
      let text = "";
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? null, body: text }));
    });
    request.end(JSON.stringify(body));
    if (leaveAfterMs !== undefined) {
      setTimeout(() => request.destroy(), leaveAfterMs);
    }
  });

const SIGNATURE = `0x${"5a".repeat(65)}`;

const payment = (network: string, nonce = `0x${"11".repeat(32)}`) => ({
  x402Version: 2,
  paymentPayload: {
    x402Version: 2,
    payload: {
      signature: SIGNATURE,
      authorization: { from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", nonce },
    },
  },
  paymentRequirements: {
    network,
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amount: "3500000",
    payTo: "0x9B653320BFA220e6d394f7cD324EF20c65f91e32",
    extra: { payment_ref: "pay_1" },
  },
});

const waitUntil = async (holds: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("the payment fault control's own record", () => {
  it("gives no verdict for a chain other than Base Sepolia", async () => {
    const { port, log } = await startFaults([]);

    const verified = await post(port, "/verify", payment("eip155:8453"));
    const settled = await post(port, "/settle", payment("eip155:8453"));

    expect(verified.status).toBe(400);
    expect(settled.status).toBe(400);
    expect(verified.body).not.toMatch(/isValid/);
    expect(settled.body).not.toMatch(/success/);
    expect(log.join("\n")).not.toMatch(/LOCAL MODEL transfer/);
  });

  it("counts one transfer per authorization however often it is settled, and never prints the signature", async () => {
    const { port, log } = await startFaults([]);

    const first = await post(port, "/settle", payment("eip155:84532"));
    const again = await post(port, "/settle", payment("eip155:84532"));
    const other = await post(port, "/settle", payment("eip155:84532", `0x${"22".repeat(32)}`));

    const transaction = JSON.parse(first.body).transaction;
    expect(transaction).toMatch(/^local-model-[0-9a-f]{6}-1$/);
    expect(JSON.parse(again.body).transaction).toBe(transaction);
    expect(JSON.parse(other.body).transaction).toBe(transaction.replace(/1$/, "2"));
    expect(settleLines(log)[1]).toMatch(`already counted as ${transaction}`);
    expect(log.join("\n")).not.toContain(SIGNATURE.slice(2, 40));
  });

  it("says a held success reached nobody when its caller stopped waiting first", async () => {
    const { port, log } = await startFaults(["--fault", "settle-late", "--after", "0.5"]);

    const settled = await post(port, "/settle", payment("eip155:84532"), { leaveAfterMs: 100 });
    await waitUntil(() => log.some((line) => /reached nobody/.test(line)));

    expect(settled.status).toBeNull();
    expect(log.find((line) => /reached nobody/.test(line))).toMatch(/LOCAL MODEL/);
  });

  it.each([
    [["--fault", "settle-slow"], /--fault takes/],
    [["--fault", "verify-refused", "--after", "5"], /--after delays a settle/],
    [["--nth", "2"], /no --fault is given/],
    [["--fault", "settle-late", "--after", "601"], /--after takes/],
    [["--fault", "settle-lost", "--fault", "settle-late"], /given twice/],
  ])("refuses the rule %j with one sentence and does not listen", async (argv, why) => {
    const said: string[] = [];
    const started = await runPaymentFaults(argv, (line) => said.push(line));

    expect(started.ok).toBe(false);
    expect(started.ok ? "" : started.why).toMatch(why);
    expect(said).toStrictEqual([]);
  });
});

/** Audit experiment, preregistered: signed request transport failure must remain unknown;
 * unsigned transport failure must remain client_refused. No source edits, no external I/O.
 * Every fetch is intercepted; public devnet key is read from existing test fixture.
 */
import { readFileSync } from "node:fs";
import {
  overTheNetwork,
  whatBecameOfThePayment,
} from "../../../packages/slice/src/bootstrap-command.ts";

const fixture = readFileSync(
  new URL("../../../packages/slice/src/bootstrap-command.test.ts", import.meta.url),
  "utf8",
);
const buyerKey = fixture.match(/const A_KEY = "([^"]+)"/)?.[1];
if (!buyerKey) throw new Error("Missing public fixture key");
const challenge = {
  x402Version: 2,
  resource: {
    url: "https://agentify.example/x402/itm_1/purchase",
    description: "Existing audit fixture",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "10000",
      payTo: "0x784D1234567890123456789012345678901234Ac",
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    },
  ],
};
const settings = {
  baseUrl: "https://agentify.example",
  buyerKey,
  maxUsd: "0.05",
  totalUsd: "0.50",
  waitMs: 0,
  allowMainnet: false,
  confirm: false,
  named: [],
  answers: {},
};
const original = globalThis.fetch;
const results = [];
try {
  for (const mode of ["unsigned_loss", "signed_loss"]) {
    const requests = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url !== "https://agentify.example/x402/itm_1/purchase")
        throw new Error("Unexpected request blocked");
      const signed = request.headers.has("payment-signature") || request.headers.has("x-payment");
      requests.push({ signed });
      if (mode === "unsigned_loss" || signed) throw new TypeError("controlled transport loss");
      return new Response("{}", {
        status: 402,
        headers: {
          "content-type": "application/json",
          "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64"),
        },
      });
    };
    const outcome = await overTheNetwork(settings).purchase("itm_1", {});
    results.push({
      mode,
      requests,
      expected: mode === "signed_loss" ? "unreachable" : "client_refused",
      actual: outcome.kind,
      payment: whatBecameOfThePayment(outcome, "eip155:84532"),
    });
  }
} finally {
  globalThis.fetch = original;
}
if (!results[1]?.requests.some((x) => x.signed))
  throw new Error("Signed leg not reached; experiment inconclusive");
console.log(
  JSON.stringify(
    {
      source: "77a9b578312e696826f378405c099f4996bcd703",
      external_requests: 0,
      mutated_sources: 0,
      results,
    },
    null,
    2,
  ),
);

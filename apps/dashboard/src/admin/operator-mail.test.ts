import type { SurfaceMode } from "@agentify/core";
import { CHANNEL_NAMES } from "@agentify/ui/workspace-view";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { TEST_AUTH_SECRET } from "../testing/secrets.js";
import { channelWrittenOf } from "./frame.js";
import { operatorFlagMessage } from "./operator-mail.js";

/** Each environment as its deployment configures it, at the host it is reached at. */
const ENVIRONMENTS: readonly (readonly [SurfaceMode, Record<string, string>])[] = [
  [
    "live",
    {
      PAYMENT_NETWORK: "eip155:8453",
      FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
      PUBLIC_BASE_URL: "https://agentify.ad",
    },
  ],
  [
    "test",
    {
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "https://x402.org/facilitator",
      PUBLIC_BASE_URL: "https://test.agentify.ad",
    },
  ],
  [
    "sandbox",
    {
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "sandbox:scripted",
      PUBLIC_BASE_URL: "http://localhost:3000",
    },
  ],
];

describe("the mail about a change of the operator flag", () => {
  it.each(ENVIRONMENTS)(
    "names the environment it grants access in, %s, with its host, in the subject and the text",
    (mode, environment) => {
      // A letter has no band over it, and an operator of one environment is
      // nobody in another: the mail says which, and where it is.
      const config = loadConfig({
        DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
        AUTH_SECRET: TEST_AUTH_SECRET,
        ...environment,
      });
      const host = new URL(config.publicBaseUrl).host;
      const others = ENVIRONMENTS.filter(([other]) => other !== mode).map(
        ([other]) => CHANNEL_NAMES[other],
      );

      for (const granted of [true, false]) {
        const sent = operatorFlagMessage("operator@example.com", {
          email: "colleague@example.com",
          granted,
          at: new Date("2026-10-26T12:03:12.000Z"),
          askedBy: "operator@example.com",
          channel: channelWrittenOf(config),
          accounts: `${config.publicBaseUrl}/dashboard/admin/accounts`,
        });
        for (const [part, words] of [
          ["subject", sent.subject],
          ["text", sent.body],
        ] as const) {
          const said = words.toLowerCase();
          expect(said, part).toContain(CHANNEL_NAMES[mode].toLowerCase());
          expect(said, part).toContain(host);
          for (const other of others) expect(said, part).not.toContain(other.toLowerCase());
        }
      }
    },
  );
});

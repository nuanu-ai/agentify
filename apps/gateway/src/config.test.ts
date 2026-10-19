import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isSandboxFacilitator,
  loadConfig,
  SANDBOX_FACILITATOR,
  secondAttemptProblem,
} from "./config.js";
import { nobodyAnnounces } from "./ports/announcer.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "./split/networks.js";
import { startGateway } from "./start.js";

const database = "postgres://agentify:secret@localhost:5432/agentify";

/** The one variable that has no sensible default and must always be given. */
const required = { DATABASE_URL: database };

/**
 * What the gateway said when it refused to start on this environment. Refusals
 * are checked for the numbers and names owed to the operator, not against the
 * whole sentence, so rewording a message fails no test.
 */
const refusalFor = (overrides: Record<string, string>): string => {
  try {
    loadConfig({ ...required, ...overrides });
  } catch (thrown) {
    return thrown instanceof Error ? thrown.message : String(thrown);
  }
  throw new Error("the configuration was accepted, so there is no refusal to read");
};

describe("loadConfig", () => {
  it("reads the environment and fills in the sandbox defaults", () => {
    const config = loadConfig(required);

    expect(config.databaseUrl).toBe(database);
    // A key made from a default would be a key nobody meant to issue.
    expect(config.sandboxMerchantKey).toBeNull();
  });

  it("carries every deadline the order machine asks for, and none of them is invented in code", () => {
    // The order machine takes its policy from here, so a number missing from
    // this object would be guessed further down in code.
    const { deadlines, redelivery } = loadConfig(required);

    expect(deadlines).toStrictEqual({
      quoteResponseMs: 5_000,
      quoteTtlMs: 30_000,
      settleResponseMs: 10_000,
      settleBeforeGoodsMs: 15_000,
      syncResponseMs: 10_000,
      syncBudgetMs: 20_000,
      paymentAfterConfirmationMs: 300_000,
      defaultConfirmationResponseMs: 3_600_000,
      defaultAsyncFulfillmentMs: 86_400_000,
      handlerAnswerMs: 3_000,
    });
    const config = loadConfig(required);
    expect(config.reminderAttempts).toBe(3);
    expect(config.reminderRetryDelayMs).toBe(5_000);
    expect(config.settleInFlightRetryMs).toBe(1_000);
    expect(config.claimRetentionMs).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(config.paymentWordsKept).toBe(20);

    expect(redelivery).toStrictEqual({
      baseDelayMs: 500,
      factor: 2,
      maxDelayMs: 30_000,
      maxAttempts: 5,
    });
  });

  it("takes every deadline from the environment when it is given one", () => {
    const config = loadConfig({
      ...required,
      QUOTE_RESPONSE_MS: "1000",
      QUOTE_TTL_MS: "2000",
      SETTLE_RESPONSE_MS: "3000",
      SETTLE_BEFORE_GOODS_MS: "3500",
      SYNC_RESPONSE_MS: "4000",
      SYNC_BUDGET_MS: "9000",
      PAYMENT_AFTER_CONFIRMATION_MS: "5000",
      DEFAULT_CONFIRMATION_RESPONSE_MS: "6000",
      DEFAULT_ASYNC_FULFILLMENT_MS: "7000",
      HANDLER_ANSWER_MS: "1500",
      REDELIVERY_BASE_DELAY_MS: "10",
      REDELIVERY_FACTOR: "3",
      REDELIVERY_MAX_DELAY_MS: "100",
      REDELIVERY_MAX_ATTEMPTS: "9",
    });

    expect(config.deadlines.quoteResponseMs).toBe(1000);
    expect(config.deadlines.quoteTtlMs).toBe(2000);
    expect(config.deadlines.settleResponseMs).toBe(3000);
    expect(config.deadlines.settleBeforeGoodsMs).toBe(3500);
    expect(config.deadlines.syncResponseMs).toBe(4000);
    expect(config.deadlines.syncBudgetMs).toBe(9000);
    expect(config.deadlines.paymentAfterConfirmationMs).toBe(5000);
    expect(config.deadlines.defaultConfirmationResponseMs).toBe(6000);
    expect(config.deadlines.defaultAsyncFulfillmentMs).toBe(7000);
    expect(config.deadlines.handlerAnswerMs).toBe(1500);
    expect(config.redelivery).toStrictEqual({
      baseDelayMs: 10,
      factor: 3,
      maxDelayMs: 100,
      maxAttempts: 9,
    });
  });

  it("carries the worker window and the payment settings", () => {
    const config = loadConfig(required);

    expect(config.worker).toStrictEqual({ pollWaitMs: 25_000 });
    expect(config.publicBaseUrl).toBe("http://localhost:3000");
    expect(config.payment).toStrictEqual({
      facilitatorUrl: "https://x402.org/facilitator",
      network: "eip155:84532",
      timeoutSeconds: 300,
      payTo: null,
      cdpApiKeyId: null,
      cdpApiKeySecret: null,
    });

    const live = loadConfig({
      ...required,
      FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
      PAYMENT_NETWORK: "eip155:8453",
      PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000001",
      CDP_API_KEY_ID: "key-id",
      CDP_API_KEY_SECRET: "key-secret",
    });

    expect(live.payment).toStrictEqual({
      facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
      network: "eip155:8453",
      timeoutSeconds: 300,
      payTo: "0x0000000000000000000000000000000000000001",
      cdpApiKeyId: "key-id",
      cdpApiKeySecret: "key-secret",
    });
  });

  it("accepts a dedicated payment RPC without changing the payment network", () => {
    const rpcUrl = "https://rpc.example.com/base/key-for-tests";
    const config = loadConfig({ ...required, PAYMENT_RPC_URL: rpcUrl });
    expect(config.payment.rpcUrl).toBe(rpcUrl);
    expect(config.payment.network).toBe("eip155:84532");
    expect(loadConfig({ ...required, PAYMENT_RPC_URL: "" }).payment.rpcUrl).toBeUndefined();
  });

  it.each([
    "not-a-url",
    "file:///tmp/key-for-tests",
    "https://user:key-for-tests@rpc.example.com",
    "https://rpc.example.com/#key-for-tests",
  ])("refuses unusable payment RPC configuration without echoing its credential: %s", (rpcUrl) => {
    const refused = refusalFor({ ...required, PAYMENT_RPC_URL: rpcUrl });
    expect(refused).toContain("PAYMENT_RPC_URL");
    expect(refused).not.toContain("key-for-tests");
  });

  it("takes one address that means the sandbox, and tells it from a real one", () => {
    // One field holds one value, so a deployment cannot name a real
    // facilitator and the sandbox at once; there is no separate flag to be
    // left set by mistake.
    expect(isSandboxFacilitator(loadConfig(required).payment.facilitatorUrl)).toBe(false);

    const sandbox = loadConfig({ ...required, FACILITATOR_URL: SANDBOX_FACILITATOR });
    expect(sandbox.payment.facilitatorUrl).toBe(SANDBOX_FACILITATOR);
    expect(isSandboxFacilitator(sandbox.payment.facilitatorUrl)).toBe(true);

    // A near miss is a refusal at startup rather than a real address that
    // quietly does not exist.
    expect(() => loadConfig({ ...required, FACILITATOR_URL: "sandbox:scripted-ish" })).toThrowError(
      /FACILITATOR_URL/,
    );
  });

  it("refuses the sandbox beside a real facilitator's credentials", () => {
    // Catches a production environment file copied onto a sandbox: these
    // credentials only talk to a real facilitator, so beside the sandbox they
    // are leftovers rather than a choice.
    const sandbox = { ...required, FACILITATOR_URL: SANDBOX_FACILITATOR };

    expect(() => loadConfig({ ...sandbox, CDP_API_KEY_ID: "key-id" })).toThrowError(/CDP_API_KEY/);
    expect(() => loadConfig({ ...sandbox, CDP_API_KEY_SECRET: "secret" })).toThrowError(
      /CDP_API_KEY/,
    );

    // An address to be paid at is not the same signal and is not refused: the
    // challenge cannot be built without one, so a sandbox that rejected it
    // could not sell anything at all. Nothing ever arrives there.
    expect(() =>
      loadConfig({ ...sandbox, PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000001" }),
    ).not.toThrow();
  });

  describe("a credential set to nothing", () => {
    it("reads the same as a credential nobody set", () => {
      // A compose file hands a service a fixed list of names, so "not this one"
      // is written as the name with nothing after it. Read as a credential of
      // length zero it would refuse the value and stop every laptop.
      const started = loadConfig({ ...required, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "" });

      expect(started.payment.cdpApiKeyId).toBeNull();
      expect(started.payment.cdpApiKeySecret).toBeNull();
    });

    it("still refuses a real credential beside a facilitator that settles nothing", () => {
      expect(() =>
        loadConfig({ ...required, FACILITATOR_URL: SANDBOX_FACILITATOR, CDP_API_KEY_ID: "key-id" }),
      ).toThrowError(/left over from somewhere else/);
    });

    it("still refuses Coinbase's facilitator with a credential set to nothing", () => {
      expect(() =>
        loadConfig({
          ...required,
          PAYMENT_NETWORK: "eip155:8453",
          FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
          CDP_API_KEY_ID: "key-id",
          CDP_API_KEY_SECRET: "",
        }),
      ).toThrowError(/CDP_API_KEY_SECRET/);
    });
  });

  it("refuses the CDP facilitator without the credentials it takes no request without", () => {
    // The CDP facilitator answers nothing unsigned, so without credentials a
    // deployment would find out at the first purchase, in front of a buyer.
    const cdp = { ...required, FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402" };

    const neither = refusalFor(cdp);
    expect(neither).toContain("CDP_API_KEY_ID");
    expect(neither).toContain("CDP_API_KEY_SECRET");

    // Only the missing half is named, so an operator is not sent looking for
    // the half they already have.
    const noSecret = refusalFor({ ...cdp, CDP_API_KEY_ID: "key-id" });
    expect(noSecret).toContain("CDP_API_KEY_SECRET");
    expect(noSecret).not.toContain("CDP_API_KEY_ID");

    const noId = refusalFor({ ...cdp, CDP_API_KEY_SECRET: "secret" });
    expect(noId).toContain("CDP_API_KEY_ID");
    expect(noId).not.toContain("CDP_API_KEY_SECRET");

    expect(() =>
      loadConfig({ ...cdp, CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: "secret" }),
    ).not.toThrow();
  });

  it("asks no credentials of the facilitators that take none", () => {
    // The default is the x402.org testnet facilitator, which is unauthenticated,
    // and the sandbox settles against nothing at all. Demanding credentials of
    // either would make the local stack need an account before it could sell.
    expect(() => loadConfig(required)).not.toThrow();
    expect(() =>
      loadConfig({ ...required, FACILITATOR_URL: "https://x402.org/facilitator" }),
    ).not.toThrow();
    expect(() => loadConfig({ ...required, FACILITATOR_URL: SANDBOX_FACILITATOR })).not.toThrow();
  });

  it("knows the CDP facilitator by its host, not by one exact spelling", () => {
    // Matching one exact string would let every other spelling of the same
    // facilitator start unauthenticated and fail at the first purchase.
    for (const url of [
      "https://api.cdp.coinbase.com/platform/v2/x402",
      "https://api.cdp.coinbase.com/platform/v2/x402/",
      "https://api.staging.cdp.coinbase.com/platform/v2/x402",
    ]) {
      expect(refusalFor({ ...required, FACILITATOR_URL: url })).toContain("CDP_API_KEY_ID");
    }

    // A look-alike somebody else registered is asked for nothing and handed
    // no credentials.
    expect(() =>
      loadConfig({
        ...required,
        FACILITATOR_URL: "https://api.cdp.coinbase.com.evil.example/x402",
      }),
    ).not.toThrow();
  });

  it("reads a host written down to the root as the host it is, and passes it on in one spelling", () => {
    // `api.cdp.coinbase.com.` is the fully qualified spelling of the same host.
    // Read as another host it would be sent no credentials, and every verify
    // and settle would be refused on a gateway that came up healthy.
    const rooted = "https://api.cdp.coinbase.com./platform/v2/x402";

    expect(refusalFor({ ...required, FACILITATOR_URL: rooted })).toContain("CDP_API_KEY_ID");
    expect(() =>
      loadConfig({
        ...required,
        FACILITATOR_URL: rooted,
        CDP_API_KEY_ID: "key-id",
        CDP_API_KEY_SECRET: "secret",
      }),
    ).not.toThrow();

    // Downstream, the signed token names the host and must match the request's
    // `Host` header, so only the canonical spelling is passed on.
    expect(
      loadConfig({
        ...required,
        FACILITATOR_URL: rooted,
        CDP_API_KEY_ID: "key-id",
        CDP_API_KEY_SECRET: "secret",
      }).payment.facilitatorUrl,
    ).toBe("https://api.cdp.coinbase.com/platform/v2/x402");
  });

  it("will not start unauthenticated against a Coinbase host it does not know", () => {
    // Fails closed: the gateway authenticates against exactly one Coinbase
    // host, and any other would get a client with no credentials that fails at
    // the first charge.
    for (const url of [
      "https://coinbase.com/x402",
      "https://api.coinbase.com/platform/v2/x402",
      "https://x402.coinbase.com./verify",
    ]) {
      const refused = refusalFor({
        ...required,
        FACILITATOR_URL: url,
        CDP_API_KEY_ID: "key-id",
        CDP_API_KEY_SECRET: "secret",
      });
      expect(refused).toContain("FACILITATOR_URL");
      expect(refused).toContain("cdp.coinbase.com");
    }

    // The address is what is refused, with or without credentials.
    expect(refusalFor({ ...required, FACILITATOR_URL: "https://api.coinbase.com/x402" })).toContain(
      "FACILITATOR_URL",
    );

    expect(() =>
      loadConfig({ ...required, FACILITATOR_URL: "https://x402.org/facilitator" }),
    ).not.toThrow();
    expect(() =>
      loadConfig({
        ...required,
        FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
        CDP_API_KEY_ID: "key-id",
        CDP_API_KEY_SECRET: "secret",
      }),
    ).not.toThrow();
    // Look-alikes are refused nothing and handed nothing. The rule is a label
    // boundary rather than a run of letters, so both a name hung off another
    // domain and a domain merely ending in those letters are here.
    for (const url of [
      "https://coinbase.com.evil.example/x402",
      "https://api.cdp.coinbase.com.evil.example/x402",
      "https://notcoinbase.com/x402",
      "https://theircdp.coinbase.example/x402",
    ]) {
      expect(() => loadConfig({ ...required, FACILITATOR_URL: url })).not.toThrow();
    }
  });

  it("does not let it start, names every problem at once and tells absent from wrong", () => {
    const bothBroken = () => loadConfig({ QUOTE_RESPONSE_MS: "not a number" });
    expect(bothBroken).toThrowError(/DATABASE_URL: the variable is not set/);
    expect(bothBroken).toThrowError(/QUOTE_RESPONSE_MS: must be a whole number of milliseconds/);

    expect(() =>
      loadConfig({ ...required, DATABASE_URL: "mysql://localhost/agentify" }),
    ).toThrowError(/DATABASE_URL: must be an address of the form postgres/);
  });

  it("refuses an address the money could not reach", () => {
    // It goes straight into the challenge that invites an agent to pay it, so a
    // truncated paste would invite them to pay nobody.
    expect(() => loadConfig({ ...required, PAY_TO_ADDRESS: "0xdeadbee" })).toThrowError(
      /PAY_TO_ADDRESS is "0xdeadbee", which is not an address on eip155:84532/,
    );
    expect(() =>
      loadConfig({ ...required, PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000001" }),
    ).not.toThrow();
  });

  it("refuses a placeholder address no payout split could be made for, saying what it is", () => {
    // The sandbox pays a merchant with no wallet at the split of this address.
    // The commission wallet there makes a split paying one wallet twice, which
    // no factory creates, and a payout contract or the token there is an
    // address no share comes back from.
    const network = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532");
    const sandbox = { ...required, FACILITATOR_URL: SANDBOX_FACILITATOR };

    for (const [placeholder, said] of [
      [network.commissionWallet, /commission wallet/],
      [network.multicall3.toLowerCase(), /Multicall3/],
      [network.usdc, /USDC/],
      ["0x0000000000000000000000000000000000000000", /zero address/],
      ["0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed", /not an address/],
    ] as const) {
      expect(refusalFor({ ...sandbox, PAY_TO_ADDRESS: placeholder }), placeholder).toMatch(
        new RegExp(`PAY_TO_ADDRESS.*${said.source}`, "s"),
      );
    }
    expect(() =>
      loadConfig({ ...sandbox, PAY_TO_ADDRESS: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }),
    ).not.toThrow();
  });

  it("refuses a chain that is not written the way the protocol writes one", () => {
    // A network name from version one of the protocol looks harmless and is a
    // different string from the one the asset table is keyed by, so a challenge
    // built from it would name an asset that is not there.
    expect(() => loadConfig({ ...required, PAYMENT_NETWORK: "base-sepolia" })).toThrowError(
      /PAYMENT_NETWORK: must be a CAIP-2 chain such as eip155:84532/,
    );
  });

  it("takes a key to seed the sandbox with, and refuses one too short to hand out", () => {
    // It is written into the database at start-up so a sandbox comes up
    // selling. Real keys are generated from thirty-two random bytes; the floor
    // is on what a sandbox may hand out.
    expect(
      loadConfig({ ...required, SANDBOX_MERCHANT_KEY: "csk_test_a-key-long-enough" })
        .sandboxMerchantKey,
    ).toBe("csk_test_a-key-long-enough");

    expect(() => loadConfig({ ...required, SANDBOX_MERCHANT_KEY: "short" })).toThrowError(
      /SANDBOX_MERCHANT_KEY: must be at least 16 characters/,
    );
  });

  it("reads a seed key set to nothing the way it reads one never set", () => {
    // Deployments unset the variable by leaving the name with nothing after
    // it; read as an empty key, that would stop the gateway from starting.
    expect(loadConfig({ ...required, SANDBOX_MERCHANT_KEY: "" }).sandboxMerchantKey).toBeNull();
    expect(loadConfig(required).sandboxMerchantKey).toBeNull();
    // Anything that is not empty is still held to the floor.
    expect(() => loadConfig({ ...required, SANDBOX_MERCHANT_KEY: " " })).toThrowError(
      /SANDBOX_MERCHANT_KEY: must be at least 16 characters/,
    );
  });

  it("refuses a deadline that is not a whole number of milliseconds above zero", () => {
    expect(() => loadConfig({ ...required, QUOTE_RESPONSE_MS: "0" })).toThrowError(
      /QUOTE_RESPONSE_MS: must be a whole number of milliseconds above zero/,
    );
    expect(() => loadConfig({ ...required, SETTLE_RESPONSE_MS: "1.5" })).toThrowError(
      /SETTLE_RESPONSE_MS: must be a whole number of milliseconds above zero/,
    );
    expect(() => loadConfig({ ...required, REDELIVERY_MAX_ATTEMPTS: "-1" })).toThrowError(
      /REDELIVERY_MAX_ATTEMPTS: must be a whole number above zero/,
    );
    expect(() => loadConfig({ ...required, REDELIVERY_FACTOR: "0.5" })).toThrowError(
      /REDELIVERY_FACTOR: must be at least 1/,
    );
  });

  it("refuses a poll window longer than a caller it cannot ask will wait", () => {
    // A worker that names its window gets the smaller of the two. A poll that
    // names none is held for this number by a caller the gateway cannot ask,
    // so the ceiling exists for that poll and the refusal says so.
    expect(() => loadConfig({ ...required, WORKER_POLL_WAIT_MS: "60000" })).toThrowError(
      /WORKER_POLL_WAIT_MS: must be at most 40000ms/,
    );
    expect(() => loadConfig({ ...required, WORKER_POLL_WAIT_MS: "60000" })).toThrowError(
      /a poll that named no window of its own/,
    );
    // The figure the ceiling is derived from is named too, as its provenance
    // rather than a claim about who is calling.
    expect(() => loadConfig({ ...required, WORKER_POLL_WAIT_MS: "60000" })).toThrowError(/50000ms/);

    // The ceiling itself is accepted: an operator who copies it out of the
    // refusal must be able to use it.
    expect(loadConfig({ ...required, WORKER_POLL_WAIT_MS: "40000" }).worker.pollWaitMs).toBe(
      40_000,
    );
  });

  it("refuses a synchronous budget the two waits inside it do not fit into", () => {
    // The agent's worst case in the synchronous mode is the merchant's answer
    // plus the charge, and the portal promises the agent one ceiling. The
    // refusal gives the ceiling, both parts and their sum, so the operator
    // sees which to change.
    const belowTheShippedWaits = refusalFor({ SYNC_BUDGET_MS: "19999" });
    for (const owed of ["synchronous budget", "19999ms", "10000ms", "20000ms"]) {
      expect(belowTheShippedWaits, belowTheShippedWaits).toContain(owed);
    }

    // Either wait grown past its share overflows the shipped ceiling.
    const longerAnswer = refusalFor({ SYNC_RESPONSE_MS: "10001" });
    for (const owed of ["synchronous budget", "20000ms", "10001ms", "10000ms", "20001ms"]) {
      expect(longerAnswer, longerAnswer).toContain(owed);
    }
    expect(refusalFor({ SETTLE_RESPONSE_MS: "10001" })).toContain("20001ms");

    // Exactly filling it is allowed: the sum is the worst case, not a target.
    // The shipped waits do exactly that.
    expect(() => loadConfig(required)).not.toThrow();
    expect(() =>
      loadConfig({ ...required, SYNC_RESPONSE_MS: "12000", SETTLE_RESPONSE_MS: "8000" }),
    ).not.toThrow();
  });

  it("refuses a synchronous answer too short to deliver an order a second time", () => {
    // Merchants are told to throw on a temporary failure so the order comes
    // again. In the synchronous mode that needs the first answer's wait, the
    // queue noticing it is over and the redelivery delay to fit before the
    // deadline.
    const tooLong = loadConfig({
      ...required,
      HANDLER_ANSWER_MS: "9000",
      REDELIVERY_BASE_DELAY_MS: "500",
    });
    const refused = secondAttemptProblem(tooLong, 500) ?? "";
    for (const owed of ["second attempt", "10000ms", "9000ms", "500ms"]) {
      expect(refused, refused).toContain(owed);
    }

    const fits = loadConfig({
      ...required,
      HANDLER_ANSWER_MS: "8900",
      REDELIVERY_BASE_DELAY_MS: "500",
    });
    expect(secondAttemptProblem(fits, 500)).toBeNull();
    // And the defaults a deployment runs with leave room for it.
    expect(secondAttemptProblem(loadConfig(required), 500)).toBeNull();
  });

  it("will not start the gateway where a synchronous sale has no second attempt", async () => {
    // Nothing answers at this database, so a gateway that skipped the check
    // would fail on the connection instead, in other words.
    const cramped = loadConfig({
      DATABASE_URL: "postgres://agentify:secret@127.0.0.1:1/agentify",
      HANDLER_ANSWER_MS: "9000",
      REDELIVERY_BASE_DELAY_MS: "500",
    });

    await expect(startGateway(cramped, nobodyAnnounces)).rejects.toThrow(
      /will not start.*second attempt/,
    );
  });

  it("gives one address for the gateway however the variable was written", () => {
    // Paths are joined onto this, so a trailing slash would give every product
    // a second address, which a discovery catalog reads as a second resource.
    const of = (PUBLIC_BASE_URL: string) =>
      loadConfig({ ...required, PUBLIC_BASE_URL }).publicBaseUrl;

    expect(of("https://agentify.example")).toBe("https://agentify.example");
    expect(of("https://agentify.example/")).toBe("https://agentify.example");
    expect(of("https://agentify.example//")).toBe("https://agentify.example");
    // A path in the base is left exactly as written: it is somebody's mount
    // point, not a stray keystroke, and taking it off would move every product.
    expect(of("https://agentify.example/gateway/")).toBe("https://agentify.example/gateway");
  });

  it("refuses a base address that carries a question mark or a fragment", () => {
    // Unlike a slash, this cannot be quietly repaired: joined paths would land
    // after the query or fragment, so every resource address would answer
    // nothing.
    const broken = (PUBLIC_BASE_URL: string) => () => loadConfig({ ...required, PUBLIC_BASE_URL });

    expect(broken("https://agentify.example/?utm=abc")).toThrowError(/PUBLIC_BASE_URL/);
    expect(broken("https://agentify.example?utm=abc")).toThrowError(/query/);
    expect(broken("https://agentify.example/#top")).toThrowError(/fragment/);
    expect(loadConfig({ ...required, PUBLIC_BASE_URL: "https://a.example/x" }).publicBaseUrl).toBe(
      "https://a.example/x",
    );
  });

  it("refuses the other spellings that make one product two addresses", () => {
    // Each parses as a URL and would go verbatim into every payment challenge.
    // The validation endpoint answers 400 to a scheme that is not lower-case
    // https; a space makes an address that answers nothing; a name and
    // password would be published to every agent that asks a price.
    const broken = (PUBLIC_BASE_URL: string) => () => loadConfig({ ...required, PUBLIC_BASE_URL });

    expect(broken("HTTPS://agentify.example")).toThrowError(/http:\/\/ or https:\/\//);
    expect(broken("ftp://agentify.example")).toThrowError(/http:\/\/ or https:\/\//);
    expect(broken("https://user:secret@agentify.example")).toThrowError(/name and password/);
    expect(broken("https://agentify.example/a b")).toThrowError(/space/);

    for (const good of [
      "http://localhost:3000",
      "https://agentify.example",
      "https://agentify.example/gateway",
    ]) {
      expect(loadConfig({ ...required, PUBLIC_BASE_URL: good }).publicBaseUrl, good).toBe(good);
    }
  });

  it("names every problem at once when more than one is wrong", () => {
    const refused = refusalFor({
      SYNC_RESPONSE_MS: "9000",
      SETTLE_RESPONSE_MS: "5000",
      SYNC_BUDGET_MS: "10000",
      FACILITATOR_URL: SANDBOX_FACILITATOR,
      CDP_API_KEY_ID: "key-id",
    });

    expect(refused, refused).toContain("synchronous budget");
    expect(refused, refused).toContain("10000ms");
    expect(refused, refused).toContain("14000ms");
    expect(refused, refused).toContain("CDP_API_KEY_ID");
  });
});

describe("a seeded key belongs to this environment", () => {
  it("stops the process on a key from the other environment", () => {
    // Catches a laptop's `.env` seeding a live gateway with a key written down
    // in a repository.
    expect(() =>
      loadConfig({
        ...required,
        PAYMENT_NETWORK: "eip155:8453",
        FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
        CDP_API_KEY_ID: "key-id",
        CDP_API_KEY_SECRET: "secret",
        SANDBOX_MERCHANT_KEY: "csk_test_a-key-long-enough",
      }),
    ).toThrowError(/SANDBOX_MERCHANT_KEY.*csk_live_/s);
  });

  it("stops the process on a key carrying no environment at all", () => {
    expect(() =>
      loadConfig({ ...required, SANDBOX_MERCHANT_KEY: "local-sandbox-merchant-key" }),
    ).toThrowError(/SANDBOX_MERCHANT_KEY.*csk_test_/s);
  });
});

describe("the environment is derived from the chain", () => {
  it("reads a written testnet as a test environment", () => {
    expect(loadConfig({ ...required, PAYMENT_NETWORK: "eip155:84532" }).environment).toBe("test");
  });

  it("reads Base mainnet as a live environment", () => {
    expect(
      loadConfig({
        ...required,
        PAYMENT_NETWORK: "eip155:8453",
        FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
        CDP_API_KEY_ID: "key-id",
        CDP_API_KEY_SECRET: "secret",
      }).environment,
    ).toBe("live");
  });

  it("stops the process on a chain that is on neither list", () => {
    expect(() => loadConfig({ ...required, PAYMENT_NETWORK: "eip155:1" })).toThrowError(
      /PAYMENT_NETWORK.*neither written list/s,
    );
  });

  it("says which three things this process is, for the surfaces", () => {
    expect(loadConfig(required).surfaceMode).toBe("test");
    expect(loadConfig({ ...required, FACILITATOR_URL: SANDBOX_FACILITATOR }).surfaceMode).toBe(
      "sandbox",
    );
  });
});

describe("Base's commission wallet", () => {
  const live = {
    ...required,
    PAYMENT_NETWORK: "eip155:8453",
    FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
    CDP_API_KEY_ID: "key-id",
    CDP_API_KEY_SECRET: "secret",
  };

  it("is the product owner's Safe wherever a gateway on Base is configured from its environment alone", () => {
    expect(loadConfig(live).payoutSplit.commissionWallet).toBe(
      "0xf44Ac5860c13fDa0577305121f00cBa4d0B96541",
    );
  });

  it("is none of the addresses of the Base Sepolia experiment, whose keys others hold", () => {
    const experiment = addressesIn(
      JSON.parse(
        readFileSync(new URL("./split/base-sepolia-experiment.json", import.meta.url), "utf8"),
      ),
    );
    expect(experiment.size).toBeGreaterThan(5);
    expect(experiment).not.toContain(loadConfig(live).payoutSplit.commissionWallet.toLowerCase());
  });

  it("is refused for want of one, among every other problem, on a table that names none", () => {
    // A table without Base, as the code's was before its Safe existed: every
    // payment would name a split paying a wallet nobody chose. The missing
    // secret is there so the refusal has to list both.
    const { CDP_API_KEY_SECRET, ...noSecret } = live;
    let refused = "";
    try {
      loadConfig(noSecret, {
        "eip155:84532": payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532"),
      });
    } catch (thrown) {
      refused = thrown instanceof Error ? thrown.message : String(thrown);
    }

    expect(refused).toMatch(/eip155:8453.*commission wallet/s);
    expect(refused).toMatch(/CDP_API_KEY_SECRET/);
  });
});

/** Every value in this document, and in what it holds, that is written as an address, in lower case. */
function addressesIn(value: unknown): Set<string> {
  const found = new Set<string>();
  const walk = (inner: unknown): void => {
    if (typeof inner === "string" && /^0x[0-9a-fA-F]{40}$/.test(inner))
      found.add(inner.toLowerCase());
    else if (Array.isArray(inner)) inner.forEach(walk);
    else if (inner !== null && typeof inner === "object") Object.values(inner).forEach(walk);
  };
  walk(value);
  return found;
}

describe("a live chain is allowed exactly one facilitator", () => {
  const live = {
    ...required,
    PAYMENT_NETWORK: "eip155:8453",
    FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
    CDP_API_KEY_ID: "key-id",
    CDP_API_KEY_SECRET: "secret",
  };

  it("starts on Coinbase's canonical facilitator with both credentials", () => {
    expect(() => loadConfig(live)).not.toThrow();
  });

  it("refuses the scripted facilitator, which takes payments that never happened", () => {
    const { CDP_API_KEY_ID, CDP_API_KEY_SECRET, ...noCredentials } = live;
    expect(() =>
      loadConfig({ ...noCredentials, FACILITATOR_URL: SANDBOX_FACILITATOR }),
    ).toThrowError(/eip155:8453.*sandbox:scripted/s);
  });

  it("refuses the public x402 facilitator", () => {
    const { CDP_API_KEY_ID, CDP_API_KEY_SECRET, ...noCredentials } = live;
    expect(() =>
      loadConfig({ ...noCredentials, FACILITATOR_URL: "https://x402.org/facilitator" }),
    ).toThrowError(/eip155:8453.*x402\.org/s);
  });

  it("refuses the default that arrives when nobody names the variable at all", () => {
    // FACILITATOR_URL falls back to the public facilitator, so a test host's
    // `.env` with only the network changed would otherwise start live, issue
    // csk_live_ keys and settle in the wrong place.
    const { FACILITATOR_URL, CDP_API_KEY_ID, CDP_API_KEY_SECRET, ...unnamed } = live;
    expect(() => loadConfig(unnamed)).toThrowError(/eip155:8453.*FACILITATOR_URL/s);
  });

  it("refuses Coinbase's facilitator without credentials", () => {
    const { CDP_API_KEY_ID, CDP_API_KEY_SECRET, ...noCredentials } = live;
    expect(() => loadConfig(noCredentials)).toThrowError(/CDP_API_KEY_ID and CDP_API_KEY_SECRET/);
  });

  it("refuses Coinbase's facilitator over http, which puts a bearer token on the wire in the clear", () => {
    expect(() =>
      loadConfig({ ...live, FACILITATOR_URL: "http://api.cdp.coinbase.com/platform/v2/x402" }),
    ).toThrowError(/https:/);
  });

  it("takes the same endpoint written with a trailing slash", () => {
    // The same deployment, and the client takes the slash off before it signs
    // anything. Refusing it would be an operator with a correct configuration
    // being told it is wrong.
    expect(() =>
      loadConfig({ ...live, FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402/" }),
    ).not.toThrow();
  });

  it("refuses Coinbase's host with a path the facilitator does not answer on", () => {
    // Starts healthy, issues csk_live_ keys, and fails at the first buyer: the
    // gateway builds /verify and /settle under whatever base it was given.
    expect(() =>
      loadConfig({ ...live, FACILITATOR_URL: "https://api.cdp.coinbase.com/wrong" }),
    ).toThrowError(/https:\/\/api\.cdp\.coinbase\.com\/platform\/v2\/x402/);
  });

  it("refuses a name and password written into Coinbase's address", () => {
    // A request whose address carries credentials is refused where it is
    // built, so every verify and settle would throw on a gateway that came up
    // healthy, and that refusal would print the password into the log.
    expect(() =>
      loadConfig({
        ...live,
        FACILITATOR_URL: "https://someone:secret@api.cdp.coinbase.com/platform/v2/x402",
      }),
    ).toThrowError(/https:\/\/api\.cdp\.coinbase\.com\/platform\/v2\/x402/);
  });

  it("refuses a port the facilitator does not answer on", () => {
    // Nothing listens on that port: the gateway would start, issue keys, and
    // find out at the first buyer.
    expect(() =>
      loadConfig({
        ...live,
        FACILITATOR_URL: "https://api.cdp.coinbase.com:8443/platform/v2/x402",
      }),
    ).toThrowError(/https:\/\/api\.cdp\.coinbase\.com\/platform\/v2\/x402/);
  });

  it("takes the same endpoint with the port https already means written out", () => {
    // `:443` is what `https:` means, and the address parser drops it, so this
    // is the canonical endpoint spelled in full. Refusing it would be an
    // operator with a correct live configuration told it is wrong.
    expect(() =>
      loadConfig({
        ...live,
        FACILITATOR_URL: "https://api.cdp.coinbase.com:443/platform/v2/x402",
      }),
    ).not.toThrow();
  });

  it("leaves a test chain free to keep the scripted facilitator", () => {
    // The laptop requires exactly that pairing, and it is what makes
    // `docker compose up` sell with no network, no wallet and no faucet.
    expect(() =>
      loadConfig({
        ...required,
        PAYMENT_NETWORK: "eip155:84532",
        FACILITATOR_URL: SANDBOX_FACILITATOR,
      }),
    ).not.toThrow();
  });
});

import {
  CDP_FACILITATOR_URL,
  type Environment,
  environmentOf,
  environmentOfKeyPrefix,
  isSandboxFacilitator,
  keyPrefixFor,
  SANDBOX_FACILITATOR,
  type SurfaceMode,
  surfaceModeOf,
} from "@agentify/core";
import { z } from "zod";
import {
  PAYOUT_SPLIT_NETWORKS,
  type PayoutSplitNetwork,
  type PayoutSplitNetworks,
  payoutSplitNetworkOf,
} from "./split/networks.js";
import { type NotAPayoutWallet, whyNotAPayoutWallet } from "./split/wallet-rule.js";

/**
 * Re-exported from the core rather than defined here: the dashboard tests for
 * the sandbox against the same value, and two spellings of it would disagree.
 */
export { isSandboxFacilitator, SANDBOX_FACILITATOR };

function absentOrWrong(whenWrong: string) {
  return (issue: { input: unknown }): string =>
    issue.input === undefined ? "the variable is not set" : whenWrong;
}

/**
 * Matched on the host, never on the exact address: the same facilitator also
 * answers on a staging host and with a trailing slash, and each needs
 * credentials. A prefix match on the whole address would take
 * `cdp.coinbase.com.evil.example` for Coinbase and send it credentials.
 */
const CDP_FACILITATOR_DOMAIN = "cdp.coinbase.com";

const COINBASE_DOMAIN = "coinbase.com";

/**
 * The host in lower case and without a trailing root dot:
 * `api.cdp.coinbase.com.` is the same host as `api.cdp.coinbase.com`, and left
 * apart the fully qualified spelling would match no comparison and be handed
 * no credentials. Null when the string is not an address.
 */
function hostOf(url: string): string | null {
  if (!URL.canParse(url)) {
    return null;
  }
  return new URL(url).hostname.replace(/\.+$/, "");
}

const isUnder = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/**
 * Coinbase's facilitator takes no request without credentials. Every other
 * address is unauthenticated as far as this gateway knows and is handed
 * nothing.
 */
export const isCdpFacilitator = (facilitatorUrl: string): boolean => {
  const host = hostOf(facilitatorUrl);
  return host !== null && isUnder(host, CDP_FACILITATOR_DOMAIN);
};

/**
 * A Coinbase host that is not the facilitator's stops the gateway at startup
 * instead of building a client that refuses every payment. A look-alike such
 * as `coinbase.com.evil.example` is not under the domain: it is handed nothing
 * and starts.
 */
const isOtherCoinbaseHost = (facilitatorUrl: string): boolean => {
  const host = hostOf(facilitatorUrl);
  return host !== null && isUnder(host, COINBASE_DOMAIN) && !isUnder(host, CDP_FACILITATOR_DOMAIN);
};

/**
 * Whether this is the one address a live chain may settle through. Every part
 * is compared because the gateway builds `/verify` and `/settle` under it and
 * a mistake anywhere comes up healthy and fails at the first buyer: `http:`
 * would put both credentials on the wire in the clear, a user name or password
 * would make every request throw and print the password into the log, and a
 * query or fragment would be carried into every request. Trailing slashes on
 * the path are ignored because the facilitator client strips them too.
 *
 * Narrower than `isCdpFacilitator`, which decides which host may be handed
 * credentials; this decides which one endpoint real money may settle through.
 */
function isTheLiveFacilitator(facilitatorUrl: string): boolean {
  const host = hostOf(facilitatorUrl);
  if (host === null) {
    return false;
  }
  const given = new URL(facilitatorUrl);
  const wanted = new URL(CDP_FACILITATOR_URL);
  return (
    given.protocol === "https:" &&
    host === wanted.hostname &&
    given.port === "" &&
    given.username === "" &&
    given.password === "" &&
    given.pathname.replace(/\/+$/, "") === wanted.pathname.replace(/\/+$/, "") &&
    given.search === "" &&
    given.hash === ""
  );
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
}

/**
 * Strips the trailing root dot from the facilitator's host once, where the
 * value is read. Left in, the client would sign a token naming
 * `api.cdp.coinbase.com.`, and if the far end does not read that as the same
 * name every verify comes back "unknown" and the buyer's agent retries a
 * purchase that can never complete. Only an http address is touched.
 */
function canonicalFacilitatorUrl(value: string): string {
  if (!isHttpUrl(value)) {
    return value;
  }
  const url = new URL(value);
  url.hostname = url.hostname.replace(/\.+$/, "");
  return url.href;
}

function isPostgresUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const { protocol } = new URL(value);
  return protocol === "postgres:" || protocol === "postgresql:";
}

/**
 * Every wait the order machine knows about is read here; none is invented
 * further down. Zero is refused because a deadline of zero has already run out
 * on every order.
 */
const durationMs = (fallback: number) =>
  z
    .string({ error: absentOrWrong("must be a whole number of milliseconds above zero") })
    .regex(/^\d+$/, "must be a whole number of milliseconds above zero")
    .transform(Number)
    .refine((value) => value > 0, "must be a whole number of milliseconds above zero")
    .default(fallback);

const countAbove = (fallback: number) =>
  z
    .string({ error: absentOrWrong("must be a whole number above zero") })
    .regex(/^\d+$/, "must be a whole number above zero")
    .transform(Number)
    .refine((value) => value > 0, "must be a whole number above zero")
    .default(fallback);

/**
 * A copy of `POLL_DEADLINE_MS` in `packages/sdk/src/worker.ts`: how long the
 * SDK's worker waits for a poll before abandoning it. The gateway does not
 * depend on the SDK, so the number is written down twice and must be changed
 * on both sides together.
 */
const SDK_WORKER_POLL_DEADLINE_MS = 50_000;

/**
 * The most `WORKER_POLL_WAIT_MS` may be. A poll that names no window of its own
 * is held that long, and held past the SDK worker's deadline it is cut off from
 * the far end with nothing on this side reporting it. The ten seconds of
 * headroom cover the connection, the proxies, the queue's polling granularity
 * and the way back, which the worker's clock counts and this one does not.
 */
const WORKER_POLL_WAIT_CEILING_MS = 40_000;

/** The chain a gateway takes payments on where `PAYMENT_NETWORK` names none. */
export const DEFAULT_PAYMENT_NETWORK = "eip155:84532";

/**
 * The environment is an external boundary like any request, so it is parsed
 * here and a bad value stops the process at startup rather than at the first
 * payment. The defaults are sandbox defaults; only `DATABASE_URL` has none.
 */
const environmentSchema = z.object({
  /** One Postgres for everything: orders, receipts and the queue. */
  DATABASE_URL: z
    .string({ error: absentOrWrong("must be a string") })
    .refine(isPostgresUrl, "must be an address of the form postgres://user@host:port/database"),

  /**
   * A merchant key written into the database at startup if it is not there
   * yet, so a local sandbox sells from one command; after that it is read like
   * any other key row. A deployed channel sets nothing here and its release
   * refuses one that does: a key in the environment is seeded into every fresh
   * database again and cannot be revoked without a deployment.
   *
   * Empty reads the same as unset and seeds nothing. The 16-character floor is
   * only what a stack may hand out; `loadConfig` checks the key's prefix
   * against the environment derived from the payment network.
   */
  SANDBOX_MERCHANT_KEY: z
    .string({ error: absentOrWrong("must be a string") })
    .transform((value) => (value === "" ? null : value))
    .refine(
      (value) => value === null || value.length >= 16,
      "must be at least 16 characters, or empty to seed nothing",
    )
    .nullable()
    .default(null),

  /** How long we wait for the merchant to say what the goods cost. */
  QUOTE_RESPONSE_MS: durationMs(5_000),
  /**
   * How long a price holds, and with it the unpaid order it was named for. The
   * payment challenge offers an agent this long to pay, so it is also how long
   * the authorisation an agent signs stays valid, and a synchronous card's
   * charge, sent after its goods, has to go through inside it.
   */
  QUOTE_TTL_MS: durationMs(30_000),
  /**
   * How long we wait to be told whether the charge went through, on a
   * synchronous order: the goods are already made, and this wait is inside the
   * ceiling its agent was promised (`SYNC_BUDGET_MS`). The payment layer
   * answers only once the transfer is in a block, so a wait near the block
   * time declares silent a charge that then goes through, and the agent leaves
   * without the goods it paid for.
   */
  SETTLE_RESPONSE_MS: durationMs(10_000),
  /**
   * The same wait on an order paid before its goods (asynchronous, confirmed
   * or a parcel), which no promised ceiling contains. The payment layer
   * answers only once the transfer is in a block, so a wait near the block
   * time closes orders whose money then arrives, each as a refund owed. The
   * purchase call does not wait on this; it waits on the payment layer itself.
   */
  SETTLE_BEFORE_GOODS_MS: durationMs(15_000),
  /**
   * How long the merchant has to answer a synchronous order with the goods,
   * counted from the moment the payment checked out. The portal publishes this
   * number to every merchant.
   */
  SYNC_RESPONSE_MS: durationMs(10_000),
  /**
   * The ceiling the portal promises the agent for a synchronous purchase,
   * counted from the same moment, and how long its purchase call waits. No
   * deadline in the machine carries this number; it bounds the two that do,
   * the merchant's answer and then the charge.
   */
  SYNC_BUDGET_MS: durationMs(20_000),
  /** How long a confirmed order waits for the agent's payment. */
  PAYMENT_AFTER_CONFIRMATION_MS: durationMs(300_000),
  /** What a card that names no confirmation deadline of its own is held to. */
  DEFAULT_CONFIRMATION_RESPONSE_MS: durationMs(3_600_000),
  /** What a card that names no delivery deadline of its own is held to. */
  DEFAULT_ASYNC_FULFILLMENT_MS: durationMs(86_400_000),

  REDELIVERY_BASE_DELAY_MS: durationMs(500),
  /**
   * How much each wait grows on the one before it. One means a flat retry;
   * below one is refused because the waits would shrink towards zero and hammer
   * a merchant already in trouble.
   */
  REDELIVERY_FACTOR: z
    .string({ error: absentOrWrong("must be at least 1") })
    .regex(/^\d+(?:\.\d+)?$/, "must be at least 1")
    .transform(Number)
    .refine((value) => value >= 1, "must be at least 1")
    .default(2),
  REDELIVERY_MAX_DELAY_MS: durationMs(30_000),
  REDELIVERY_MAX_ATTEMPTS: countAbove(5),

  /**
   * How long a handler has to answer a delivery before it is reported
   * unanswered. Not a deadline on the order: from that report the machine
   * decides whether another attempt still fits the order's own deadline.
   */
  HANDLER_ANSWER_MS: durationMs(3_000),

  /**
   * How many times a failed reminder is delivered again. A reminder is the only
   * thing that declares an order overdue, so losing one to a briefly
   * unreachable store costs a refund nobody marks; retrying forever would turn
   * a defect into a loop.
   */
  REMINDER_ATTEMPTS: countAbove(3),
  REMINDER_RETRY_DELAY_MS: durationMs(5_000),
  /**
   * How long an order waits before it is offered to a worker again when the
   * machine turned the hand-over away because a charge on that order was being
   * executed at the time.
   */
  SETTLE_IN_FLIGHT_RETRY_MS: durationMs(1_000),
  /**
   * How long a claim on a payment is kept. A claim guards the window between
   * verifying a payment and executing the charge; after that the token itself
   * refuses a second use. The route that makes claims takes no key, so they
   * cannot be kept forever.
   */
  CLAIM_RETENTION_MS: durationMs(30 * 24 * 60 * 60 * 1_000),
  /**
   * How long an order may sit paid before the sweep decides its envelope
   * reached nobody and sends it out again. Too short and a busy merchant who is
   * merely between polls gets duplicates; too long and a paid order reaches
   * nobody until its fulfillment deadline turns it into a debt.
   */
  SWEEP_DISPATCH_GRACE_MS: durationMs(5 * 60 * 1_000),
  /**
   * How many of the payment layer's own words one order keeps; an operator
   * reconciles a silent charge from them. They arrive on an unauthenticated
   * route, so the list is bounded and what falls off it is counted.
   */
  PAYMENT_WORDS_KEPT: countAbove(20),

  /**
   * How long the gateway holds a worker's poll open. A poll that named no
   * window of its own is held for exactly this, so it is capped by
   * `WORKER_POLL_WAIT_CEILING_MS`.
   */
  WORKER_POLL_WAIT_MS: durationMs(25_000).refine(
    (value) => value <= WORKER_POLL_WAIT_CEILING_MS,
    `must be at most ${WORKER_POLL_WAIT_CEILING_MS}ms — a poll that named no window of its own is ` +
      "held for this long, and the gateway does not know when the client behind it stops waiting; " +
      `the ceiling keeps that below the ${SDK_WORKER_POLL_DEADLINE_MS}ms at which this project's own ` +
      "worker abandons a poll, which is the only published figure for what a worker here sits through",
  ),

  /**
   * Where agents reach this gateway, named in every payment challenge; behind
   * a reverse proxy it differs from what this process sees. A trailing slash is
   * taken off because a path is joined onto this, and a doubled slash is a
   * second resource to a discovery catalog. Everything else wrong is refused
   * rather than repaired; a scheme in capitals, for one, is answered 400 by the
   * catalog's validation endpoint and leaves the gateway unlisted with nothing
   * saying why. A host in capitals, with a trailing dot or in a non-Latin
   * script is left as written although each also makes a second spelling.
   */
  PUBLIC_BASE_URL: z
    .url()
    .refine(
      (value) => /^https?:\/\//.test(value),
      "must begin with http:// or https:// in lower case, because this string is used exactly as written",
    )
    .refine(
      (value) => !/[?#]/.test(value),
      "must not carry a query or a fragment: a path is joined onto this, so either would end up in the middle of every address",
    )
    .refine(
      (value) => !/\s/.test(value),
      "must not carry a space: this is an address an agent is told to come back to",
    )
    .refine(
      (value) => !/^https?:\/\/[^/@]*@/.test(value),
      "must not carry a user name and password: this address is published to every agent that asks a price",
    )
    .default("http://localhost:3000")
    .transform((value) => value.replace(/\/+$/, "")),

  /**
   * The facilitator, or `SANDBOX_FACILITATOR` for a gateway with no chain
   * behind it. One field on purpose: a deployment that names a real facilitator
   * cannot also be in the sandbox, because there is no second flag to disagree.
   */
  FACILITATOR_URL: z
    .string({ error: absentOrWrong("must be a string") })
    .refine(
      (value) => value === SANDBOX_FACILITATOR || isHttpUrl(value),
      `must be an http address of a facilitator, or "${SANDBOX_FACILITATOR}" for a gateway with no chain behind it`,
    )
    .default("https://x402.org/facilitator")
    .transform(canonicalFacilitatorUrl),
  /**
   * A CAIP-2 chain identifier. The default is Base Sepolia, a test network, so
   * going live never happens by forgetting a variable.
   */
  PAYMENT_NETWORK: z
    .string()
    .regex(/^[^:\s]+:[^:\s]+$/, "must be a CAIP-2 chain such as eip155:84532")
    .default(DEFAULT_PAYMENT_NETWORK),
  /**
   * Where the money goes. Absent until a real payment is to be taken, and held
   * to the shape of its chain when present: it goes straight into the
   * challenge, and a truncated paste would invite agents to pay nobody.
   */
  PAY_TO_ADDRESS: z.string().min(1).optional(),
  CDP_API_KEY_ID: emptyIsAbsent(z.string().min(1)),
  CDP_API_KEY_SECRET: emptyIsAbsent(z.string().min(1)),
});

/**
 * Compose hands every service a fixed list of variables, so an unset
 * credential arrives as an empty value. That reads as no credential, not as a
 * malformed one that stops a stack whose facilitator asks for none.
 */
function emptyIsAbsent(rule: z.ZodType<string, string>) {
  return z
    .string()
    .optional()
    .transform((given) => (given === undefined || given === "" ? undefined : given))
    .pipe(z.union([z.undefined(), rule]));
}

interface DeadlineConfig {
  readonly quoteResponseMs: number;
  readonly quoteTtlMs: number;
  /** The wait for the charge on a synchronous order, after its goods. */
  readonly settleResponseMs: number;
  /** The wait for the charge on an order paid before its goods. */
  readonly settleBeforeGoodsMs: number;
  readonly syncResponseMs: number;
  /** The promised ceiling the two synchronous waits have to fit inside. */
  readonly syncBudgetMs: number;
  readonly paymentAfterConfirmationMs: number;
  readonly defaultConfirmationResponseMs: number;
  readonly defaultAsyncFulfillmentMs: number;
  readonly handlerAnswerMs: number;
}

interface RedeliveryConfig {
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
}

interface WorkerConfig {
  readonly pollWaitMs: number;
}

export interface PaymentConfig {
  readonly facilitatorUrl: string;
  readonly network: string;
  readonly payTo: string | null;
  readonly cdpApiKeyId: string | null;
  readonly cdpApiKeySecret: string | null;
}

export interface GatewayConfig {
  readonly databaseUrl: string;
  /** A key seeded into the database at startup, or null to seed nothing. */
  readonly sandboxMerchantKey: string | null;
  readonly publicBaseUrl: string;
  readonly reminderAttempts: number;
  readonly reminderRetryDelayMs: number;
  /** How long an order waits when a hand-over met a charge in flight. */
  readonly settleInFlightRetryMs: number;
  readonly claimRetentionMs: number;
  /** How long a paid order may sit before the sweep sends it out again. */
  readonly sweepDispatchGraceMs: number;
  readonly paymentWordsKept: number;
  readonly deadlines: DeadlineConfig;
  readonly redelivery: RedeliveryConfig;
  readonly worker: WorkerConfig;
  readonly payment: PaymentConfig;
  /**
   * Whether this deployment's money is real, derived from the chain alone. It
   * decides the prefix on every key issued and the `test` mark on every order
   * and receipt written.
   */
  readonly environment: Environment;
  /**
   * What this process may present itself as. Separate from `environment`
   * because a sandbox settles against nothing on a chain whose name says
   * otherwise.
   */
  readonly surfaceMode: SurfaceMode;
  /**
   * The payout split of the network payments are taken on: the commission
   * wallet and rate every new split here names, and the contracts a payout
   * calls. The sandbox has Base Sepolia's, the chain it describes.
   */
  readonly payoutSplit: PayoutSplitNetwork;
  /**
   * Every network's payout split, of which `payoutSplit` is one, for the
   * rules that look past this network: no merchant's wallet may be another
   * network's commission wallet or token either.
   */
  readonly payoutSplitNetworks: PayoutSplitNetworks;
}

/**
 * The arithmetic between the deadlines, checked at startup because a breach
 * fails quietly on a sale by breaking a promise the portal made to the agent.
 * The price wait is not part of it: the price is asked on the unpaid call, and
 * the merchant's clock starts only once a payment has checked out.
 */
function arithmeticProblems(deadlines: DeadlineConfig): string[] {
  const problems: string[] = [];
  const { syncResponseMs, settleResponseMs, syncBudgetMs } = deadlines;

  // In the synchronous mode the agent's worst case is the merchant's answer
  // plus the charge: the goods come back on the first clock and the money
  // moves on the second.
  const worstCase = syncResponseMs + settleResponseMs;
  if (worstCase > syncBudgetMs) {
    problems.push(
      `the synchronous budget is ${syncBudgetMs}ms and the answer (${syncResponseMs}ms) and ` +
        `the charge (${settleResponseMs}ms) inside it come to ${worstCase}ms`,
    );
  }

  return problems;
}

/**
 * Why a synchronous sale could not survive a handler that throws once, or null
 * when it can: a second attempt must fit before the answer's deadline. The
 * time the queue takes to notice a missed answer is part of that sum, so this
 * is asked where the queue is chosen; a queue that fires reminders on time
 * passes zero.
 */
export function secondAttemptProblem(config: GatewayConfig, reminderPollMs: number): string | null {
  const { syncResponseMs, handlerAnswerMs } = config.deadlines;
  const firstRedeliveryMs = config.redelivery.baseDelayMs;
  const secondAttempt = handlerAnswerMs + reminderPollMs + firstRedeliveryMs;
  if (secondAttempt < syncResponseMs) {
    return null;
  }
  return (
    `a synchronous answer has ${syncResponseMs}ms and leaves no room for a second attempt: ` +
    `the wait for the first answer (${handlerAnswerMs}ms), the queue noticing it ` +
    `(${reminderPollMs}ms) and the delay before the next (${firstRedeliveryMs}ms) come to ` +
    `${secondAttempt}ms`
  );
}

/** What a configured placeholder is, where it could not be a merchant's wallet. */
const PLACEHOLDER_REFUSED: Readonly<Record<NotAPayoutWallet, string>> = {
  zero_address: "the zero address",
  commission_wallet: "a network's commission wallet",
  split_factory: "the payout split factory",
  split_implementation: "the payout split implementation",
  split_warehouse: "the 0xSplits warehouse",
  multicall3: "Multicall3",
  usdc: "a network's USDC",
  payout_split: "a payout split",
};

/**
 * Names every configuration problem at once rather than the first, so the
 * whole list is learned in one restart.
 *
 * The payout split table is the one in the code. Only a test hands another,
 * to run a network the code has no commission wallet for yet; nothing in the
 * environment reaches it.
 */
export function loadConfig(
  environment: Record<string, string | undefined>,
  payoutSplitNetworks: PayoutSplitNetworks = PAYOUT_SPLIT_NETWORKS,
): GatewayConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const variable = issue.path.join(".");
      return variable === "" ? issue.message : `${variable}: ${issue.message}`;
    });

    throw new Error(
      `The gateway cannot start, the configuration is incomplete — ${problems.join("; ")}`,
    );
  }

  const environmentValues = parsed.data;

  const deadlines: DeadlineConfig = {
    quoteResponseMs: environmentValues.QUOTE_RESPONSE_MS,
    quoteTtlMs: environmentValues.QUOTE_TTL_MS,
    settleResponseMs: environmentValues.SETTLE_RESPONSE_MS,
    settleBeforeGoodsMs: environmentValues.SETTLE_BEFORE_GOODS_MS,
    syncResponseMs: environmentValues.SYNC_RESPONSE_MS,
    syncBudgetMs: environmentValues.SYNC_BUDGET_MS,
    paymentAfterConfirmationMs: environmentValues.PAYMENT_AFTER_CONFIRMATION_MS,
    defaultConfirmationResponseMs: environmentValues.DEFAULT_CONFIRMATION_RESPONSE_MS,
    defaultAsyncFulfillmentMs: environmentValues.DEFAULT_ASYNC_FULFILLMENT_MS,
    handlerAnswerMs: environmentValues.HANDLER_ANSWER_MS,
  };

  const problems = arithmeticProblems(deadlines);
  const payTo = environmentValues.PAY_TO_ADDRESS ?? null;
  const network = environmentValues.PAYMENT_NETWORK;

  // Catches a production environment file copied onto a sandbox: facilitator
  // credentials beside an address that settles against nothing are leftovers.
  // PAY_TO_ADDRESS is not refused here, because the payment challenge cannot
  // be built without one and a sandbox could not sell.
  if (
    isSandboxFacilitator(environmentValues.FACILITATOR_URL) &&
    (environmentValues.CDP_API_KEY_ID !== undefined ||
      environmentValues.CDP_API_KEY_SECRET !== undefined)
  ) {
    problems.push(
      `FACILITATOR_URL is ${JSON.stringify(SANDBOX_FACILITATOR)}, which settles against nothing, ` +
        "and CDP_API_KEY_ID or CDP_API_KEY_SECRET is set — those talk to a real facilitator, " +
        "so one of the two is left over from somewhere else",
    );
  }

  // Coinbase's facilitator answers nothing unsigned, so without credentials the
  // gateway would come up healthy and fail at the first charge, in front of a
  // buyer. Each missing name is listed because that is what the operator fixes.
  if (isCdpFacilitator(environmentValues.FACILITATOR_URL)) {
    const missing = [
      ...(environmentValues.CDP_API_KEY_ID === undefined ? ["CDP_API_KEY_ID"] : []),
      ...(environmentValues.CDP_API_KEY_SECRET === undefined ? ["CDP_API_KEY_SECRET"] : []),
    ];
    if (missing.length > 0) {
      problems.push(
        `FACILITATOR_URL is ${JSON.stringify(environmentValues.FACILITATOR_URL)}, which is Coinbase's ` +
          `facilitator and takes no request without credentials, and ${missing.join(" and ")} ` +
          `${missing.length === 1 ? "is" : "are"} not set — nothing would be verified and nothing ` +
          "would be settled, and the first to find that out would be a buyer",
      );
    }
  } else if (isOtherCoinbaseHost(environmentValues.FACILITATOR_URL)) {
    // Credentials go to the one facilitator host only, so any other Coinbase
    // host would come up sending none and be refused at the first charge.
    problems.push(
      `FACILITATOR_URL is ${JSON.stringify(environmentValues.FACILITATOR_URL)}, which is a host of ` +
        `Coinbase's that this gateway cannot sign a request for — the facilitator it knows is at ` +
        `${CDP_FACILITATOR_DOMAIN}, and credentials go there and nowhere else. Pointed here it would ` +
        "send none, and a facilitator that takes no request without them refuses every verify and " +
        "every settle in front of a buyer",
    );
  }

  // A chain on neither the live nor the test list is refused rather than
  // sorted into a side.
  let chainEnvironment: Environment | null = null;
  try {
    chainEnvironment = environmentOf(network);
  } catch (thrown) {
    problems.push(thrown instanceof Error ? thrown.message : String(thrown));
  }

  // Every payment is asked for at a split paying the network's commission
  // wallet, so a chain the code names none for cannot sell at all.
  try {
    payoutSplitNetworkOf(payoutSplitNetworks, network);
  } catch (thrown) {
    problems.push(`PAYMENT_NETWORK: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  }

  // The prefix says which environment a key belongs to; it is not a check that
  // seeding is allowed here. The release refuses any seeded key on a deployed
  // channel, whatever its prefix.
  const seeded = environmentValues.SANDBOX_MERCHANT_KEY;
  if (chainEnvironment !== null && seeded !== null) {
    const theirs = environmentOfKeyPrefix(seeded);
    if (theirs !== chainEnvironment) {
      problems.push(
        `SANDBOX_MERCHANT_KEY does not carry this environment's prefix — PAYMENT_NETWORK is ` +
          `${JSON.stringify(network)}, which is a ${chainEnvironment} environment, so a key seeded here ` +
          `must begin with ${JSON.stringify(keyPrefixFor(chainEnvironment))}. A key seeded under the ` +
          "other environment's prefix opens nothing, because the door turns it away by its prefix " +
          "before it is looked up",
      );
    }
  }

  // A live chain settles through exactly one facilitator. `sandbox:scripted`
  // there would take payments that never happened, and the unset default is
  // silent: it falls back to the public facilitator, so a test host's `.env`
  // with one line changed would start, issue live keys and settle elsewhere.
  if (chainEnvironment === "live" && !isTheLiveFacilitator(environmentValues.FACILITATOR_URL)) {
    problems.push(
      `PAYMENT_NETWORK is ${JSON.stringify(network)}, where the money is real, and FACILITATOR_URL ` +
        `is ${JSON.stringify(environmentValues.FACILITATOR_URL)} — a live chain settles through ` +
        `${CDP_FACILITATOR_URL} and nothing else, with CDP_API_KEY_ID and CDP_API_KEY_SECRET both ` +
        "set. Nothing else here can verify or settle, and every other value either takes payments " +
        "that never happened or sends credentials somewhere they were not issued for",
    );
  }

  if (payTo !== null && network.startsWith("eip155:") && !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    problems.push(
      `PAY_TO_ADDRESS is ${JSON.stringify(payTo)}, which is not an address on ${network}`,
    );
  } else if (payTo !== null) {
    // The sandbox pays a merchant with no wallet at the split of this address,
    // so it is held to the rule a merchant's wallet is held to.
    try {
      const is = whyNotAPayoutWallet(payTo, { networks: payoutSplitNetworks, splits: [] });
      if (is !== null) {
        problems.push(
          `PAY_TO_ADDRESS is ${payTo}, which is ${PLACEHOLDER_REFUSED[is]}, and no payout split could stand in for a merchant's wallet with it`,
        );
      }
    } catch (thrown) {
      problems.push(`PAY_TO_ADDRESS: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `The gateway cannot start, these settings do not work together — ${problems.join("; ")}`,
    );
  }

  // Past the throw above the chain is a known one with a payout split, so both
  // are read again rather than carried down as nullables.
  const derivedEnvironment = environmentOf(network);

  return {
    databaseUrl: environmentValues.DATABASE_URL,
    sandboxMerchantKey: environmentValues.SANDBOX_MERCHANT_KEY,
    publicBaseUrl: environmentValues.PUBLIC_BASE_URL,
    reminderAttempts: environmentValues.REMINDER_ATTEMPTS,
    reminderRetryDelayMs: environmentValues.REMINDER_RETRY_DELAY_MS,
    settleInFlightRetryMs: environmentValues.SETTLE_IN_FLIGHT_RETRY_MS,
    claimRetentionMs: environmentValues.CLAIM_RETENTION_MS,
    sweepDispatchGraceMs: environmentValues.SWEEP_DISPATCH_GRACE_MS,
    paymentWordsKept: environmentValues.PAYMENT_WORDS_KEPT,
    deadlines,
    redelivery: {
      baseDelayMs: environmentValues.REDELIVERY_BASE_DELAY_MS,
      factor: environmentValues.REDELIVERY_FACTOR,
      maxDelayMs: environmentValues.REDELIVERY_MAX_DELAY_MS,
      maxAttempts: environmentValues.REDELIVERY_MAX_ATTEMPTS,
    },
    worker: {
      pollWaitMs: environmentValues.WORKER_POLL_WAIT_MS,
    },
    payment: {
      facilitatorUrl: environmentValues.FACILITATOR_URL,
      network,
      payTo,
      cdpApiKeyId: environmentValues.CDP_API_KEY_ID ?? null,
      cdpApiKeySecret: environmentValues.CDP_API_KEY_SECRET ?? null,
    },
    environment: derivedEnvironment,
    surfaceMode: surfaceModeOf(network, environmentValues.FACILITATOR_URL),
    payoutSplit: payoutSplitNetworkOf(payoutSplitNetworks, network),
    payoutSplitNetworks,
  };
}

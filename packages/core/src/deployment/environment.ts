/**
 * Which environment a deployment is, derived from the chain it settles on.
 *
 * There is deliberately no separate environment flag. A flag beside the chain
 * can disagree with it, survive a copied `.env` or be left set from yesterday,
 * and makes possible a gateway that believes it is testing while it moves real
 * money.
 *
 * This is deployment policy, not wire contract, so it stays out of
 * `@nuanu-ai/agentify-contracts`: an integrator could neither act on the chain
 * lists nor rely on them. The wire's answer is the `test` field of an order and
 * a receipt.
 */

/** What a deployment is, for the keys it issues and the mark it writes. */
export type Environment = "test" | "live";

/**
 * What a page is allowed to say. The laptop sandbox is the third case: its
 * chain is Base Sepolia but its facilitator settles against nothing, so a page
 * reading the chain alone would claim payments settle on Base Sepolia.
 */
export type SurfaceMode = "sandbox" | "test" | "live";

/** The chains whose money is play money. */
export const TESTNET_CHAINS: ReadonlySet<string> = new Set([
  "eip155:84532", // Base Sepolia
  "eip155:11155111", // Ethereum Sepolia
  "eip155:80002", // Polygon Amoy
]);

/**
 * The chains where the money is real. Ethereum and Polygon mainnet are
 * deliberately absent: a chain we do not sell on is refused like any other
 * unlisted one, and adding one is a decision, not a value somebody types into a
 * file.
 */
export const LIVE_CHAINS: ReadonlySet<string> = new Set([
  "eip155:8453", // Base mainnet
]);

/**
 * The address that selects the scripted facilitator, which verifies and settles
 * against nothing: every payment it accepts is pretend. It lives here so the
 * gateway and the dashboard spell this one value the same way.
 */
export const SANDBOX_FACILITATOR = "sandbox:scripted";

/** Coinbase's facilitator, in the one spelling a live chain is allowed. */
export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

/** The public facilitator, which asks for no credentials. */
export const PUBLIC_X402_FACILITATOR_URL = "https://x402.org/facilitator";

/** Whether this deployment settles against nothing. */
export const isSandboxFacilitator = (facilitatorUrl: string): boolean =>
  facilitatorUrl === SANDBOX_FACILITATOR;

/**
 * Whether a chain's money is play money, answering for any string without
 * throwing. The smoke commands' spending gates need an answer about an unlisted
 * chain ("not a testnet, so set SMOKE_ALLOW_MAINNET=1"), and a throw there
 * would turn a readable refusal into a stack trace.
 */
export const isTestnetChain = (network: string): boolean => TESTNET_CHAINS.has(network);

const written = (chains: ReadonlySet<string>): string => [...chains].join(", ");

/**
 * Which environment this chain makes, or a refusal. There is no default side.
 * An unlisted test network read as live would issue `csk_live_` keys, drop the
 * banner and write `test: false` onto every order and receipt, claiming on
 * somebody else's document that money moved when it did not; read as test, the
 * same mistake runs the other way. So an unlisted chain is refused, where "I
 * don't know" is still visible to a person.
 */
export function environmentOf(network: string): Environment {
  if (TESTNET_CHAINS.has(network)) {
    return "test";
  }
  if (LIVE_CHAINS.has(network)) {
    return "live";
  }
  throw new Error(
    `PAYMENT_NETWORK is ${JSON.stringify(network)}, which is on neither written list, so there is ` +
      "no honest answer to whether this deployment's money is real. The test chains are " +
      `${written(TESTNET_CHAINS)}; the live chains are ${written(LIVE_CHAINS)}. Adding one is a ` +
      "decision recorded in docs/decisions, not a value typed into an environment file",
  );
}

/**
 * What the surfaces are allowed to say, from the chain and the facilitator
 * together.
 *
 * The chain is read first and on every path, so a chain nobody wrote down is
 * refused in the sandbox exactly as it is anywhere else.
 */
export function surfaceModeOf(network: string, facilitatorUrl: string): SurfaceMode {
  const environment = environmentOf(network);
  return isSandboxFacilitator(facilitatorUrl) ? "sandbox" : environment;
}

/** Where each environment's keys work, for the words the door refuses in. */
export const SITES: Readonly<Record<Environment, string>> = {
  test: "test.agentify.ad",
  live: "agentify.ad",
};

const KEY_PREFIXES: Readonly<Record<Environment, string>> = {
  test: "csk_test_",
  live: "csk_live_",
};

/**
 * What a key issued here starts with, so that one found in a log or a paste is
 * recognisable as ours, searchable by people who scan for leaked credentials,
 * and readable as belonging to one site rather than the other.
 */
export const keyPrefixFor = (environment: Environment): string => KEY_PREFIXES[environment];

/**
 * Which environment a key was issued by, or null for a key with neither prefix.
 * Only a key that names the other environment gets the sentence naming the
 * other site, because only that key works somewhere.
 */
export function environmentOfKeyPrefix(secret: string): Environment | null {
  for (const environment of ["test", "live"] as const) {
    if (secret.startsWith(KEY_PREFIXES[environment])) {
      return environment;
    }
  }
  return null;
}

/** The attribute every surface carries, holding the mode it is rendering. */
export const SURFACE_MARKER_ATTRIBUTE = "data-agentify-surface";

/**
 * What each mode says to a reader, and nothing where there is nothing to warn
 * about. The test wording claims only what the payment was made with: a test
 * chain proves nothing about what a merchant's worker does with the order, and
 * the merchants here run their own code.
 */
export const SURFACE_WORDS: Readonly<Record<SurfaceMode, string | null>> = {
  sandbox:
    "Sandbox. No chain stands behind this stack: every payment it accepts is pretend, nothing " +
    "arrives at the address in a challenge, and no receipt it writes points at a transfer.",
  test:
    "Test environment. Payments settle on Base Sepolia with test funds, and every order and " +
    "receipt here is marked as a test. The live site is agentify.ad.",
  live: null,
};

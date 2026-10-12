/**
 * Terminal commands over every merchant and key, for what a merchant's own
 * dashboard deliberately cannot do: list them all, disable a key by its name
 * alone, and take a listing name away. None of them makes a merchant or issues
 * a key. The payout wallet has no command on purpose: a wallet change must
 * reach the gateway as the one call that announces it to the merchant, and a
 * terminal that could write it would make a change nobody was told about.
 */

import { ZodError } from "zod";
import { setServiceName } from "./app/merchants.js";
import type { Store, StoredKey, StoredMerchant } from "./ports/store.js";

const USAGE = [
  "Usage: pnpm --filter @agentify/gateway merchant <command>",
  "",
  "  list                       the merchants there are, and how many keys work",
  "  listed-as <merchant> <name>",
  "                             the name this seller is shown under in a",
  "                             discovery catalog, or --none to take it away",
  "                             and their cards off sale with it",
  "  keys <merchant>            that merchant's keys, working and revoked",
  "  disable <key>              stop one key working, touching no other",
  "",
  "A merchant and a key are named by the identifiers these commands print.",
  "None of them makes a merchant or a key: a merchant is made when a person",
  "opens the link mailed to them and presses the dashboard's one control, and",
  "keys are issued from the merchant's dashboard.",
];

/** Runs one command. The answer is the exit code. */
export async function runMerchant(
  argv: readonly string[],
  store: Store,
  now: () => number,
  say: (line: string) => void,
): Promise<number> {
  const [verb, first, ...rest] = argv;

  if (verb === "list") {
    return await listMerchants(store, say);
  }
  if (verb === "listed-as") {
    if (first === undefined) {
      return needs(say, "listed-as", "a merchant", 'listed-as mch_3f2a... "Someone\'s shop"');
    }
    const named = rest.join(" ").trim();
    return named === ""
      ? needs(say, "listed-as", "a name", 'listed-as mch_3f2a... "Someone\'s shop"')
      : await setListingName(store, now, say, first, named === NO_NAME ? null : named);
  }
  if (verb === "keys") {
    return first === undefined
      ? needs(say, "keys", "a merchant", "keys mch_3f2a...")
      : await listKeys(store, say, first);
  }
  if (verb === "disable") {
    return first === undefined
      ? needs(say, "disable", "a key", "disable mk_3f2a...")
      : await disableKey(store, now, say, first);
  }

  for (const line of USAGE) {
    say(line);
  }
  return 2;
}

function needs(say: (line: string) => void, verb: string, what: string, example: string): number {
  say(`The ${verb} command needs ${what}: ${example}`);
  return 2;
}

/**
 * An empty name would be indistinguishable from a shell that swallowed a
 * quote, so "no name" is spelled as a word nobody would be listed under.
 */
const NO_NAME = "--none";

async function setListingName(
  store: Store,
  now: () => number,
  say: (line: string) => void,
  merchantId: string,
  serviceName: string | null,
): Promise<number> {
  let named: StoredMerchant | null;
  try {
    named = await setServiceName(store, merchantId, serviceName, now());
  } catch (thrown) {
    // The name would not survive the catalog, and the catalog would not say so.
    // Nothing is written, so the merchant keeps the name they had.
    say(`That name cannot be listed: ${reasonOf(thrown)}`);
    say("Nothing was written.");
    return 1;
  }

  if (named === null) {
    say(`There is no merchant ${merchantId}, so there is nobody to list.`);
    return 1;
  }

  if (named.serviceName !== null) {
    say(`${named.id} is listed as "${named.serviceName}".`);
    return 0;
  }

  // A card sells only under a name, which the payment request uses for the
  // seller, so every card this merchant published is now off sale; say so.
  say(`${named.id} is listed under no name, so nothing about the seller goes out.`);
  say("");
  say("Every card they have published is off sale until they are listed again:");
  say("a payment request has to name the seller, and there is nobody to name.");
  return 0;
}

function reasonOf(thrown: unknown): string {
  if (thrown instanceof ZodError) {
    return thrown.issues.map((issue) => issue.message).join("; ");
  }
  return thrown instanceof Error ? thrown.message : String(thrown);
}

async function listMerchants(store: Store, say: (line: string) => void): Promise<number> {
  const merchants = await store.merchants();
  if (merchants.length === 0) {
    say("There are no merchants, so nothing can be published and no key opens anything.");
    say("A merchant is made when a person opens the link the dashboard mails them and presses");
    say("the dashboard's one control.");
    return 0;
  }

  const widest = Math.max(...merchants.map((merchant) => merchant.id.length));
  for (const merchant of merchants) {
    const keys = await store.keysOf(merchant.id);
    const working = keys.filter((key) => key.disabledAt === null).length;
    const counted = working === 1 ? "1 key works" : `${working} keys work`;
    // A listed merchant is shown under the name their products are sold under.
    // An unlisted one falls back to the row's name, which nobody typed for a
    // merchant made by registering, and says it is unlisted: that is why they
    // cannot publish.
    const [whichName, name] =
      merchant.serviceName === null
        ? ["unlisted", merchant.name]
        : ["sold as", merchant.serviceName];
    say(
      `${merchant.id.padEnd(widest)}  ${dayOf(merchant.createdAt)}  ${merchant.selling.padEnd(8)}  ${counted.padEnd(COUNT_WIDTH)}  ${whichName.padEnd(8)}  ${name}`,
    );
  }
  return 0;
}

/**
 * Wide enough for "12 keys work"; past a hundred keys the row goes ragged
 * rather than wrong.
 */
const COUNT_WIDTH = 12;

async function listKeys(
  store: Store,
  say: (line: string) => void,
  merchantId: string,
): Promise<number> {
  if ((await store.merchantById(merchantId)) === null) {
    say(`There is no merchant ${merchantId}, so there are no keys to list.`);
    return 1;
  }

  const keys = await store.keysOf(merchantId);
  if (keys.length === 0) {
    say(`${merchantId} has no keys, so nothing of theirs can be reached over the API.`);
    return 0;
  }

  const widest = Math.max(...keys.map((key) => key.id.length));
  for (const key of keys) {
    say(
      `${key.id.padEnd(widest)}  ${dayOf(key.createdAt)}  ${standingOf(key)}  ${lastCallOf(key)}  ${key.label}`,
    );
  }
  return 0;
}

async function disableKey(
  store: Store,
  now: () => number,
  say: (line: string) => void,
  keyId: string,
): Promise<number> {
  const key = await store.disableKey(keyId, now());
  if (key === null) {
    say(`There is no key ${keyId}, so there is nothing to disable.`);
    return 1;
  }

  // Somebody revoking a leaked key needs to know whether they have just locked
  // the merchant out.
  const others = (await store.keysOf(key.merchantId)).filter(
    (other) => other.id !== key.id && other.disabledAt === null,
  );
  say(`${key.id} ("${key.label}") no longer opens anything, from ${stampOf(key.disabledAt)}.`);
  say(
    others.length === 0
      ? `${key.merchantId} now has no working key, so nothing of theirs can be reached over the API.`
      : others.length === 1
        ? `${key.merchantId} has 1 other key and it still works.`
        : `${key.merchantId} has ${others.length} other keys and they still work.`,
  );
  return 0;
}

/** Where a key stands, in a word wide enough for both. */
function standingOf(key: StoredKey): string {
  return key.disabledAt === null ? "works  " : `revoked ${dayOf(key.disabledAt)}`;
}

/**
 * "No calls recorded" means no record, not no calls: a key whose calls were
 * never recorded reads the same. A day rather than an instant, because the
 * mark is written every few minutes at best.
 */
function lastCallOf(key: StoredKey): string {
  return key.lastUsedAt === null ? "no calls recorded" : `called ${dayOf(key.lastUsedAt)}`;
}

const dayOf = (instant: number): string => new Date(instant).toISOString().slice(0, 10);

const stampOf = (instant: number | null): string =>
  instant === null ? "an instant nothing recorded" : new Date(instant).toISOString();

/**
 * Making a merchant, naming what their products are sold under, and issuing
 * keys to one.
 *
 * It is one small module rather than a copy per caller because there are three
 * and they must not drift: the seed the sandbox comes up with, the gateway's
 * application that a merchant's code and their dashboard both call, and the
 * test harness. A second way of
 * turning a secret into a digest would be a key that works in one of them and
 * not the others, and the failure would look like a wrong key rather than like
 * two hashes.
 *
 * Two things here are decisions rather than conveniences.
 *
 * The secret is generated and never taken from a caller. A key somebody chooses
 * is a key somebody reuses, and this one is compared against nothing — a
 * request is resolved by looking its digest up — so there is no length rule
 * left to enforce and nothing to enforce it at. Generating is what makes that
 * safe rather than merely tidy.
 *
 * And what is written down is the digest. The secret is handed back once, to
 * whoever asked for it, and this module keeps nothing: a copy of the table is
 * not a set of keys anybody can spend, and nobody — us included — can read a
 * merchant's key back out afterwards. What that costs is that a key which is
 * lost is gone, and the answer to a lost key is a new one and then disabling
 * the old, which is exactly what keys being rows is for.
 */

import { createHash, randomBytes } from "node:crypto";
import { assertNever, type Environment, keyPrefixFor, type SurfaceMode } from "@agentify/core";
import {
  checksummedAddressOf,
  EvmAddressSchema,
  SellerSiteSchema,
  ServiceNameSchema,
} from "@nuanu-ai/agentify-contracts";
import type { Ids } from "../ports/clock.js";
import type { Store, StoredKey, StoredMerchant } from "../ports/store.js";

/**
 * How much randomness a key carries. Thirty-two bytes is more than anybody
 * will exhaust and is not a number anybody should have to think about again.
 */
const KEY_BYTES = 32;

/**
 * A fresh key, in the only form its owner will ever see it.
 *
 * The prefix carries the environment because that is the one thing about a key
 * that a person holding it can read without asking us, and it is what lets the
 * door tell somebody their key works — on the other site — instead of handing
 * them a bare 401 with nothing wrong with the key.
 */
export function newKeySecret(environment: Environment): string {
  return `${keyPrefixFor(environment)}${randomBytes(KEY_BYTES).toString("base64url")}`;
}

/**
 * The digest a key is stored and looked up under: SHA-256, in lower-case hex.
 *
 * Hex rather than the raw bytes because it goes into a text column and comes
 * back out of one, and a single spelling of it is the whole point — the door
 * and the command that issued the key have to produce the same string from the
 * same secret or the key simply does not work.
 */
export function keyDigest(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** A key as it comes back from being issued: the row, and the secret, once. */
export interface IssuedKey {
  readonly key: StoredKey;
  /** The only time this is ever readable. Nothing keeps it. */
  readonly secret: string;
}

/**
 * Sets or clears the name a merchant is listed under in a discovery catalog,
 * and hands back the merchant as they now stand. Null where there is no such
 * merchant.
 *
 * The check is here rather than in the store, and it throws rather than
 * answering, because there is exactly one wrong answer available: writing a
 * name the catalog will not carry. The catalog drops what it cannot render and
 * tells nobody, so a merchant would end up trading under a word they did not
 * choose with nothing anywhere to say so. Refusing loudly at the one place a
 * name is written is the only version of this that somebody reads.
 */
export async function setServiceName(
  store: Store,
  merchantId: string,
  serviceName: string | null,
  at: number,
): Promise<StoredMerchant | null> {
  if (serviceName !== null) {
    // Throws with the schema's own words, which name the rule and the number.
    ServiceNameSchema.parse(serviceName);
  }
  return store.setServiceName(merchantId, serviceName, at);
}

/**
 * Sets the site of a merchant's own shop, and hands back the merchant as they
 * now stand. Null where there is no such merchant.
 *
 * Checked here and thrown on for the reason the name is: this is the one place
 * a site is written, and an address an agent is sent to that is not the bare
 * https origin of a shop would carry whatever the merchant typed after the
 * host to every agent reading their cards (ADR-0034).
 */
export async function setSellerSite(
  store: Store,
  merchantId: string,
  sellerSite: string,
  at: number,
): Promise<StoredMerchant | null> {
  // Throws with the schema's own words, which say the form the site takes.
  SellerSiteSchema.parse(sellerSite);
  return store.setSellerSite(merchantId, sellerSite, at);
}

/**
 * An address a merchant may be paid at, in the one spelling anything here holds.
 *
 * Two things happen here and both are the reason this is a function rather than
 * a parse at each caller.
 *
 * The address is checked, and it throws rather than answering, for the reason
 * the listing name beside it does and with more on it: the one wrong answer
 * available is writing down an address that is not the merchant's. A mistyped
 * address is not a malformed one — it is another perfectly good address
 * belonging to somebody else — so nothing downstream will ever notice, and what
 * happens instead is that every sale the merchant makes from then on is paid to
 * a stranger, irreversibly. The capitals a wallet writes are the only warning
 * anybody gets, and this is where it is read.
 *
 * And the address is written out in one spelling before it is stored. An
 * address has two and the store holds one, so that a comparison somewhere else
 * cannot come out false for two spellings of one address — which is what a
 * retry of a waiting change is recognised by — and so that what a merchant reads
 * back does not depend on which spelling they last sent. The one it holds is the
 * wallet's own — the mixed-case checksummed form — because that is the string
 * the merchant copied and the string they will compare against when they look
 * at the settings screen a month from now.
 */
export function payoutWalletFrom(payoutWallet: string): string {
  // Throws with the schema's own words, which say what is wrong with the
  // address and what the two spellings of one are.
  return checksummedAddressOf(EvmAddressSchema.parse(payoutWallet));
}

/**
 * Sets the address one merchant's sales are paid into at once, with nothing
 * waiting, and hands back the merchant as they now stand. Null where there is
 * no such merchant.
 *
 * This is the write with no wait and no message, and its callers are the
 * harnesses that seed a merchant ready to sell — the gateway's own test harness
 * and the slice's, which stands one merchant up with the address it was
 * configured with. Nothing a merchant or an operator reaches calls it: a
 * merchant's change goes through `Gateway#setPayoutWallet`, which waits and
 * announces where the money is real (ADR-0019), and no terminal command writes
 * a wallet at all.
 *
 * A row that moved between the read and the write is read again and written
 * over rather than refused, because a seed has nobody to tell and nothing to
 * race but itself.
 */
export async function setPayoutWallet(
  store: Store,
  merchantId: string,
  payoutWallet: string,
  at: number,
): Promise<StoredMerchant | null> {
  const address = payoutWalletFrom(payoutWallet);
  for (;;) {
    const merchant = await store.merchantById(merchantId);
    if (merchant === null) {
      return null;
    }
    const written = await store.setPayoutWallet(
      merchantId,
      merchant.payoutWallet,
      { address, pending: null },
      at,
    );
    if (written !== "moved") {
      return written;
    }
  }
}

/** What the protected operator grant found and whether this call wrote it. */
export interface LiveApprovalGrant {
  readonly merchant: StoredMerchant;
  readonly changed: boolean;
}

/**
 * Admits one merchant to live publication, once.
 *
 * This is an application function rather than an HTTP capability. The caller
 * is the protected operator command, which resolves a dashboard identity before
 * it gets here; the gateway stores no address and exposes no merchant-key route
 * that can make this decision. Null means the exact merchant is absent, while
 * `changed:false` is the idempotent answer for one already admitted.
 */
export async function grantLiveApproval(
  store: Store,
  merchantId: string,
  at: number,
): Promise<LiveApprovalGrant | null> {
  return store.grantLiveApproval(merchantId, at);
}

/**
 * Issues one key for a merchant's own code and hands back the secret, once.
 *
 * The caller is expected to have found the merchant first, so that "there is no
 * such merchant" is a sentence somebody reads rather than a foreign key
 * violation. This does not check again: two commands racing over a merchant
 * somebody is deleting is not a case worth a round trip, and the database
 * refuses it either way.
 */
export async function issueKey(
  store: Store,
  ids: Ids,
  merchantId: string,
  label: string,
  at: number,
  environment: Environment,
): Promise<IssuedKey> {
  const secret = newKeySecret(environment);
  const key = await store.addKey(
    { id: ids("mk"), merchantId, label, digest: keyDigest(secret) },
    at,
  );
  return { key, secret };
}

/**
 * What a merchant made by registering is called in the merchant table.
 *
 * That column is the name a person reads at a terminal, beside the identifier
 * and the count of working keys, and it is not the name buyers read — the two
 * are different fields answering to different rules, and only the other one
 * ever leaves us. Somebody registering types neither, so this one has to come
 * from somewhere.
 *
 * It says how the merchant came to exist, because that is the only true thing
 * there is to say about a row nobody named. The alternatives were worse. Empty,
 * it is a blank column somebody has to work out the meaning of. The identifier
 * again, and the row carries it twice. Anything that reads like a name is a
 * name somebody will go looking for the owner of, and there is none.
 */
export const REGISTERED_MERCHANT_NAME = "made in the dashboard";

/**
 * Makes a merchant under a generated identifier. Null where that identifier is
 * taken, which a generated one never is.
 *
 * Nothing else is made with them. The dashboard that asked writes the merchant
 * onto the account of the person who pressed for it, and that account is the
 * way in; a merchant has no keys at all until they ask for one, and their list
 * of keys is empty on the first visit — which is the truth about a merchant who
 * has written no code yet.
 *
 * No name for buyers is written, because registering does not ask for one. It
 * is chosen afterwards through `setServiceName`, and what stands between here
 * and there is that a merchant listed under nothing publishes nothing: the
 * refusal is at the publish, where a merchant is actually about to be shown to
 * strangers, rather than here, where they have nothing to show yet.
 */
export async function registerMerchant(
  store: Store,
  ids: Ids,
  at: number,
): Promise<StoredMerchant | null> {
  return store.addMerchant({ id: ids("mch"), name: REGISTERED_MERCHANT_NAME }, at);
}

/**
 * The merchant everything already in a database belongs to.
 *
 * It is a fixed identifier rather than a generated one because two things that
 * cannot see each other have to name the same merchant: the migration, which
 * writes this row and assigns every card, order and receipt that predates
 * merchants to it, and the seed below, which hangs the sandbox's key on it.
 *
 * The name is what somebody reads in a list at a terminal and nothing else uses
 * it. A sandbox brought up from nothing gets this row too, from the same
 * migration, which is what makes the two databases the same shape.
 */
export const SEEDED_MERCHANT = { id: "the_merchant", name: "The pilot merchant" } as const;

/**
 * What a seeded merchant is listed as, which is different on each of the three
 * surfaces and is nothing at all on one of them.
 *
 * Two gateways seed: the laptop's stack, on the sandbox, and the slice's
 * in-process gateway, whose smoke runs on a test chain and may be pointed at a
 * live one. A deployed channel seeds nothing (ADR-0014), so none of these names
 * reaches the catalog of either site through a seed.
 *
 * It says what it is out loud on purpose: this name travels to a catalog, and
 * a listing that reads like a real seller is the one thing a sandbox must not
 * look like. `Agentify sandbox` is right for the laptop, wrong on a test
 * chain, and wrong in a way that reaches strangers on a live one.
 *
 * A live chain is seeded with no name. A merchant with no name is off sale, so
 * a live gateway nobody has named sells nothing, and the name it eventually
 * trades under is typed by a person rather than inherited from a constant
 * written for a sandbox.
 */
export function seededServiceNameFor(mode: SurfaceMode): string | null {
  switch (mode) {
    case "sandbox":
      return "Agentify sandbox";
    case "test":
      return "Agentify test site";
    case "live":
      return null;
    default: {
      const unnamed: never = mode;
      return assertNever(unnamed, "seededServiceNameFor");
    }
  }
}

/** What seeding the sandbox's key came to, in a word somebody can print. */
export type SeedOutcome =
  /**
   * There was no such key and now there is; here it is, the way it was given.
   *
   * `listedAs` is the name this run listed the merchant under, and null where
   * it left the listing as it found it — because there was already a name on
   * it, and that name is somebody's. It is carried out rather than left to be
   * inferred because listing a seller is the part of this that other people can
   * see: the name travels to a catalogue, and a start-up log that reported the
   * key and not the listing would be quiet about the half that goes outside.
   */
  | { readonly kind: "issued"; readonly merchantId: string; readonly listedAs: string | null }
  /** The key is already there and works. Nothing was written. */
  | { readonly kind: "already_there" }
  /** The key is there and somebody disabled it. It is left that way. */
  | { readonly kind: "disabled" };

/**
 * Makes sure the sandbox's merchant and its one key exist, and says what it
 * found.
 *
 * This is what lets `docker compose up` sell with no manual step: the key in
 * `compose.yaml` is handed to the merchant process, and this puts the matching
 * row in the database so that the door recognises it. Run
 * again — a restart, a second replica — and nothing in the database changes:
 * the merchant row is insert-if-absent, and everything after it hangs off the
 * key lookup coming back empty. The listing name included, for the reason given
 * where it is written: on a database that already has the key, a merchant with
 * no listing name is a merchant somebody un-listed on purpose.
 *
 * A key that is there but disabled is left disabled and said out loud. Bringing
 * it back would make revocation a thing a restart undoes, and a key somebody
 * revoked deliberately is not a key this should quietly re-issue; the way back
 * is to seed a different one.
 *
 * The merchant row is written here as well as by the migration, and both are
 * needed: the migration is the only thing that can assign existing rows to it,
 * and this is the only thing that exists for a store with no migrations behind
 * it at all — which is every test and the end-to-end harness.
 *
 * Two processes starting at the same instant both find no key and both write
 * one, and the digest is unique — so one of them is refused by the database.
 * That is caught rather than thrown on, and the answer is the same one a
 * sequential second run gets, because it is the same fact: the key is there.
 * Left to propagate, it would take the losing process down at start-up with an
 * error about the database being unreachable, which is the one thing that had
 * not happened.
 */
export async function seedSandboxKey(
  store: Store,
  ids: Ids,
  secret: string,
  at: number,
  mode: SurfaceMode,
): Promise<SeedOutcome> {
  const digest = keyDigest(secret);
  await store.addMerchant(SEEDED_MERCHANT, at);

  // Looked up in whatever state it is in, not through the door's own lookup:
  // the door answers nothing for a disabled key, and issuing a second key with
  // a digest already taken is what that silence would lead to here.
  const found = await store.keyByDigest(digest);
  if (found !== null) {
    return standingOf(found.disabledAt);
  }

  try {
    await store.addKey(
      {
        id: ids("mk"),
        merchantId: SEEDED_MERCHANT.id,
        label: "the sandbox key from the compose file",
        // One of the merchant's own: it is handed to a merchant process out of
        // a configuration file, which is exactly what a merchant does with a
        // key of theirs, and it is on the list they would revoke it from.
        digest,
      },
      at,
    );
  } catch (thrown) {
    // Somebody wrote it between the read above and this line, or the write
    // failed for a reason that has nothing to do with a race. The two are told
    // apart by asking again: a key that is there now is the first answer,
    // whoever wrote it, and anything else is a failure this cannot repair and
    // must not swallow.
    const raced = await store.keyByDigest(digest);
    if (raced === null) {
      throw thrown;
    }
    return standingOf(raced.disabledAt);
  }

  // A sandbox that comes up undiscoverable is a sandbox that cannot show the
  // thing it exists to show: without a listing name the challenge carries no
  // declaration at all, and a catalogue has nothing to read. Nobody runs a
  // command to fix that on a database that came up from nothing, so the run
  // that issues the key writes the name too.
  //
  // Only that run, and this is the whole of why it is down here rather than
  // above the lookup. A database that already has the key has been up before,
  // and a merchant on it with no listing name is not a default nobody has got
  // to yet — it is `merchant listed-as the_merchant --none`, which is how
  // somebody takes the sandbox out of a catalogue. Writing the name back on the
  // next boot would make that command something a restart undoes, silently, and
  // the operator would find the sandbox listed again with nothing anywhere
  // saying who listed it. A name that is already there is left alone for the
  // matching reason: it is somebody's, and this is only a default.
  const merchant = await store.merchantById(SEEDED_MERCHANT.id);
  const wanted = seededServiceNameFor(mode);
  const listedAs = merchant !== null && merchant.serviceName === null ? wanted : null;
  if (listedAs !== null) {
    await setServiceName(store, SEEDED_MERCHANT.id, listedAs, at);
  }

  return { kind: "issued", merchantId: SEEDED_MERCHANT.id, listedAs };
}

/** Where a key that is already there stands, in the word the caller prints. */
function standingOf(disabledAt: number | null): SeedOutcome {
  return disabledAt === null ? { kind: "already_there" } : { kind: "disabled" };
}

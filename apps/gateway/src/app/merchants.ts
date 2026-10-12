/**
 * Making a merchant, naming what their products are sold under, and issuing
 * keys to one. The sandbox seed, the gateway and the test harness all go
 * through here, so there is one way of turning a secret into a digest.
 *
 * A key's secret is always generated, never taken from a caller, and only its
 * digest is stored: the secret is handed back once and cannot be read back
 * out, so a lost key is replaced, not recovered.
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

const KEY_BYTES = 32;

/**
 * A fresh key. Its prefix names the environment, which lets the door tell
 * somebody their key belongs to the other site instead of a bare 401.
 */
export function newKeySecret(environment: Environment): string {
  return `${keyPrefixFor(environment)}${randomBytes(KEY_BYTES).toString("base64url")}`;
}

/**
 * The digest a key is stored and looked up under: SHA-256, in lower-case hex.
 * Every issuer and the door must produce exactly this spelling, or the key
 * does not work.
 */
export function keyDigest(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export interface IssuedKey {
  readonly key: StoredKey;
  /** The only time this is ever readable. Nothing keeps it. */
  readonly secret: string;
}

/**
 * Sets or clears the name a merchant is listed under in a discovery catalog.
 * Null where there is no such merchant. Throws on a name the catalog would not
 * carry: a catalog silently drops what it cannot render, so the refusal has to
 * be here.
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
 * Sets the site of a merchant's own shop. Null where there is no such
 * merchant. Throws on anything but a bare https origin, since whatever follows
 * the host would reach every agent reading the merchant's cards.
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
 * A payout address, checked and written in its checksummed spelling.
 *
 * A mistyped address is usually another valid address belonging to somebody
 * else, and every later sale would be paid to it irreversibly; the checksum's
 * capitals are the only warning, so a wrong checksum throws here. Storing one
 * spelling keeps comparisons (such as recognising a retried pending change)
 * from failing on two spellings of one address.
 */
export function payoutWalletFrom(payoutWallet: string): string {
  // Throws with the schema's own words, which say what is wrong with the
  // address and what the two spellings of one are.
  return checksummedAddressOf(EvmAddressSchema.parse(payoutWallet));
}

/**
 * Sets a merchant's payout address at once, with no wait and no announcement.
 * Null where there is no such merchant. Only test and seed harnesses may call
 * this: a merchant's own change goes through `Gateway#setPayoutWallet`, which
 * waits and announces where the money is real.
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

export interface LiveApprovalGrant {
  readonly merchant: StoredMerchant;
  readonly changed: boolean;
}

/**
 * Admits one merchant to live publication. Only the protected operator command
 * calls this; no merchant-key route can make this decision. Null means no such
 * merchant; `changed: false` means already admitted.
 */
export async function grantLiveApproval(
  store: Store,
  merchantId: string,
  at: number,
): Promise<LiveApprovalGrant | null> {
  return store.grantLiveApproval(merchantId, at);
}

/**
 * Issues one key for a merchant and hands back the secret, once. The caller
 * must have found the merchant first; this does not check again.
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
 * The operator-facing name of a merchant made by registering, which is not the
 * name buyers see. It says how the merchant came to exist rather than reading
 * like a name somebody chose.
 */
export const REGISTERED_MERCHANT_NAME = "made in the dashboard";

/**
 * Makes a merchant under a generated identifier, with no keys and no name for
 * buyers. Null where the identifier is taken. A merchant without a listing
 * name is refused at publishing.
 */
export async function registerMerchant(
  store: Store,
  ids: Ids,
  at: number,
): Promise<StoredMerchant | null> {
  return store.addMerchant({ id: ids("mch"), name: REGISTERED_MERCHANT_NAME }, at);
}

/**
 * The merchant that rows without one belong to. Its identifier is fixed because
 * a migration writes the same row and assigns those rows to it, and the
 * sandbox seed hangs its key on it.
 */
export const SEEDED_MERCHANT = { id: "the_merchant", name: "The pilot merchant" } as const;

/**
 * What a seeded merchant is listed as. The name reaches a catalog, so it must
 * not read like a real seller. On a live chain there is none, which keeps a
 * seeded merchant off sale until a person names it.
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

export type SeedOutcome =
  /**
   * The key was issued. `listedAs` is the name this run listed the merchant
   * under, null where it left an existing listing alone; it is reported
   * because the listing is what reaches a catalog.
   */
  | { readonly kind: "issued"; readonly merchantId: string; readonly listedAs: string | null }
  /** The key is already there and works. Nothing was written. */
  | { readonly kind: "already_there" }
  /** The key is there and somebody disabled it. It is left that way. */
  | { readonly kind: "disabled" };

/**
 * Makes sure the sandbox's merchant and its one key (the one in `compose.yaml`)
 * exist, and says what it found. Idempotent across restarts and replicas. A
 * key somebody disabled stays disabled, so a restart never undoes a
 * revocation. The merchant row is written here as well as by the migration
 * because tests run on stores with no migrations.
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

  // Not the door's lookup, which answers nothing for a disabled key and would
  // lead to issuing a second key under a digest already taken.
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
        digest,
      },
      at,
    );
  } catch (thrown) {
    // Two processes starting together both find no key and one loses on the
    // unique digest. Asking again tells that race apart from a real failure,
    // which must not be swallowed.
    const raced = await store.keyByDigest(digest);
    if (raced === null) {
      throw thrown;
    }
    return standingOf(raced.disabledAt);
  }

  // Only the run that issues the key writes the listing name. On a database
  // that already has the key, a missing name means somebody un-listed the
  // sandbox on purpose (`merchant listed-as the_merchant --none`), and a
  // restart must not undo that; an existing name is likewise left alone.
  const merchant = await store.merchantById(SEEDED_MERCHANT.id);
  const wanted = seededServiceNameFor(mode);
  const listedAs = merchant !== null && merchant.serviceName === null ? wanted : null;
  if (listedAs !== null) {
    await setServiceName(store, SEEDED_MERCHANT.id, listedAs, at);
  }

  return { kind: "issued", merchantId: SEEDED_MERCHANT.id, listedAs };
}

function standingOf(disabledAt: number | null): SeedOutcome {
  return disabledAt === null ? { kind: "already_there" } : { kind: "disabled" };
}

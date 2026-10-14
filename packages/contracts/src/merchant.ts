/**
 * What a merchant says about themselves: the name their products are sold
 * under, the wallet their share of each sale arrives at, and their keys.
 *
 * A key's secret appears in one document only, the answer to the call that
 * made the key; every other shape here refuses it, and Agentify keeps only a
 * digest. A revoked key stays in the list with the moment it was revoked.
 */

import { z } from "zod";
import { SellerSchema, ServiceNameSchema } from "./card.js";
import { EvmAddressSchema } from "./evm-address.js";
import { IdentifierSchema, TimestampSchema } from "./primitives.js";
import { SellerSiteSchema } from "./seller-site.js";

/**
 * What a merchant calls one of their keys: not empty and not padded with
 * spaces, so that two labels that look the same are the same. Any alphabet is
 * allowed, since a label never leaves the merchant's own screens, and so is a
 * character that shows nothing: a label is only read, never matched on.
 */
const KeyLabelSchema = z
  .string()
  .regex(/^\S(?:[\s\S]*\S)?$/u, "a label must not be empty or padded with spaces");

/**
 * The longest label a key is issued with. On the live deployment the message
 * that tells a merchant of a new key, or of a wallet change made with one,
 * names the key by its label.
 */
const LONGEST_KEY_LABEL = 100;

/**
 * A label as a new key is issued with it: one line, at most
 * {@link LONGEST_KEY_LABEL} characters. Only the request carries the bound;
 * keys already held are read back under whatever they were named, so one old
 * row cannot hide the whole list.
 */
const IssuedKeyLabelSchema = KeyLabelSchema.max(
  LONGEST_KEY_LABEL,
  `a label is at most ${LONGEST_KEY_LABEL} characters, the one line a key is known by`,
).regex(
  // Code-point ranges rather than a Unicode property escape, because the
  // pattern is published in the JSON Schema and not every validator in another
  // language knows property escapes.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  /^[^\u0000-\u001F\u007F-\u009F\u2028\u2029]*$/u,
  "a label is one line: it cannot carry a line break, a tab or another control character",
);

/**
 * The key itself. It travels as a bearer token, and the reader on the other
 * side takes everything up to the first space, so a secret with whitespace in
 * it would arrive as a prefix of itself. Its length and prefix are left to the
 * gateway that generates it.
 */
const KeySecretSchema = z
  .string()
  .regex(/^\S+$/, "a key travels as a bearer token, so it carries no whitespace and is not empty");

/**
 * One key a merchant holds, as they read it. It has no field for the secret,
 * which is shown once by the call that made the key and never again.
 */
export const MerchantKeySchema = z
  .strictObject({
    id: IdentifierSchema,

    label: KeyLabelSchema,

    created_at: TimestampSchema,

    /**
     * The last call this key was seen on, behind the truth by up to a few
     * minutes, or null where none is recorded. Null is the absence of a record,
     * not of calls: a key made before the gateway recorded this field carries
     * the same null as a key nobody ever used.
     */
    last_used_at: TimestampSchema.nullable(),

    /**
     * When this key was revoked, and null while it still works. Required and
     * nullable rather than optional, so that a screen never has to guess
     * whether an absent field means "works" or "nobody wrote it down".
     */
    disabled_at: TimestampSchema.nullable(),
  })
  .meta({
    description:
      "One key a merchant opens the door with, as they read it: what they called it, when it was made, when a call was last seen on it, and when it was revoked. A null disabled_at means the key still works; the field is always present, because an absent one is a silence a reader cannot tell from an oversight. The key itself is not in this document and never will be — what is kept is a digest of it, so nothing here or anywhere else can show a merchant their key a second time. last_used_at is not the instant of the last call and is not offered as one: it is refreshed at most once every few minutes per key, so a key under constant use carries a time that far behind, which is the price of not writing to the database on every call made with it. Null there means no call has been recorded against this key, which is not the same as no call having been made: a key made before this gateway began recording carries that same null, and nothing in this document tells such a key from one nobody has ever used. Nor is it a ledger of calls or an exact one: a mark that could not be written is swallowed rather than refusing the call it belonged to, so this is what was recorded and not everything that happened.",
  });

/**
 * The keys one merchant made for their own code, and the one this call was
 * made with.
 *
 * `this_call` is always one of the keys listed. A merchant cannot disable the
 * key their own call was made with, and without this field a screen would
 * offer a button the gateway refuses.
 */
export const MerchantKeyListSchema = z
  .strictObject({
    /** The keys this merchant made for their own code, revoked ones included. */
    keys: z.array(MerchantKeySchema),

    /** The key the request carrying this answer was made with. */
    this_call: IdentifierSchema,
  })
  .meta({
    description:
      "The keys one merchant made for their own code, working and revoked together, and the identifier of the key this very call was made with. That last field is here because a merchant cannot disable the key they are holding: without it a screen would offer a button the gateway refuses. It is always one of the keys listed, since every key is one the merchant issued. This document does not say whether it is the whole list either — paging is not designed, and the absence of a field about it is not a promise that there is no more.",
  });

/** What a merchant sends to have a key made. */
export const IssueKeyRequestSchema = z
  .strictObject({
    label: IssuedKeyLabelSchema,
  })
  .meta({
    description:
      "What a merchant asks for when they want another key: the name they will know it by, and nothing else. The name is one line of at most 100 characters, not empty and not padded with spaces; on the live deployment it is also how the message telling the merchant of the new key names it. There is nowhere here to put a secret, because a key is generated rather than chosen — one somebody picks is one somebody reuses somewhere else.",
  });

/**
 * A key that has just been made: the row, and the secret, once. The secret is
 * what a worker needs; the row is what tells the merchant later which key to
 * disable.
 */
export const IssuedKeySchema = z
  .strictObject({
    key: MerchantKeySchema,
    /** Readable only now. Agentify keeps a digest, never the secret. */
    secret: KeySecretSchema,
  })
  .meta({
    description:
      "A key as it comes back from being issued: the row a merchant will see in their list from now on, and the key itself. It carries the key once, and it is the one answer in this contract that carries one, because what is written down on our side is a digest. A key that is lost is replaced by a new one rather than read back.",
  });

/**
 * A key that has been revoked, as it now stands. Revoking an already revoked
 * key answers the same way and keeps the first moment.
 */
export const DisabledKeySchema = z
  .strictObject({
    key: MerchantKeySchema,
  })
  .meta({
    description:
      "The key that was just revoked, with the instant it stopped working on it, so a merchant reads back what happened rather than taking the call's word for it. Revoking a key that was already revoked answers this same way and keeps the first instant, because that is the true one and a retry after a dropped connection must not rewrite it.",
  });

/**
 * What a merchant's products are sold under, as the merchant reads it back.
 *
 * Null means nobody has chosen a name, which is where every merchant starts;
 * the field is always present, so it cannot be mistaken for a dropped one.
 * The name is held to the discovery catalog's rule, at most thirty-two
 * characters of printable ASCII, because the catalog drops what it cannot
 * render without telling anybody.
 */
export const SellerNameSchema = z
  .strictObject({
    /**
     * What buyers read beside this merchant's products, or null. It is read
     * back by the rule an agent's `seller` is read by; the plain-text rule is
     * applied when the name is written.
     */
    seller_name: SellerSchema.shape.name,
    /**
     * The https address of the merchant's own shop, where an agent takes what
     * an order cannot answer, or null where none was given.
     */
    seller_site: SellerSiteSchema.nullable(),
  })
  .meta({
    description:
      "The name a merchant's products are sold under: what a discovery catalog lists them under and what a buyer's agent is shown beside the price. Null means nobody has chosen one, which is where every merchant starts. The field is always present rather than left out when there is no name: an absent field would be indistinguishable from a client that dropped it. What a name may be is the catalog's rule rather than ours — at most 32 characters of printable ASCII — because a name outside it is dropped there in silence, so it is refused here where somebody is told. A merchant with no name cannot publish a card: a card published without one reaches a buyer's agent inside a payment request that names no seller at all. seller_site is the https address of the merchant's own shop, which every agent reads beside the name on their cards and orders as where to take what an order cannot answer; null means none was given.",
  });

/**
 * What a merchant sends to change what their products are sold under, their
 * shop's site, or both. A field left out stays as it was, and at least one
 * must be there.
 *
 * Null is refused for either, with a sentence saying why. A merchant goes from
 * no name to a name and from one name to another, never back to none: a
 * payment request names the seller, so every published card would come off
 * sale. A merchant who wants to stop selling pauses instead.
 */
export const SellerNameRequestSchema = z
  .strictObject({
    /**
     * What buyers are to read beside this merchant's products, where it is
     * changing, held to `ServiceNameSchema`.
     */
    seller_name: z
      .string({
        // A field holding null is a client with a misunderstanding, and only
        // that gets this sentence.
        error: (issue) =>
          issue.input === undefined
            ? undefined
            : "a seller name cannot be taken away, only changed: a merchant who wants to stop being listed pauses their selling, which leaves their cards where they can put them back on sale",
      })
      .pipe(ServiceNameSchema)
      .optional(),
    /**
     * The https address of the merchant's own shop, where it is changing. Like
     * the name it is changed and never taken away: an agent holding an order
     * that named a site has been told where to go.
     */
    seller_site: z
      .string({
        error: (issue) =>
          issue.input === undefined
            ? undefined
            : "a seller's site cannot be taken away, only changed: send the address it has moved to",
      })
      .pipe(SellerSiteSchema)
      .optional(),
  })
  .refine((asked) => asked.seller_name !== undefined || asked.seller_site !== undefined, {
    // A client that dropped both fields has a bug, and is told what this call
    // takes rather than anything about taking a name away.
    message:
      "a request names seller_name, seller_site or both: one that names neither changes nothing",
  })
  .meta({
    description:
      "What a merchant sends to change the name their products are sold under, the address of their shop's own site, or both; a field left out stays as it was, and one of the two has to be there. The name is held to the catalog's rule rather than ours — at most 32 characters of printable ASCII — and is plain text. The site is an https origin and nothing after it, such as https://shop.example. Null is refused for either. A merchant goes from no name to a name and from one name to another, never back to none, because a payment request names the seller and there would be nobody to name: every card they have published would come off sale, which is an end to their selling arriving under the name of editing a setting. Somebody reaching for null wants one of two other things: a different name, which is this call with a different value, or an end to selling, which is the pause. A site is changed the same way and never taken away.",
  });

/**
 * A change of the payout wallet that has been asked for and announced and has
 * not taken effect yet. On the live deployment a replacement is announced to
 * every account of the merchant and takes effect forty-eight hours later,
 * since the payout address is the one setting whose change redirects money.
 */
export const PendingPayoutWalletSchema = z
  .strictObject({
    /** The wallet the merchant's share will arrive at once the wait is over. */
    payout_wallet: EvmAddressSchema,
    /** The moment it replaces the wallet in force now. */
    takes_effect_at: TimestampSchema,
  })
  .meta({
    description:
      "A replacement wallet that has been asked for and announced and has not taken effect yet. payout_wallet is the wallet the merchant's share of sales will arrive at from takes_effect_at on, in the mixed-case spelling a wallet shows. Until that moment every payment request still names the payout contract of the wallet in force now, and from it every payment request names the payout contract of this one; money already paid into the old contract is still paid out to the old wallet, since nobody can change whom a payout contract pays. The change takes effect then only if it is still the one waiting: asking for the wallet in force now cancels it, and asking for a different address replaces it and starts the wait again.",
  });

/**
 * The wallet a merchant's share of their sales arrives at, as the merchant
 * reads it back.
 *
 * A buyer's agent never pays this address. It pays the merchant's payout
 * contract for it, a 0xSplits split with no owner, which keeps what it is paid
 * until somebody sends a payout and then sends 99.9% of it to this wallet and
 * 0.1% to Agentify; nobody, Agentify included, can change those recipients or
 * shares or send the money anywhere else. Null means nobody has set one, which
 * is where every merchant starts. The address comes back in the checksummed
 * spelling a wallet shows, whichever accepted spelling was sent, so a merchant
 * can compare it by eye with their wallet.
 *
 * `pending` is a replacement waiting to take effect, or null. A merchant who
 * asked for a new address on the live deployment reads the old one back for
 * forty-eight hours, and `pending` is what tells them the change was not lost.
 *
 * Code that parses this answer with a release of this package that does not
 * know `pending` refuses it until the package is upgraded.
 */
export const PayoutWalletSchema = z
  .strictObject({
    /** Where this merchant's share of their sales arrives now, or nothing at all. */
    payout_wallet: EvmAddressSchema.nullable(),
    /** A replacement that has been announced and is waiting, or nothing. */
    pending: PendingPayoutWalletSchema.nullable(),
  })
  .meta({
    description:
      "The wallet a merchant's share of their sales arrives at, and any change of it that is waiting. A buyer's agent never pays payout_wallet, and it is never the payTo of a payment request. Every payment request made for this merchant's products names, as payTo, the merchant's payout contract for this wallet: a split contract of the 0xSplits protocol with no owner, which keeps what buyers pay into it until somebody sends a payout, as anybody may at any time, the merchant included, and then sends 99.9% of the accumulated balance to payout_wallet and 0.1% to Agentify, each share rounded down to the smallest unit of USDC. Nobody, Agentify included, can change those two recipients or their shares or send the money anywhere else. So what arrives at payout_wallet is one transfer per payout from the 0xSplits warehouse, the shared contract the payout contracts pay their shares through, covering everything paid in since the payout before, and never a buyer's own transfer. Neither the payout contract nor the commission on an order is named here, and there is no exact commission per order to name: a payout divides the accumulated balance, not each payment. Null means nobody has set one, which is where every merchant starts; the field is always present rather than left out, because an absent field is indistinguishable from a client that dropped it. The address comes back in the mixed-case spelling a wallet shows, whichever of the two accepted spellings was sent — so what a merchant reads back on a screen is character for character what they copied out of their wallet. On a deployment that settles on a real chain a merchant with no wallet here cannot publish a card, because a payout contract is made for a wallet, and without one the money from that card's sales would have nowhere to go. pending is a replacement that has been asked for and has not taken effect: on the live deployment a merchant who already has a wallet and asks for a different one is told of it by message, and the new address takes effect forty-eight hours later, so until takes_effect_at this answer names the wallet still in force and the waiting one beside it. A caller reading its old address back beside a pending change has not failed to write; the change is waiting. Null means nothing is waiting, which is every answer on the test channel and in a sandbox, where a change applies at once.",
  });

export type SellerName = z.infer<typeof SellerNameSchema>;
export type SellerNameRequest = z.infer<typeof SellerNameRequestSchema>;
export type PayoutWallet = z.infer<typeof PayoutWalletSchema>;
export type PendingPayoutWallet = z.infer<typeof PendingPayoutWalletSchema>;
export type MerchantKey = z.infer<typeof MerchantKeySchema>;
export type MerchantKeyList = z.infer<typeof MerchantKeyListSchema>;
export type IssueKeyRequest = z.infer<typeof IssueKeyRequestSchema>;
export type IssuedKey = z.infer<typeof IssuedKeySchema>;
export type DisabledKey = z.infer<typeof DisabledKeySchema>;

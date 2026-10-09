/**
 * What a merchant says about themselves: the name their products are sold
 * under, the wallet their sales are paid into, and the keys they open the door
 * with.
 *
 * The name is here rather than beside the card because it is a fact about the
 * merchant and about none of their cards, and the one question a reader
 * arrives with is which of the two names a merchant has is which.
 *
 * Two rules run through the file and are worth saying once.
 *
 * The secret appears in one document, the answer to the call that has just
 * made a key. Nothing that is ever drawn again —
 * the list a merchant reads, the row that comes back from disabling one — can
 * carry it, and the shapes below refuse it rather than merely omit it. What is
 * kept on our side is a digest, so there is nothing to put in those documents
 * even if somebody wanted to.
 *
 * And a key that has been revoked stays in the list. `disabled_at` is a moment
 * rather than a flag, and it is always present: after an incident the question
 * is when a key stopped working, and a list that dropped the key answers
 * nothing, while a flag answers only half.
 */

import { z } from "zod";
import { SellerSchema, ServiceNameSchema } from "./card.js";
import { EvmAddressSchema } from "./evm-address.js";
import { IdentifierSchema, TimestampSchema } from "./primitives.js";
import { SellerSiteSchema } from "./seller-site.js";

/**
 * What a merchant calls one of their keys, so one of several can be told from
 * the others.
 *
 * Not empty, and not padded with spaces. Both defeat the only thing a label is
 * for: a blank label is a row in a list with nothing in it, and a space at
 * either end makes two labels that look identical wherever they are printed
 * while being two different strings.
 *
 * What it does not do is worth saying, because a reader could take the rule for
 * more than it is. Nothing here bounds the length, since no channel outside us
 * carries this text and a number would be a bound nobody's format asks for, and
 * nothing here holds a label to one alphabet: unlike the name a discovery
 * catalog lists a seller under, a label never leaves the merchant's own
 * screens, so a label written in Cyrillic is a label. A character that shows
 * nothing is allowed through as well, which is the omission a reader is likeliest
 * to be surprised by — an identifier refuses one, because an identifier is
 * matched on and two that look alike are two keys nobody can tell apart, and a
 * label is only ever read, so the same character makes one odd-looking row.
 */
const KeyLabelSchema = z
  .string()
  .regex(/^\S(?:[\s\S]*\S)?$/u, "a label must not be empty or padded with spaces");

/**
 * The longest label a key is issued with.
 *
 * A label used to have no bound, on the argument that no channel outside us
 * carries it. One does now: on the live deployment the message that tells a
 * merchant of a new key, or of a wallet change made with one, names the key
 * by its label (ADR-0019), and that message is Agentify's words in somebody's
 * inbox. A hundred characters is a line on a list and in a message, and
 * longer than any name a person gives a worker.
 */
const LONGEST_KEY_LABEL = 100;

/**
 * A label as a new key is issued with it: the rule above, on one line, and no
 * longer than {@link LONGEST_KEY_LABEL}.
 *
 * Only the request carries the bound. The keys a merchant already holds are
 * read back under whatever they were named, including a key issued at the
 * server's terminal, because refusing the list over one old row would hide
 * every key on it; the message that names such a key cuts it to one line of
 * the same length itself.
 */
const IssuedKeyLabelSchema = KeyLabelSchema.max(
  LONGEST_KEY_LABEL,
  `a label is at most ${LONGEST_KEY_LABEL} characters, the one line a key is known by`,
).regex(
  // Written as code-point ranges rather than a Unicode property, because this
  // pattern is published in the JSON Schema a validator in another language
  // reads, and not every one of those knows the property escapes.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  /^[^\u0000-\u001F\u007F-\u009F\u2028\u2029]*$/u,
  "a label is one line: it cannot carry a line break, a tab or another control character",
);

/**
 * The key itself, in the only form its owner will ever see it.
 *
 * No whitespace anywhere in it, and that bound belongs to the transport rather
 * than to us: a key travels as a bearer token, and the reader on the other side
 * takes everything up to the first space. A secret with a space in it would
 * arrive as a prefix of itself and open nothing, and the merchant would spend
 * an afternoon on a key that looks perfectly good.
 *
 * Nothing here says how long a key is or what it starts with. Those are the
 * gateway's, which is the side that generates them, and a shape written down
 * here would be a promise about a format we mean to be free to change.
 */
const KeySecretSchema = z
  .string()
  .regex(/^\S+$/, "a key travels as a bearer token, so it carries no whitespace and is not empty");

/**
 * One key a merchant holds, as they read it.
 *
 * The secret is not here and cannot be put here. This is the document a screen
 * lists, drawn again on every visit, and the secret is shown once by the call
 * that made the key and never again — so a shape that could carry one is a
 * shape that eventually does.
 */
export const MerchantKeySchema = z
  .strictObject({
    id: IdentifierSchema,

    label: KeyLabelSchema,

    created_at: TimestampSchema,

    /**
     * The last call this key was seen on, and null where none is recorded.
     *
     * It is behind the truth by minutes and says so in the description: the
     * instant is refreshed only once the one on the row has gone stale, because
     * the alternative is a write in front of every purchase for a fact somebody
     * reads when they are deciding what to revoke. What it answers is "this key
     * was in use around then".
     *
     * Null is the absence of a record and not the absence of calls, and nothing
     * here tells a reader which. A key made before this gateway began writing
     * the field carries the same null as a key nobody has ever called with, and
     * there is no field beside this one that separates them — one would be a
     * permanent question on a public surface for an ambiguity that lasts weeks,
     * so what carries it is the sentence a screen puts under the column.
     */
    last_used_at: TimestampSchema.nullable(),

    /**
     * When this key was revoked, and null while it still opens the door.
     *
     * Required and nullable rather than optional, because the two readings of
     * an absent field are "this key works" and "nobody wrote it down", and a
     * screen that guessed wrong would show a revoked key as live. The instant
     * rather than a flag: a flag answers whether the key works, and the
     * question somebody asks afterwards is when it stopped.
     */
    disabled_at: TimestampSchema.nullable(),
  })
  .meta({
    description:
      "One key a merchant opens the door with, as they read it: what they called it, when it was made, when a call was last seen on it, and when it was revoked. A null disabled_at means the key still works; the field is always present, because an absent one is a silence a reader cannot tell from an oversight. The key itself is not in this document and never will be — what is kept is a digest of it, so nothing here or anywhere else can show a merchant their key a second time. last_used_at is not the instant of the last call and is not offered as one: it is refreshed at most once every few minutes per key, so a key under constant use carries a time that far behind, which is the price of not writing to the database on every call made with it. Null there means no call has been recorded against this key, which is not the same as no call having been made: a key made before this gateway began recording carries that same null, and nothing in this document tells such a key from one nobody has ever used. Nor is it a ledger of calls or an exact one: a mark that could not be written is swallowed rather than refusing the call it belonged to, so this is what was recorded and not everything that happened.",
  });

/**
 * The keys one merchant made for their own code, and the one this call was made
 * with.
 *
 * `this_call` is the field the list cannot be assembled without, and the reason
 * is a rule in the route rather than anything about the shape: a merchant
 * cannot disable the key their own call was made with (ADR-0014 §5). A screen
 * that did not know which of these that was would offer a button the route
 * refuses, on the one page where being refused looks like the product being
 * broken.
 *
 * It is always one of the keys beside it: every key is one a merchant issued
 * for their own code, and the dashboard calls with none (ADR-0030).
 *
 * An object rather than a bare array, for that reason before any other — an
 * array has nowhere to put it.
 */
export const MerchantKeyListSchema = z
  .strictObject({
    /**
     * The keys this merchant made for their own code, the revoked ones among
     * them.
     */
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
 * A key that has just been made: the row, and the secret, once.
 *
 * Both halves are needed by the caller. Without the secret there is no key to
 * hand to a worker; without the row there is a string and nothing to say which
 * of the merchant's keys it is, which is the thing they need to disable it
 * later.
 */
export const IssuedKeySchema = z
  .strictObject({
    key: MerchantKeySchema,
    /** The only moment this is readable. Nothing on our side keeps it. */
    secret: KeySecretSchema,
  })
  .meta({
    description:
      "A key as it comes back from being issued: the row a merchant will see in their list from now on, and the key itself. It carries the key once, and it is the one answer in this contract that carries one, because what is written down on our side is a digest. A key that is lost is replaced by a new one rather than read back.",
  });

/**
 * A key that has been revoked, as it now stands.
 *
 * An object rather than the key itself, so the day this answer has to say
 * anything beside the key — how many of the merchant's keys still work, say — it
 * grows a field instead of changing shape under every reader.
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
 * Null is the fact "nobody has chosen one", which is every merchant on the day
 * they register and is the state they stay in until they do. It is a value
 * rather than an absent field, because an absent field would be
 * indistinguishable from a client that dropped it, and a settings screen
 * reading the second as the first would tell a merchant they are listed under
 * nothing while they are listed under something.
 *
 * The name is held to the rule of the catalog that carries it, which is where
 * this name is going: at most thirty-two characters of printable ASCII. That
 * bound is not ours and is not about our own storage — the catalog drops what
 * it cannot render and tells nobody, so a name refused here is a name the
 * merchant is told about, and a name accepted here and dropped there is a
 * seller trading under something they did not choose.
 */
export const SellerNameSchema = z
  .strictObject({
    /**
     * What buyers read beside this merchant's products, or nothing — read back
     * by the rule an agent's `seller` reads it by, which leaves the plain-text
     * rule to the door that writes it.
     */
    seller_name: SellerSchema.shape.name,
    /**
     * The https address of the merchant's own shop, where an agent takes what
     * an order cannot answer (ADR-0034), or nothing where none was given.
     */
    seller_site: SellerSiteSchema.nullable(),
  })
  .meta({
    description:
      "The name a merchant's products are sold under: what a discovery catalog lists them under and what a buyer's agent is shown beside the price. Null means nobody has chosen one, which is where every merchant starts. The field is always present rather than left out when there is no name: an absent field would be indistinguishable from a client that dropped it. What a name may be is the catalog's rule rather than ours — at most 32 characters of printable ASCII — because a name outside it is dropped there in silence, so it is refused here where somebody is told. A merchant with no name cannot publish a card: a card published without one reaches a buyer's agent inside a payment request that names no seller at all. seller_site is the https address of the merchant's own shop, which every agent reads beside the name on their cards and orders as where to take what an order cannot answer; null means none was given.",
  });

/**
 * What a merchant sends to change what their products are sold under.
 *
 * The same field held to the same rule, and one difference: there is no null.
 * A merchant can go from having no name to having one and from one name to
 * another, and not back. Having none is a starting state rather than a setting,
 * because a payment request names the seller and there would be nobody to name:
 * every card they had already published would come off sale, which is an end to
 * their selling arriving under the name of editing a setting. What somebody
 * reaching for that actually wants is one of two other acts: a different name,
 * which is this same call, or an end to selling, which is the pause — and the
 * pause leaves their cards where they can find them again.
 *
 * So it is two documents rather than one, and a dashboard still reads back the
 * shape it sent. The message on a null is written here rather than left to a
 * type error, because "expected string, received null" describes the shape and
 * says nothing about which act the sender was reaching for.
 */
export const SellerNameRequestSchema = z
  .strictObject({
    /**
     * What buyers are to read beside this merchant's products, where it is
     * changing.
     *
     * The rule lives once, in `ServiceNameSchema`, and this reaches it through
     * a string that carries its own words for "this is not a name at all". A
     * second copy of the length and the alphabet written out here is the copy
     * that goes stale.
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
     * The https address of the merchant's own shop, where it is changing
     * (ADR-0034). Like the name it is changed and never taken away: an agent
     * holding an order that named a site has been told where to go, and a
     * site that vanished from the same order would leave it nowhere.
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
 * A change of the wallet that has been asked for, announced, and has not taken
 * effect yet.
 *
 * It exists because a replacement does not apply at once where the money is
 * real (ADR-0019). The address a merchant is paid at is the one setting whose
 * change redirects money, and a session in the merchant's dashboard is the one
 * thing that changes it — one left signed in somewhere, or taken — so on the
 * live deployment a replacement is told to every account of the merchant first
 * and takes effect forty-eight hours after that. What this document says is the two facts a
 * merchant needs in that window: what replaces the address, and from when.
 *
 * Both are required. An address with no moment says nothing about when the
 * money moves, and a moment with no address says it moves without saying where.
 */
export const PendingPayoutWalletSchema = z
  .strictObject({
    /** The address the merchant will be paid at once the wait is over. */
    payout_wallet: EvmAddressSchema,
    /** The moment it replaces the address paid now. */
    takes_effect_at: TimestampSchema,
  })
  .meta({
    description:
      "A replacement wallet that has been asked for and announced and has not taken effect yet. payout_wallet is the address sales will be paid into from takes_effect_at on, in the mixed-case spelling a wallet shows; until that moment every payment request still names the address paid now. The change takes effect then only if it is still the one waiting: asking for the address paid now cancels it, and asking for a different address replaces it and starts the wait again.",
  });

/**
 * The wallet a merchant's sales are paid into, as the merchant reads it back.
 *
 * Payments here are not held by anybody on the way: a buyer's agent pays the
 * merchant's own address directly, and this is that address. There is no
 * account of theirs on our side with a balance in it and no moment at which
 * their money is ours, which is why this field exists at all — without it there
 * would have to be.
 *
 * Null is the fact "nobody has said where the money goes", which is every
 * merchant on the day they register. It is a value rather than an absent field
 * for the reason the seller name is: a settings screen cannot tell a silence
 * from a client that dropped the field, and reading the second as the first
 * tells a merchant they are set up to be paid when nothing of theirs can be.
 *
 * What comes back is always the spelling a wallet shows, whichever of the two
 * accepted spellings was sent. The door takes both and everything behind it
 * holds one (ADR-0017), and this is the one for a reason that is about the
 * person rather than about the storage: a merchant pastes forty characters out
 * of their wallet and reads them back on a settings screen, and handed the same
 * address in lower case they cannot tell it from a different address without
 * comparing character by character. On the one field money is sent to, that
 * glance is the whole of the checking anybody does.
 *
 * `pending` is the change waiting beside it, and it is always present for the
 * same reason `payout_wallet` is: null says nothing is waiting, and an absent
 * field would be a silence. It is the field that keeps a caller from taking its
 * own write for a failure — a merchant who asked for a new address on the live
 * deployment reads the old one back, correctly, for forty-eight hours, and
 * without this they would ask again, or conclude the change was lost.
 *
 * It is carried without moving `CONTRACT_VERSION`, which is the one known
 * exception to the rule that a new required field moves it once a merchant we
 * do not control runs the SDK (ADR-0006 §2): no worker of the SDK reads this
 * route, so the version would stop every installed worker for a field none of
 * them sees. What that costs is that a
 * merchant's own code holding this schema from an older release of this
 * package refuses the answer until the package is upgraded.
 */
export const PayoutWalletSchema = z
  .strictObject({
    /** Where this merchant's sales are paid now, or nothing at all. */
    payout_wallet: EvmAddressSchema.nullable(),
    /** A replacement that has been announced and is waiting, or nothing. */
    pending: PendingPayoutWalletSchema.nullable(),
  })
  .meta({
    description:
      "The address a merchant's sales are paid into, and any change of it that is waiting. Payments are not held by anybody on the way: a buyer's agent pays payout_wallet directly, and it is the payTo of every payment request made for this merchant's products now. Null means nobody has set one, which is where every merchant starts; the field is always present rather than left out, because an absent field is indistinguishable from a client that dropped it. The address comes back in the mixed-case spelling a wallet shows, whichever of the two accepted spellings was sent — so what a merchant reads back on a screen is character for character what they copied out of their wallet. On a deployment that settles on a real chain a merchant with no wallet here cannot publish a card, because the money from that card's sales would have nowhere to go. pending is a replacement that has been asked for and has not taken effect: on the live deployment a merchant who already has a wallet and asks for a different one is told of it by message, and the new address takes effect forty-eight hours later, so until takes_effect_at this answer names the address still paid and the waiting one beside it. A caller reading its old address back beside a pending change has not failed to write; the change is waiting. Null means nothing is waiting, which is every answer on the test channel and in a sandbox, where a change applies at once.",
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

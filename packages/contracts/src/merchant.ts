/**
 * What a merchant says about themselves: the name their products are sold
 * under and the wallet their share of each sale arrives at.
 */

import { z } from "zod";
import { SellerSchema, ServiceNameSchema } from "./card.js";
import { EvmAddressSchema } from "./evm-address.js";
import { TimestampSchema } from "./primitives.js";
import { SellerSiteSchema } from "./seller-site.js";

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
 * 0.1% to Agentify, each share rounded down and less a unit the contracts keep
 * back. Nobody, Agentify included, can change those recipients or shares;
 * Circle, which issues USDC, can freeze USDC at any address, the contract's
 * included. Null means nobody has set one, which is where every merchant
 * starts. The address comes back in the checksummed spelling a wallet shows,
 * whichever accepted spelling was sent, so a merchant can compare it by eye
 * with their wallet.
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
      "The wallet a merchant's share of their sales arrives at, and any change of it that is waiting. A buyer's agent never pays payout_wallet, and it is never the payTo of a payment request. Every payment request made for this merchant's products names, as payTo, the merchant's payout contract for this wallet: a split contract of the 0xSplits protocol with no owner, which keeps what buyers pay into it until somebody sends a payout, as anybody may at any time, the merchant included, and then sends 99.9% of the accumulated balance to payout_wallet and 0.1% to Agentify: each share is rounded down to the smallest unit of USDC, and one unit stays behind on the payout contract and on each balance a payout credits, so 1.000000 USDC paid into a new payout contract reaches payout_wallet as 0.998998 at its first payout, and what the rounding leaves over is divided in a later one. Nobody, Agentify included, can change those two recipients or their shares, and Circle, which issues USDC, can freeze USDC at any address, the payout contract and the shared warehouse it pays through included. So what arrives at payout_wallet is one transfer per payout from the 0xSplits warehouse, the shared contract the payout contracts pay their shares through, covering what was paid in since the payout before as that rounding leaves it, and never a buyer's own transfer. Neither the payout contract nor the commission on an order is named here, and there is no exact commission per order to name: a payout divides the accumulated balance, not each payment. Null means nobody has set one, which is where every merchant starts; the field is always present rather than left out, because an absent field is indistinguishable from a client that dropped it. The address comes back in the mixed-case spelling a wallet shows, whichever of the two accepted spellings was sent — so what a merchant reads back on a screen is character for character what they copied out of their wallet. On a deployment that settles on a real chain a merchant with no wallet here cannot publish a card, because a payout contract is made for a wallet, and without one the money from that card's sales would have nowhere to go. pending is a replacement that has been asked for and has not taken effect: on the live deployment a merchant who already has a wallet and asks for a different one is told of it by message, and the new address takes effect forty-eight hours later, so until takes_effect_at this answer names the wallet still in force and the waiting one beside it. A caller reading its old address back beside a pending change has not failed to write; the change is waiting. Null means nothing is waiting, which is every answer on the test channel and in a sandbox, where a change applies at once.",
  });

export type SellerName = z.infer<typeof SellerNameSchema>;
export type SellerNameRequest = z.infer<typeof SellerNameRequestSchema>;
export type PayoutWallet = z.infer<typeof PayoutWalletSchema>;
export type PendingPayoutWallet = z.infer<typeof PendingPayoutWalletSchema>;

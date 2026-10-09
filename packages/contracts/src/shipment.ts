/**
 * A parcel's shipment (ADR-0033): what the merchant says once a carrier has the
 * parcel, and what the agent reads afterwards.
 *
 * It is the body of the `deliver` call on a parcel's order, in place of goods.
 * A carrier, required — a carrier's name, or the shop's own courier — and a
 * tracking number, whose key is required and whose value is null for a parcel
 * that has none, never an empty string: a shop's own courier can sell through
 * this mode, and "no number" has to be said rather than forgotten. A tracking
 * page and an expected delivery window are optional.
 *
 * All of it is the merchant's claim and none of it is checked against a
 * carrier, so the door holds it to its shape and to plain words on one line,
 * as it holds a seller's name (ADR-0017): every agent that bought the parcel
 * reads it exactly as it was written. The instant the parcel shipped is the
 * gateway's to stamp when it records the shipment, never the merchant's to
 * send.
 */

import { z } from "zod";
import { notPlainTextIn } from "./plain-text.js";
import { TimestampSchema } from "./primitives.js";
import { SellerSiteSchema } from "./seller-site.js";

/** How long a carrier's name or a tracking number may be. */
const SHIPMENT_TEXT_MAX = 100;

/**
 * A short piece of the merchant's own words, as an agent will read it. The
 * plain-text rule is a refinement, which no JSON Schema carries, so the
 * description says it.
 */
const shortPlainText = (what: string, says: string) =>
  z
    .string()
    .min(1, `${what} must not be empty`)
    .max(SHIPMENT_TEXT_MAX, `${what} is at most ${SHIPMENT_TEXT_MAX} characters`)
    .regex(/^\S(?:.*\S)?$/, `${what} must not be blank or padded with spaces`)
    .superRefine((text, ctx) => {
      for (const phrase of notPlainTextIn(text, "one line")) {
        ctx.addIssue({
          code: "custom",
          message: `${what} carries ${phrase}, and it is plain text, which an agent reads exactly as it is written`,
        });
      }
    })
    .meta({
      description: `${says}: at most ${SHIPMENT_TEXT_MAX} characters of plain text on one line, neither blank nor padded with spaces. HTML markup and character references are refused rather than read as words.`,
    });

/** What a tracking address is held to, said once for the refusal and the description. */
const TRACKING_FORM =
  "a tracking address is a whole https address on a domain name, written as an address parser writes it back: at most 500 characters, a host in lower case and in its ASCII form (punycode for a name in another script), with no spaces, line breaks, quotes or markup, and no credentials, port or IP address. It is an address to open, never words to act on";

/**
 * Where a parcel can be followed. It is an address and nothing else, because
 * every agent that bought the parcel reads it: a parser that would rewrite it
 * — a space, a line break, markup in its query, capitals in its host — means
 * there are words of the merchant's in it, and those are refused rather than
 * cleaned, as the rest of the shipment's text is. What its path and query say
 * is the carrier's, and it is an address to open, never words to act on.
 */
const TrackingUrlSchema = z
  .string()
  .max(500, TRACKING_FORM)
  .regex(/^https:\/\//, { message: TRACKING_FORM, abort: true })
  .refine((address) => {
    try {
      const parsed = new URL(address);
      // A parser writes a slash after a bare host, before a query or a
      // fragment as well as at the end, and that alone is not a rewrite.
      const slashed = address.replace(/^(https:\/\/[^/?#]*)(?=[?#]|$)/, "$1/");
      return (
        (parsed.href === address || parsed.href === slashed) &&
        parsed.username === "" &&
        parsed.password === "" &&
        // Its origin is held as a seller's site is (ADR-0034): https, a
        // domain name in lower case, no port.
        SellerSiteSchema.safeParse(parsed.origin).success
      );
    } catch {
      return false;
    }
  }, TRACKING_FORM)
  .meta({ description: `Where the parcel can be followed: ${TRACKING_FORM}.` });

/** When the merchant expects the parcel to arrive, as a window. */
const EstimatedDeliverySchema = z
  .strictObject({
    earliest: TimestampSchema,
    latest: TimestampSchema,
  })
  .refine((window) => Date.parse(window.earliest) <= Date.parse(window.latest), {
    path: ["earliest"],
    message: "an expected delivery's earliest instant comes no later than its latest",
  })
  .meta({
    description:
      "When the merchant expects the parcel to arrive, as a window: the earliest instant comes no later than the latest.",
  });

/** What the merchant records when a carrier has the parcel. */
export const ShipmentSchema = z
  .strictObject({
    /** Who carries it: a carrier's name, or the shop's own courier. */
    carrier: shortPlainText(
      "a carrier",
      "Who carries the parcel: a carrier's name, or the shop's own courier",
    ),
    /** The carrier's number for the parcel, or null where there is none. */
    tracking_number: shortPlainText(
      "a tracking number",
      "The carrier's number for the parcel, or null where there is none",
    ).nullable(),
    /** Where the parcel can be followed, where the carrier has such a page. */
    tracking_url: TrackingUrlSchema.optional(),
    /** When the merchant expects it to arrive, where they know. */
    estimated_delivery: EstimatedDeliverySchema.optional(),
  })
  .meta({
    description:
      'A parcel\'s shipment, as the merchant records it with the deliver call once a carrier has the parcel. "carrier" is required: a carrier\'s name, or the shop\'s own courier. "tracking_number" is required as a key and is null for a parcel that has no number, never an empty string. "tracking_url" is an https page where the parcel can be followed, written as an address and nothing else, and "estimated_delivery" the window it is expected in; both are optional. All of it is the merchant\'s claim, which Agentify does not check against any carrier, and its words are plain text on one line. The instant it shipped is not sent: Agentify records it.',
  });

/** A shipment as the agent reads it: what the merchant said, and when it was recorded. */
export const RecordedShipmentSchema = ShipmentSchema.extend({
  /** When Agentify recorded the shipment. */
  shipped_at: TimestampSchema,
}).meta({
  description:
    "A parcel's shipment as Agentify recorded it: what the merchant said — the carrier, the tracking number or null where there is none, and where they gave them a tracking page and an expected delivery window — and \"shipped_at\", the instant Agentify recorded it. All of it but that instant is the merchant's claim, which Agentify did not check against any carrier. It is the last thing Agentify knows about the parcel: whether it arrives is between the buyer and the merchant, and the seller's site is where to ask.",
});

export type Shipment = z.infer<typeof ShipmentSchema>;
export type RecordedShipment = z.infer<typeof RecordedShipmentSchema>;

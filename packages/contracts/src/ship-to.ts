/**
 * The address a parcel goes to (ADR-0032).
 *
 * An agent buying a parcel sends it beside the purchase, in a shape of ours
 * with the Agentic Commerce Protocol's names, because that is the address an
 * agent already writes: `name`, `line_one`, `line_two`, `city`, `state`,
 * `postal_code`, `country`, `phone_number`. One `name`, because a person may
 * have one name and a split name cannot be recovered without guessing; no
 * company, because the second line holds it; a phone, because the carriers a
 * merchant hands a parcel to mostly ask for one and the merchant cannot ask
 * for it themselves.
 *
 * The door checks the shape and no more. Whether a state or a postal code is
 * needed in this country, and whether the merchant ships there at all, is the
 * merchant's to answer in their price check: a per-country table of what is
 * required is a table this contract would keep wrong.
 *
 * The address is the buyer's and passes through Agentify. The merchant's price
 * question receives only the locality — where the parcel goes, not to whom —
 * and the full address reaches the merchant only once the order is paid. Once
 * the merchant takes the order on, or the order ends without them, Agentify
 * erases its copy, and the order reads only when that happened.
 */

import { z } from "zod";
import { TimestampSchema } from "./primitives.js";

/** A part of an address that has to say something. */
const said = (what: string) => z.string().regex(/\S/, `${what} is not blank`);

const CountrySchema = z
  .string()
  .regex(/^[A-Z]{2}$/, "a country is two capital letters, ISO 3166-1 alpha-2, such as ID or US");

const StateSchema = z
  .string()
  .regex(
    /^[A-Z0-9]{1,3}$/,
    "a state is its subdivision code without the country in front, such as CA, NSW or BA",
  );

export const ShipToSchema = z
  .strictObject({
    /** Who receives the parcel, as one name. */
    name: said("a name"),
    line_one: said("the first line of an address"),
    /** A flat, a building, a company. Absent where there is none. */
    line_two: said("the second line of an address").optional(),
    city: said("a city"),
    /** The subdivision code without the country, where the country has them. */
    state: StateSchema.optional(),
    postal_code: said("a postal code").optional(),
    country: CountrySchema,
    phone_number: said("a phone number"),
  })
  .meta({
    description:
      "Where a parcel goes, in the Agentic Commerce Protocol's names. A name, a first line, a city, a country and a phone are required; the country is ISO 3166-1 alpha-2 and a state, where given, is its subdivision code without the country in front. Whether a state or a postal code is needed here, and whether the merchant ships to this place, is the merchant's to answer. The address passes through Agentify: the merchant's price question receives only its locality, the merchant receives the whole of it once the order is paid, and Agentify erases its copy once the merchant takes the order on, or the order ends without them.",
  });

/** Where a parcel goes as its price is asked: the place, not the person. */
export const ShipToLocalitySchema = z
  .strictObject({
    country: CountrySchema,
    state: StateSchema.optional(),
    city: said("a city"),
    postal_code: said("a postal code").optional(),
  })
  .meta({
    description:
      "Where a parcel goes, as its price is asked: the country, the state, the city and the postal code of the address, and nothing about who receives it. A price question reaches a merchant for purchases that are never made, and a shipping rate needs the place alone.",
  });

/** An address Agentify no longer holds: only when it let it go. */
export const ErasedShipToSchema = z
  .strictObject({
    erased_at: TimestampSchema,
  })
  .meta({
    description:
      "An address Agentify has erased, because nothing of Agentify's needs it any more: the merchant took the order on or recorded its shipment, or the order ended or came to owe a refund without being taken on. Only when it was erased is kept, and nothing of what it was. The merchant holds the address only as they stored it from the paid order, and an order that ended before it was paid never gave it to them.",
  });

export type ShipTo = z.infer<typeof ShipToSchema>;
export type ShipToLocality = z.infer<typeof ShipToLocalitySchema>;
export type ErasedShipTo = z.infer<typeof ErasedShipToSchema>;

/** The locality of an address, with what it did not give left out. */
export const localityOf = (address: ShipTo): ShipToLocality => ({
  country: address.country,
  ...(address.state === undefined ? {} : { state: address.state }),
  city: address.city,
  ...(address.postal_code === undefined ? {} : { postal_code: address.postal_code }),
});

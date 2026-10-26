/**
 * The address a parcel goes to, in the Agentic Commerce Protocol's field names
 * because that is the address an agent already writes.
 *
 * One `name`, because a split name cannot be recovered without guessing; no
 * company, because the second line holds it; a phone, because carriers mostly
 * ask for one and the merchant cannot ask the buyer themselves. Only the shape
 * is checked: whether a state or a postal code is needed in a country, and
 * whether the merchant ships there at all, is the merchant's to answer in
 * their price check.
 */

import { z } from "zod";
import { TimestampSchema } from "./primitives.js";

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
      "Where a parcel goes, in the Agentic Commerce Protocol's names. A name, a first line, a city, a country and a phone are required; the country is ISO 3166-1 alpha-2 and a state, where given, is its subdivision code without the country in front. Whether a state or a postal code is needed here, and whether the merchant ships to this place, is the merchant's to answer. The price on a parcel's card is the goods alone; a purchase is priced for the address it names, with shipping to it and any tax for it included. The address passes through Agentify: the merchant's price question receives only its locality, the merchant receives the whole of it once the order is paid, and Agentify erases its copy from its database once the merchant takes the order on, or the order ends without them. Copies of the database taken before the erasure keep it: the live channel's backups, usually for about sixty days, with no upper bound set yet, and the restore point each release takes, on either channel, until five newer releases replace it.",
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

/** An address Agentify no longer holds: only the moment it was erased. */
export const ErasedShipToSchema = z
  .strictObject({
    erased_at: TimestampSchema,
  })
  .meta({
    description:
      "An address Agentify has erased, because nothing of Agentify's needs it any more: the merchant took the order on or recorded its shipment, or the order ended or became unfulfilled without being taken on. Only when it was erased is kept on the order, and nothing of what it was. Erasing removes the address from Agentify's database. Copies of the database taken before the erasure keep it: the live channel's backups, usually for about sixty days, with no upper bound set yet, and the restore point each release takes, on either channel, until five newer releases replace it. The merchant holds the address only as they stored it from the paid order, and an order that ended before it was paid never gave it to them.",
  });

export type ShipTo = z.infer<typeof ShipToSchema>;
export type ShipToLocality = z.infer<typeof ShipToLocalitySchema>;
export type ErasedShipTo = z.infer<typeof ErasedShipToSchema>;

/** The locality of an address: the place, not the person. */
export const localityOf = (address: ShipTo): ShipToLocality => ({
  country: address.country,
  ...(address.state === undefined ? {} : { state: address.state }),
  city: address.city,
  ...(address.postal_code === undefined ? {} : { postal_code: address.postal_code }),
});

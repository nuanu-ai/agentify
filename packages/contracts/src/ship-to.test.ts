import { describe, expect, it } from "vitest";
import { PurchaseRequestSchema } from "./api.js";
import { OrderSchema } from "./order.js";
import { QuoteRequestSchema } from "./quote.js";
import { ErasedShipToSchema, localityOf, ShipToLocalitySchema, ShipToSchema } from "./ship-to.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

/**
 * The address a parcel goes to (ADR-0032), in the Agentic Commerce Protocol's
 * names, because that is the address an agent already writes.
 *
 * The door checks the shape and no more: whether a state or a postal code is
 * needed for this country, and whether the merchant ships there at all, is the
 * merchant's to answer, in their price check. A rule written here instead
 * would be a per-country table this contract does not keep.
 */

/** An address in a real place, with the person and the number taken out of it. */
const address = {
  name: "The buyer",
  line_one: "Jl. Raya Kediri, Beraban",
  line_two: "Nuanu Creative City",
  city: "Tabanan",
  state: "BA",
  postal_code: "82121",
  country: "ID",
  phone_number: "+62 000 0000 0000",
};

describe("where a parcel goes", () => {
  it("takes an address in the names an agent already writes", () => {
    expect(ShipToSchema.parse(address)).toStrictEqual(address);
  });

  it("takes an address with no second line, no state and no postal code", () => {
    // Many countries have no states, and some have no postal codes; whether
    // this one needs them is the merchant's to say, not the door's.
    const { line_two: _second, state: _state, postal_code: _postal, ...least } = address;

    expect(ShipToSchema.parse(least)).toStrictEqual(least);
  });

  for (const field of ["name", "line_one", "city", "country", "phone_number"]) {
    it(`refuses an address without ${field} and names it`, () => {
      expectMissingFieldRejected(ShipToSchema, address, field);
    });
  }

  it("refuses a blank name, line or city rather than reading it as given", () => {
    for (const field of ["name", "line_one", "city", "phone_number", "line_two", "postal_code"]) {
      expect(ShipToSchema.safeParse({ ...address, [field]: "  " }).success, field).toBe(false);
    }
  });

  it("holds the country to two capital letters", () => {
    for (const country of ["id", "IDN", "Indonesia", "I"]) {
      expect(errorOf(ShipToSchema, { ...address, country }), country).toContain("country");
    }
  });

  it("holds the state to a subdivision code without the country in front of it", () => {
    expect(ShipToSchema.safeParse({ ...address, country: "AU", state: "NSW" }).success).toBe(true);
    for (const state of ["ID-BA", "Bali", "ba", "BALI"]) {
      expect(errorOf(ShipToSchema, { ...address, state }), state).toContain("state");
    }
  });

  it("refuses a field the address does not have, such as a company", () => {
    // The second line holds a company; a field of our own beside the
    // protocol's would be one an agent never fills in.
    expect(ShipToSchema.safeParse({ ...address, company: "Nuanu" }).success).toBe(false);
  });
});

describe("where a parcel goes, as its price is asked", () => {
  it("is the locality and nothing about who receives it", () => {
    // A price question reaches a merchant for purchases never made, and a
    // shipping rate needs the place, not the person (ADR-0032).
    expect(localityOf(address)).toStrictEqual({
      country: "ID",
      state: "BA",
      city: "Tabanan",
      postal_code: "82121",
    });
    expect(ShipToLocalitySchema.parse(localityOf(address))).toStrictEqual(localityOf(address));
  });

  it("leaves out what the address did not give, rather than writing it as empty", () => {
    const { state: _state, postal_code: _postal, ...least } = address;

    expect(localityOf(least)).toStrictEqual({ country: "ID", city: "Tabanan" });
  });

  it("refuses a name or a street, which are not a locality", () => {
    expect(ShipToLocalitySchema.safeParse({ ...localityOf(address), name: "x" }).success).toBe(
      false,
    );
    expect(ShipToLocalitySchema.safeParse({ ...localityOf(address), line_one: "x" }).success).toBe(
      false,
    );
  });
});

describe("an address that has been erased", () => {
  it("says when, and nothing of what it was", () => {
    expect(ErasedShipToSchema.parse({ erased_at: "2026-10-09T10:00:00Z" })).toStrictEqual({
      erased_at: "2026-10-09T10:00:00Z",
    });
    expect(
      ErasedShipToSchema.safeParse({ erased_at: "2026-10-09T10:00:00Z", country: "ID" }).success,
    ).toBe(false);
    expectMissingFieldRejected(
      ErasedShipToSchema,
      { erased_at: "2026-10-09T10:00:00Z" },
      "erased_at",
    );
  });
});

describe("the address on the documents that carry it", () => {
  const address = {
    name: "The buyer",
    line_one: "Jl. Raya Kediri, Beraban",
    city: "Tabanan",
    country: "ID",
    phone_number: "+62 000 0000 0000",
  };

  it("rides beside a purchase's parameters", () => {
    expect(PurchaseRequestSchema.parse({ params: {}, ship_to: address }).ship_to).toStrictEqual(
      address,
    );
    expect(
      PurchaseRequestSchema.safeParse({ params: {}, ship_to: { country: "ID" } }).success,
    ).toBe(false);
  });

  it("reaches a price question as its locality, and never as the whole of it", () => {
    const question = {
      merchant_item_id: "beans-1kg",
      price_id: "prc_1",
      purpose: "purchase",
      expires_at: "2026-10-09T10:00:00Z",
    };

    expect(
      QuoteRequestSchema.safeParse({ ...question, ship_to: localityOf(address) }).success,
    ).toBe(true);
    expect(QuoteRequestSchema.safeParse({ ...question, ship_to: address }).success).toBe(false);
  });

  it("reads on the merchant's order as the place, the whole address, or when it was erased", () => {
    const order = {
      id: "ord_1",
      merchant_item_id: "beans-1kg",
      params: {},
      price: {
        amount: "21.00",
        currency: "USD",
        at: "2026-10-09T09:01:00Z",
        as_of: "2026-10-09T09:01:00Z",
      },
      test: true,
    };

    for (const ship_to of [localityOf(address), address, { erased_at: "2026-10-09T09:05:00Z" }]) {
      expect(OrderSchema.safeParse({ ...order, ship_to }).success, JSON.stringify(ship_to)).toBe(
        true,
      );
    }
    expect(
      OrderSchema.safeParse({
        ...order,
        ship_to: { ...localityOf(address), erased_at: "2026-10-09T09:05:00Z" },
      }).success,
    ).toBe(false);
  });
});

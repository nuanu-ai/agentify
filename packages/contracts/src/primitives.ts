/**
 * The vocabulary every other contract in this package is built from: a sum of
 * money, a currency, a moment in time, an identifier.
 *
 * Money never travels as a floating point number. An amount is a decimal
 * string, and a merchant who writes "5.00" gets "5.00" back, trailing zero and
 * all, in the order and in the receipt.
 *
 * These schemas bound formats, not business policy: how long a title may be or
 * how stale a price may get is the gateway's to decide, not this package's.
 */

import { z } from "zod";

/**
 * A decimal number written as text: digits, optionally a dot and more digits.
 *
 * Exponent notation, thousands separators, a leading plus, leading zeros and a
 * minus sign are refused, so that the same money is always the same string. Up
 * to eighteen digits are allowed on each side of the dot; eighteen fractional
 * digits is the most an ERC-20 token carries.
 */
export const AmountSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/,
    'an amount is an exact decimal number written as text, such as "5.00"',
  );

/**
 * A currency code in upper case: three to eight characters, starting with a
 * letter, such as `USD`, `USDC` or `USD1`.
 *
 * This checks the shape only. Which currencies a price may be set in is decided
 * by the price rule in `price-rule.ts`; a list here would make documents
 * written before the list changed unreadable.
 */
export const CurrencyCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{2,7}$/, 'a currency code is written in upper case, such as "USD"');

/** A sum of money: how much, in what. */
export const MoneySchema = z.strictObject({
  amount: AmountSchema,
  currency: CurrencyCodeSchema,
});

/**
 * A moment in time, ISO 8601, with its zone: an explicit offset or `Z`.
 *
 * A local time with no offset is refused, because two machines would read it
 * as two different moments, and these timestamps are what a charge is
 * reconciled against later.
 */
export const TimestampSchema = z.iso.datetime({ offset: true });

const UNPRINTABLE = "\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2060-\\u2064\\ufeff";

/**
 * An identifier, Agentify's or the merchant's.
 *
 * It must not be blank, must not begin or end with whitespace, and carries no
 * control or invisible characters. A merchant's key is what republishing a card
 * matches on, so `"access-monthly "` would quietly create a second card that
 * looks identical in every log. Beyond that the shape and the length are left
 * open.
 */
export const IdentifierSchema = z.string().regex(
  // One pattern rather than three refinements, because a refinement is dropped
  // from the JSON Schema export without a word, while a pattern crosses intact
  // and a generated client refuses the same keys.
  new RegExp(`^[^\\s${UNPRINTABLE}](?:[^${UNPRINTABLE}]*[^\\s${UNPRINTABLE}])?$`, "u"),
  "an identifier must not be empty, padded with whitespace, or carry characters that show nothing",
);

/**
 * A word of a vocabulary that grows without a version: a mode on the card an
 * agent reads, a status on its order.
 *
 * A word added later reaches agents that still hold this contract, and they
 * should read it rather than refuse the document. It is still held to the
 * shape every word in those lists has: lower-case letters, digits and
 * underscores, starting with a letter, at most sixty-four characters.
 */
export const OpenWordSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,63}$/,
    "a word of this vocabulary is lower-case letters, digits and underscores, starts with a letter and is at most sixty-four characters long",
  );

/**
 * The price a purchase actually went through at, complete enough for the
 * merchant's handler to record the sale without looking the card up.
 *
 * `at` is the moment this price was fixed for this sale, and `as_of` the moment
 * the price behind it was true. A merchant whose answer lands at 10:15 out of a
 * price list published at 10:00 sells at an `at` of 10:15 and an `as_of` of
 * 10:00. A card sold from its own price, never checked live, carries as `as_of`
 * the moment that price was last published.
 *
 * Neither is when the money moved: an agent may pay long after the price was
 * fixed, and in synchronous fulfillment the charge executes after the goods.
 * The receipt's `paid_at` records facilitator confirmation or verified chain
 * execution time.
 */
export const SalePriceSchema = z.strictObject({
  amount: AmountSchema,
  currency: CurrencyCodeSchema,
  at: TimestampSchema,
  as_of: TimestampSchema,
});

export type Amount = z.infer<typeof AmountSchema>;
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;
export type Money = z.infer<typeof MoneySchema>;
export type Timestamp = z.infer<typeof TimestampSchema>;
export type Identifier = z.infer<typeof IdentifierSchema>;
export type OpenWord = z.infer<typeof OpenWordSchema>;
export type SalePrice = z.infer<typeof SalePriceSchema>;

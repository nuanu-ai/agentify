/**
 * The small schema language a card writes its purchase parameters and its
 * delivery result in, and the compiler that turns one of those declarations
 * into a check.
 *
 * The gateway checks an agent's purchase against the card's `params` and the
 * SDK checks a merchant's delivery against the card's `result` with this same
 * compiler, so that a card cannot mean two different things on the two sides.
 * The language has four scalar types and nothing else.
 */

import { z } from "zod";

/** The types a card may declare; each has a check behind it in `paramSpecToValidator`. */
export const ParamTypeSchema = z.enum(["string", "number", "integer", "boolean"], {
  error: "a declared field's type is string, number, integer or boolean",
});

/**
 * The name of one parameter: a letter, then letters, digits and underscores.
 * A name becomes a JSON property and a segment of the error path a merchant
 * reads, so dots and spaces are refused. One name never gets this far; see
 * `PROTOTYPE_KEY_IS_DROPPED`.
 */
export const ParamNameSchema = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_]*$/,
    "a parameter name starts with a letter and carries letters, digits and underscores",
  );

/**
 * One declared field: its type, whether it has to be there, and a line of
 * human words saying what it is for.
 *
 * Leaving out `required` means "may be left out" in the purchase parameters
 * and "arrives" in the delivery result. Setting it says the same in both.
 */
export const FieldSpecSchema = z.strictObject({
  type: ParamTypeSchema,
  required: z.boolean().optional(),
  title: z.string().regex(/\S/, "a title must not be empty or blank").optional(),
});

/**
 * A key named `__proto__` is removed by zod while a record is parsed, before
 * any check here runs, so it is neither carried nor refused and nobody is
 * told. That holds wherever this contract parses a record of free-form names:
 * a card's `params` and `result`, an order's `params`, a purchase's `params`,
 * a price question's `params`, and a delivery. No card can declare such a
 * field, so a merchant meets this only by sending a name nobody asked for, and
 * it guarantees the compiler is never handed a name that would set a
 * prototype. A test holds zod to it.
 */
export const PROTOTYPE_KEY_IS_DROPPED = "__proto__";

/** A whole declaration: the parameters of a purchase, or a delivery result. */
export const ParamSpecSchema = z.record(ParamNameSchema, FieldSpecSchema, {
  // The library's default, "expected record, received string", lands on the
  // mistake the short form invites: `result: 'string'` declares nothing. A
  // declaration that is absent keeps the library's own words, which say so.
  error: (issue) =>
    issue.input === undefined
      ? undefined
      : "a declaration names each field and gives its type, as in { access_url: 'string' }; a type word on its own declares one field and not the whole of it",
});

export type ParamType = z.infer<typeof ParamTypeSchema>;
export type FieldSpec = z.infer<typeof FieldSpecSchema>;
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

/**
 * One declared field as a merchant may write it on a card: the whole spec, or
 * the type word alone. The short form is opened out when a card is parsed, so
 * this type describes what may be written, never what is stored or read back.
 */
export type FieldSpecInput = FieldSpec | ParamType;

/** A whole declaration as a merchant may write it, field by field. */
export type ParamSpecInput = Record<string, FieldSpecInput>;

const checkFor = (type: ParamType, direction: ParamSpecDirection): z.ZodType => {
  switch (type) {
    case "string":
      // A delivered string must carry something, while a purchase may leave one
      // empty. In a delivery the field is what the buyer paid for, and an empty
      // access code is nothing arriving under the name of something; without
      // this, `{}` would be refused and `{access_code: ""}` accepted.
      return direction === "delivery"
        ? z.string().regex(/\S/, "a delivered field carries something, and this one is blank")
        : z.string();
    case "number":
      return z.number();
    case "integer":
      return z.int();
    case "boolean":
      return z.boolean();
  }
};

/**
 * Which of a card's two declarations is being compiled: a purchase is input
 * the agent is asked for, and a delivery is a promise the card made before the
 * agent paid.
 *
 * In a purchase a field with no `required` flag may be left out; in a delivery
 * it must arrive, and a field that genuinely may be absent says
 * `required: false`. A string may be empty in a purchase and may not in a
 * delivery.
 */
export type ParamSpecDirection = "purchase" | "delivery";

/**
 * Turns a declaration, already parsed by `ParamSpecSchema`, into the check an
 * instance of it is held to.
 *
 * Keys the declaration does not carry are refused in both directions, rather
 * than stripped, which would truncate silently, or passed through, which would
 * hand the merchant's handler fields the card never declared. The one key this
 * cannot refuse is `__proto__`; see `PROTOTYPE_KEY_IS_DROPPED`.
 */
export const paramSpecToValidator = (spec: ParamSpec, direction: ParamSpecDirection): z.ZodType => {
  const shape: Record<string, z.ZodType> = {};

  for (const [name, field] of Object.entries(spec)) {
    const check = checkFor(field.type, direction);
    const required = field.required ?? direction === "delivery";
    shape[name] = required ? check : check.optional();
  }

  return z.strictObject(shape);
};

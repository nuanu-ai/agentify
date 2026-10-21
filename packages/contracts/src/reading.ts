/**
 * How a reader takes what a gateway sends, which is not how a gateway writes
 * it. The schemas in this package are the writing contract and are closed, so
 * a field the gateway was never meant to send is refused on the gateway's side.
 * A reader made here from one of them ignores fields it does not know at any
 * depth, reads an order's status or payment word it does not know as
 * `unknown`, and reads an event of a kind it does not know as
 * `{ type: "unknown", named }`, so a consumer can skip it and keep the rest of
 * the answer. Everything the closed schema requires, it still requires, and an
 * event of a known kind that does not fit is refused like any broken answer.
 */

import { z } from "zod";
import { ORDER_EVENT_TYPES, type OrderEvent, OrderEventSchema } from "./events.js";
import {
  type OrderStatus,
  OrderStatusSchema,
  type PaymentStatus,
  PaymentStatusSchema,
} from "./order-status.js";

/** The word a reader puts in place of a status or an event kind it was not built with. */
export const UNKNOWN_WORD = "unknown";

export type UnknownWord = typeof UNKNOWN_WORD;

/** An event this reader could not read, with the kind it said it was. */
export interface UnreadEvent {
  readonly type: UnknownWord;
  readonly named: string;
}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The shape a reader gives a document whose closed shape is `T`. */
export type Read<T> =
  Same<T, OrderStatus> extends true
    ? OrderStatus | UnknownWord
    : Same<T, PaymentStatus> extends true
      ? PaymentStatus | UnknownWord
      : Same<T, OrderEvent> extends true
        ? OrderEvent | UnreadEvent
        : T extends readonly (infer Each)[]
          ? Read<Each>[]
          : T extends object
            ? { [Key in keyof T]: Read<T[Key]> }
            : T;

const aWord = () => z.string().regex(/\S/, "a word is not blank");

const wordOrUnknown = (words: z.ZodType<string>) =>
  aWord().transform((word) => (words.safeParse(word).success ? word : UNKNOWN_WORD));

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(ORDER_EVENT_TYPES));

const OPENED_ON_READING: ReadonlyMap<z.ZodType, () => z.ZodType> = new Map<
  z.ZodType,
  () => z.ZodType
>([
  [OrderStatusSchema, () => wordOrUnknown(OrderStatusSchema)],
  [PaymentStatusSchema, () => wordOrUnknown(PaymentStatusSchema)],
  [
    OrderEventSchema,
    () =>
      z.union([
        withoutUnknownFields(OrderEventSchema),
        z
          .looseObject({ type: aWord().refine((type) => !KNOWN_EVENT_TYPES.has(type)) })
          .transform(({ type }): UnreadEvent => ({ type: UNKNOWN_WORD, named: type })),
      ]),
  ],
]);

/** Schemas that hold no other schema, and so read the same either way. */
const LEAVES = new Set([
  "any",
  "bigint",
  "boolean",
  "custom",
  "date",
  "enum",
  "literal",
  "nan",
  "never",
  "null",
  "number",
  "string",
  "symbol",
  "template_literal",
  "transform",
  "undefined",
  "unknown",
  "void",
]);

/** Kinds that wrap one schema under `innerType`. */
const WRAPPERS = new Set([
  "catch",
  "default",
  "nonoptional",
  "nullable",
  "optional",
  "prefault",
  "readonly",
]);

// Cloning by definition keeps every refinement the closed schema carries; only
// the parts named here are replaced.
const withoutUnknownFields = (schema: z.ZodType): z.ZodType => {
  const def = schema._zod.def as z.core.$ZodTypeDef & Record<string, unknown>;
  const clone = (changes: Record<string, unknown>) =>
    schema.clone({ ...def, ...changes } as typeof schema._zod.def);

  if (LEAVES.has(def.type)) return schema;
  if (WRAPPERS.has(def.type)) return clone({ innerType: reader(def.innerType as z.ZodType) });

  switch (def.type) {
    case "object": {
      const shape = def.shape as Record<string, z.ZodType>;
      return clone({
        shape: Object.fromEntries(Object.entries(shape).map(([key, part]) => [key, reader(part)])),
        catchall: undefined,
      });
    }
    case "array":
      return clone({ element: reader(def.element as z.ZodType) });
    case "union": {
      const options = (def.options as z.ZodType[]).map(reader);
      return clone({
        options: def.discriminator === undefined ? refusingSiblingFields(options) : options,
      });
    }
    case "record":
      return clone({ valueType: reader(def.valueType as z.ZodType) });
    case "pipe":
      return clone({ in: reader(def.in as z.ZodType), out: reader(def.out as z.ZodType) });
    default:
      // A kind this walk does not know might hold a closed object it would
      // leave closed, so it is refused where the reader is made, not later.
      throw new TypeError(`a reader cannot be made of a schema of the kind ${def.type}`);
  }
};

/**
 * Closed, the objects of a plain union tell apart by their fields; dropping
 * unknown fields would let a document that fails the wider option pass as a
 * narrower one, with what only the wider one names thrown away. So each object
 * option refuses the fields only its siblings name.
 */
const refusingSiblingFields = (options: readonly z.ZodType[]): z.ZodType[] => {
  const fieldsOf = (option: z.ZodType): string[] | null => {
    const def = option._zod.def as z.core.$ZodTypeDef & { shape?: Record<string, z.ZodType> };
    return def.type === "object" && def.shape !== undefined ? Object.keys(def.shape) : null;
  };
  const named = new Set(options.flatMap((option) => fieldsOf(option) ?? []));

  return options.map((option) => {
    const own = fieldsOf(option);
    if (own === null) return option;
    const theirs = [...named].filter((field) => !own.includes(field));
    if (theirs.length === 0) return option;
    const def = option._zod.def as z.core.$ZodTypeDef & { shape: Record<string, z.ZodType> };
    return option.clone({
      ...def,
      shape: {
        ...def.shape,
        ...Object.fromEntries(theirs.map((field) => [field, z.never().optional()])),
      },
    } as typeof option._zod.def);
  });
};

const made = new WeakMap<z.ZodType, z.ZodType>();

const reader = (schema: z.ZodType): z.ZodType => {
  const known = made.get(schema);
  if (known !== undefined) return known;
  const built = OPENED_ON_READING.get(schema)?.() ?? withoutUnknownFields(schema);
  made.set(schema, built);
  return built;
};

/**
 * The reader of a merchant's answer this package describes: the closed schema,
 * with every object taking fields added later and dropping them from what it
 * returns, and the words above opened. The storefront's documents are open in
 * their own schemas and are read with those. One schema always gets the same
 * reader, so asking on every call costs nothing after the first. A schema
 * holding a kind of part this function does not know is refused when the
 * reader is made.
 */
export const readerOf = <Schema extends z.ZodType>(
  schema: Schema,
): z.ZodType<Read<z.output<Schema>>> => reader(schema) as z.ZodType<Read<z.output<Schema>>>;

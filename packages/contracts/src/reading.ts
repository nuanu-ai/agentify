/**
 * How a reader takes what a gateway sends, which is not how a gateway writes
 * it. The schemas in this package are the writing contract and are closed, so
 * a field the gateway was never meant to send is refused on the gateway's side.
 * A reader made here from one of them ignores fields it does not know at any
 * depth, reads an order's status or payment word it does not know as
 * `unknown`, and reads an event of a kind it does not know, or one it cannot
 * read, as `{ type: "unknown", named }`, so a consumer can skip it and keep
 * the rest of the answer. Everything the closed schema requires, it still
 * requires.
 */

import { z } from "zod";
import { type OrderEvent, OrderEventSchema } from "./events.js";
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

const wordOrUnknown = (words: z.ZodType<string>) =>
  z.string().transform((word) => (words.safeParse(word).success ? word : UNKNOWN_WORD));

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
          .looseObject({ type: z.string() })
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
    case "union":
      return clone({ options: (def.options as z.ZodType[]).map(reader) });
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

const made = new WeakMap<z.ZodType, z.ZodType>();

const reader = (schema: z.ZodType): z.ZodType => {
  const known = made.get(schema);
  if (known !== undefined) return known;
  const built = OPENED_ON_READING.get(schema)?.() ?? withoutUnknownFields(schema);
  made.set(schema, built);
  return built;
};

/**
 * The reader of a document this package describes: the closed schema, with
 * every object taking fields added later and dropping them from what it
 * returns, and the words above opened. One schema always gets the same reader,
 * so asking on every call costs nothing after the first. A schema holding a
 * kind of part this function does not know is refused when the reader is made.
 */
export const readerOf = <Schema extends z.ZodType>(
  schema: Schema,
): z.ZodType<Read<z.output<Schema>>> => reader(schema) as z.ZodType<Read<z.output<Schema>>>;

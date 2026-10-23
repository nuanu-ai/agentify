/**
 * How a reader takes what a gateway sends, which is not how a gateway writes
 * it. The schemas in this package are the writing contract and are closed, so
 * a field the gateway was never meant to send is refused on the gateway's side.
 *
 * A reader made here from one of them ignores fields it does not know at any
 * depth of what only informs, reads an order's status or payment word, an
 * event's reason, a call's result word or a price question's purpose it does
 * not know as `unknown`, and reads an event of a kind it does not know as
 * `{ type: "unknown", named }`, so a consumer can skip it and keep the rest of
 * the answer. What an order delivers stays closed, off the stream and read
 * back: a field or a shape there it does not know fails the order, because
 * dropping it would deliver the order wrongly without a word. One order read
 * back fails with it; in a list of orders and on the worker stream, only that
 * order or message is marked unread, so the orders beside it, and the version
 * of a poll answer, are still read. Everything the closed schema requires, it
 * still requires.
 */

import { z } from "zod";
import {
  type OrderList,
  OrderListSchema,
  type OrderWithStatus,
  OrderWithStatusSchema,
} from "./api.js";
import { type WorkerEnvelope, WorkerEnvelopeSchema } from "./envelope.js";
import {
  ORDER_EVENT_TYPES,
  type OrderEvent,
  OrderEventSchema,
  type UnfulfilledReason,
  UnfulfilledReasonSchema,
} from "./events.js";
import { OrderSchema } from "./order.js";
import {
  type OrderStatus,
  OrderStatusSchema,
  type PaymentStatus,
  PaymentStatusSchema,
} from "./order-status.js";
import { type QuotePurpose, QuotePurposeSchema } from "./quote.js";
import { type OrderCallResult, OrderCallResultSchema } from "./results.js";

/** The word a reader puts in place of a word or an event kind it was not built with. */
export const UNKNOWN_WORD = "unknown";

export type UnknownWord = typeof UNKNOWN_WORD;

/** An event this reader could not read, with the kind it said it was and its order. */
export interface UnreadEvent {
  readonly type: UnknownWord;
  readonly named: string;
  readonly order_id?: string;
}

/**
 * A message on the worker stream this reader could not read: one of a kind it
 * does not know, or one whose payload does not fit, such as an order carrying
 * a field added after this reader was built. It names the kind the message
 * said it was (empty when it said none), the order or price question it is
 * about where that could be read, and the schema's findings. A finding's
 * `message` may hold the value that failed, so it is not for a log.
 */
export interface UnreadEnvelope {
  readonly kind: UnknownWord;
  readonly named: string;
  readonly subject?: string;
  readonly issues: readonly z.core.$ZodIssue[];
}

/**
 * An order in a list this reader could not read, such as one carrying a field
 * added after this reader was built: its identifier where that could be read,
 * and the schema's findings, whose `message` may hold the value that failed.
 */
export interface UnreadOrder {
  readonly kind: UnknownWord;
  readonly subject?: string;
  readonly issues: readonly z.core.$ZodIssue[];
}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Opened<T> =
  Same<T, OrderStatus> extends true
    ? true
    : Same<T, PaymentStatus> extends true
      ? true
      : Same<T, UnfulfilledReason> extends true
        ? true
        : Same<T, OrderCallResult> extends true
          ? true
          : Same<T, QuotePurpose> extends true
            ? true
            : false;

type ReadEach<T> = T extends readonly (infer Each)[]
  ? Read<Each>[]
  : T extends object
    ? { [Key in keyof T]: Read<T[Key]> }
    : T;

/** The shape a reader gives a document whose closed shape is `T`. */
export type Read<T> =
  Opened<T> extends true
    ? T | UnknownWord
    : Same<T, OrderEvent> extends true
      ? ReadEach<T> | UnreadEvent
      : Same<T, WorkerEnvelope> extends true
        ? ReadEach<T> | UnreadEnvelope
        : Same<T, OrderList> extends true
          ? { orders: (Read<OrderWithStatus> | UnreadOrder)[] }
          : ReadEach<T>;

const aWord = () => z.string().regex(/\S/, "a word is not blank");

const wordOrUnknown = (words: z.ZodType<string>) =>
  aWord().transform((word) => (words.safeParse(word).success ? word : UNKNOWN_WORD));

/** What an envelope that did not fit says it was about, read with no schema. */
const unreadEnvelope = (sent: unknown, issues: readonly z.core.$ZodIssue[]): UnreadEnvelope => {
  const { kind, payload } = (typeof sent === "object" && sent !== null ? sent : {}) as {
    kind?: unknown;
    payload?: { id?: unknown; order_id?: unknown; price_id?: unknown };
  };
  const subject =
    kind === "order"
      ? payload?.id
      : kind === "order_event"
        ? payload?.order_id
        : kind === "quote_request"
          ? payload?.price_id
          : undefined;

  return {
    kind: UNKNOWN_WORD,
    named: typeof kind === "string" ? kind : "",
    ...(typeof subject === "string" ? { subject } : {}),
    issues,
  };
};

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(ORDER_EVENT_TYPES));

const READ_AS: ReadonlyMap<z.ZodType, () => z.ZodType> = new Map<z.ZodType, () => z.ZodType>([
  // What an order delivers is read as it is written.
  [OrderSchema, () => OrderSchema],
  [
    OrderWithStatusSchema,
    () =>
      OrderWithStatusSchema.extend({
        status: reader(OrderStatusSchema),
        payment_status: reader(PaymentStatusSchema),
        merchant_closure: reader(OrderWithStatusSchema.shape.merchant_closure),
      }),
  ],
  [
    WorkerEnvelopeSchema,
    () => {
      const known = withoutUnknownFields(WorkerEnvelopeSchema);
      return z.unknown().transform((sent) => {
        const read = known.safeParse(sent);
        return read.success ? read.data : unreadEnvelope(sent, read.error.issues);
      });
    },
  ],
  [
    OrderListSchema,
    () => {
      const each = reader(OrderWithStatusSchema);
      return z.object({
        orders: z.array(
          z.unknown().transform((sent): unknown => {
            const read = each.safeParse(sent);
            if (read.success) return read.data;
            const id = (sent as { id?: unknown } | null)?.id;
            const unread: UnreadOrder = {
              kind: UNKNOWN_WORD,
              ...(typeof id === "string" ? { subject: id } : {}),
              issues: read.error.issues,
            };
            return unread;
          }),
        ),
      });
    },
  ],
  [OrderStatusSchema, () => wordOrUnknown(OrderStatusSchema)],
  [PaymentStatusSchema, () => wordOrUnknown(PaymentStatusSchema)],
  [UnfulfilledReasonSchema, () => wordOrUnknown(UnfulfilledReasonSchema)],
  [OrderCallResultSchema, () => wordOrUnknown(OrderCallResultSchema)],
  [QuotePurposeSchema, () => wordOrUnknown(QuotePurposeSchema)],
  [
    OrderEventSchema,
    () => {
      const known = withoutUnknownFields(OrderEventSchema);
      const ofAnotherKind = z.looseObject({ type: aWord(), order_id: z.unknown() }).transform(
        ({ type, order_id }): UnreadEvent => ({
          type: UNKNOWN_WORD,
          named: type,
          ...(typeof order_id === "string" ? { order_id } : {}),
        }),
      );
      // The kind decides which shape an event is held to, so a known event
      // that fails is reported where its own shape failed, never as a kind
      // that looked unfamiliar.
      return z.unknown().transform((sent, ctx) => {
        const type = (sent as { type?: unknown } | null)?.type;
        const read = (
          typeof type === "string" && KNOWN_EVENT_TYPES.has(type) ? known : ofAnotherKind
        ).safeParse(sent);
        if (read.success) return read.data;
        for (const issue of read.error.issues) ctx.addIssue({ ...issue });
        return z.NEVER;
      });
    },
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
  const built = READ_AS.get(schema)?.() ?? withoutUnknownFields(schema);
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

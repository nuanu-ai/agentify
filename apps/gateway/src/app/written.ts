/**
 * The storefront's documents as this gateway writes them: closed.
 *
 * An agent reads the catalog, a card and an order's status with the contract's
 * open schemas, which take fields and words added later at every depth
 * (ADR-0006 §5): the storefront has no version, and a reader built before an
 * addition has to read past it rather than refuse. What goes out is held to
 * the opposite rule — the fields this version names and no others, and only
 * the words it knows — because the outbound check is the last place one of
 * these documents is seen before every agent reads it, and so the last place a
 * merchant's own key, the address of their price check or a buyer's parameters
 * could be stopped in one. It used to be the contract's own schema, and when
 * the reader opened, that check opened with it. The payment challenge is not
 * one of these documents: it is built field by field from the merchant's
 * closed card, and goes out without this check.
 *
 * One thing no check here can see is a key named `__proto__`, which zod skips
 * rather than refuses. It is safe only because nothing stored carries one:
 * every door that takes a document drops it first (`PROTOTYPE_KEY_IS_DROPPED`
 * in the contracts).
 *
 * Each closed document is the open one with its words narrowed, its fields
 * shut and its parts swapped for the merchant's own closed shapes of them, so
 * the two cannot name different fields: a field added to what an agent reads is
 * a field this gateway may write, and nothing else is. The parts have to be
 * named one by one, because an agent reads them open too; a test walks every
 * route's checks and finds a form shut at every depth among them.
 */

import {
  AgentOrderStatusSchema,
  CatalogPageSchema,
  type Delivery,
  MoneySchema,
  OrderStatusSchema,
  ParamNameSchema,
  ParamSpecSchema,
  PublicCardSchema,
  RecordedShipmentSchema,
  RefusalSchema,
  SalePriceSchema,
  SellerSchema,
  TimestampSchema,
} from "@nuanu-ai/agentify-contracts";
import { type ZodType, z } from "zod";

const writtenCardFields = PublicCardSchema.extend({
  price: MoneySchema,
  params: ParamSpecSchema.optional(),
  result: ParamSpecSchema,
  seller: SellerSchema,
}).omit({ fulfillment: true, fulfill_deadline_seconds: true, confirm_deadline_seconds: true });

const deadline = z.int().positive().optional();

/**
 * A card as this gateway writes it: one branch per mode it knows, so a wait the
 * mode never has is refused here rather than claimed to an agent, and one an
 * agent can read, so a card is never sent that every agent would pass over.
 */
const WrittenCardSchema = z
  .discriminatedUnion("fulfillment", [
    writtenCardFields.extend({ fulfillment: z.literal("sync") }).strict(),
    writtenCardFields
      .extend({ fulfillment: z.literal("async"), fulfill_deadline_seconds: deadline })
      .strict(),
    writtenCardFields
      .extend({
        fulfillment: z.literal("confirm"),
        confirm_deadline_seconds: deadline,
        fulfill_deadline_seconds: deadline,
      })
      .strict(),
    // A parcel names its time to ship and no result: what its buyer receives
    // is the record of its shipment (ADR-0033).
    writtenCardFields
      .omit({ result: true })
      .extend({ fulfillment: z.literal("ship"), ship_within_seconds: z.int().positive() })
      .strict(),
  ])
  .superRefine((card, context) => {
    const read = PublicCardSchema.safeParse(card);
    if (!read.success) {
      context.addIssue({
        code: "custom",
        message: `an agent could not read this card: ${read.error.issues.map((issue) => issue.message).join("; ")}`,
      });
    }
  });

/**
 * Goods as this gateway hands them over: the names are the card's and cannot
 * be listed here, but each value is what a declared field carries — a string,
 * a number or a boolean — so nothing else rides out under one of those names.
 */
const WrittenDeliverySchema = z.record(
  ParamNameSchema,
  z.union([z.string(), z.number(), z.boolean()]),
);

/**
 * An order's status as this gateway writes it, and its goods only where the
 * status says they are the buyer's: on any other word there is nothing here to
 * hand over, and something in that field would be whatever a mistake put there.
 */
const WrittenOrderStatusSchema = AgentOrderStatusSchema.extend({
  status: OrderStatusSchema,
  price: SalePriceSchema.nullable(),
  delivered: WrittenDeliverySchema.nullable(),
  shipment: RecordedShipmentSchema.nullable().optional(),
  ship_by: TimestampSchema.nullable().optional(),
  refusal: RefusalSchema.optional(),
  seller: SellerSchema,
})
  .strict()
  .superRefine((written, context) => {
    if (written.delivered !== null && written.status !== "delivered") {
      context.addIssue({
        code: "custom",
        path: ["delivered"],
        message: `an order whose status is "${written.status}" hands over no goods`,
      });
    }
    // The same rule for a parcel: its shipment is said where its status says
    // it shipped, and nowhere else (ADR-0033).
    if (
      written.shipment !== undefined &&
      written.shipment !== null &&
      written.status !== "shipped"
    ) {
      context.addIssue({
        code: "custom",
        path: ["shipment"],
        message: `an order whose status is "${written.status}" carries no shipment`,
      });
    }
  });

/**
 * An order's status as this gateway answers with it. The goods are typed as
 * they are stored, since what the merchant handed over was held to the card's
 * result when it arrived; that each value is one a declared field carries is
 * checked again before sending.
 */
export type WrittenOrderStatus = Omit<z.infer<typeof WrittenOrderStatusSchema>, "delivered"> & {
  readonly delivered: Delivery | null;
};

const WRITTEN_AS: ReadonlyMap<ZodType, ZodType> = new Map<ZodType, ZodType>([
  [CatalogPageSchema, z.strictObject({ items: z.array(WrittenCardSchema) })],
  [AgentOrderStatusSchema, WrittenOrderStatusSchema],
]);

/**
 * Every check a route's document passes before this gateway sends it.
 *
 * The route's own document comes first, which is what the reader on the other
 * side holds it to: nothing goes out that its reader would refuse. A storefront
 * document then meets its closed form, since what an agent reads open cannot
 * refuse a field that leaked. Every other document is the merchant's and is
 * closed already, so its own schema is both checks at once.
 */
export const checksBeforeSending = (document: ZodType): readonly ZodType[] => {
  const closed = WRITTEN_AS.get(document);
  return closed === undefined ? [document] : [document, closed];
};

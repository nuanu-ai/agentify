/**
 * The storefront's documents as this gateway writes them: closed. Agents read
 * the catalog, a card and an order's status with the contract's open schemas,
 * which accept fields and words added later, so the outbound check here is the
 * last place a leaked merchant key, price-check address or buyer's parameters
 * can be stopped. Each closed form is the open one narrowed, with every nested
 * part swapped for its closed shape by name, because a nested part left as it
 * is stays open. The payment challenge is built field by field from the
 * merchant's closed card and does not pass through this check.
 *
 * Zod skips rather than refuses a key named `__proto__`, so no check here sees
 * one; that is safe only because every door that takes a document drops it
 * first (`PROTOTYPE_KEY_IS_DROPPED` in the contracts).
 */

import {
  AgentOrderStatusSchema,
  CatalogPageSchema,
  type Delivery,
  MoneySchema,
  OrderEndingReasonSchema,
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
 * One branch per mode, so a deadline the mode does not have is refused here
 * rather than claimed to an agent; the card must also pass the agent's open
 * schema, so no card goes out that every agent would pass over.
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
    // is the record of its shipment.
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
 * The field names are the card's and cannot be listed here, but each value must
 * be a string, a number or a boolean, so nothing else rides out under a name.
 */
const WrittenDeliverySchema = z.record(
  ParamNameSchema,
  z.union([z.string(), z.number(), z.boolean()]),
);

/**
 * Goods go out only under the status that makes them the buyer's; anything in
 * that field under another status is a mistake.
 */
const WrittenOrderStatusSchema = AgentOrderStatusSchema.extend({
  status: OrderStatusSchema,
  price: SalePriceSchema.nullable(),
  delivered: WrittenDeliverySchema.nullable(),
  shipment: RecordedShipmentSchema.nullable().optional(),
  ship_by: TimestampSchema.nullable().optional(),
  refusal: RefusalSchema.optional(),
  reason: z
    .strictObject({
      code: OrderEndingReasonSchema,
      message: z.string().regex(/\S/),
    })
    .optional(),
  seller: SellerSchema,
})
  .strict()
  .superRefine((written, context) => {
    // Our own reason is said only where the status word blurs what to do next,
    // and never in the same breath as a merchant's refusal.
    if (written.reason !== undefined) {
      if (written.status !== "rejected" && written.status !== "expired") {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: `an order whose status is "${written.status}" carries no reason`,
        });
      }
      if (written.refusal !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "a merchant's refusal is the whole answer and carries no reason of ours",
        });
      }
    }
    if (written.delivered !== null && written.status !== "delivered") {
      context.addIssue({
        code: "custom",
        path: ["delivered"],
        message: `an order whose status is "${written.status}" hands over no goods`,
      });
    }
    // The same rule for a parcel: its shipment is said where its status says
    // it shipped, and nowhere else.
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
 * The goods are typed as stored, since what the merchant handed over was held
 * to the card's result when it arrived; that each value is one a declared field
 * carries is checked again before sending.
 */
export type WrittenOrderStatus = Omit<z.infer<typeof WrittenOrderStatusSchema>, "delivered"> & {
  readonly delivered: Delivery | null;
};

const WRITTEN_AS: ReadonlyMap<ZodType, ZodType> = new Map<ZodType, ZodType>([
  [CatalogPageSchema, z.strictObject({ items: z.array(WrittenCardSchema) })],
  [AgentOrderStatusSchema, WrittenOrderStatusSchema],
]);

/**
 * Every check a route's document passes before this gateway sends it. The
 * route's own schema comes first, since that is what its reader holds it to;
 * a storefront document then meets its closed form, because the open one cannot
 * refuse a leaked field. Every other document is the merchant's and is closed
 * already, so its own schema is both checks.
 */
export const checksBeforeSending = (document: ZodType): readonly ZodType[] => {
  const closed = WRITTEN_AS.get(document);
  return closed === undefined ? [document] : [document, closed];
};

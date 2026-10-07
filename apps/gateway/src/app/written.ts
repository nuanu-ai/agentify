/**
 * The storefront's documents as this gateway writes them: closed.
 *
 * An agent reads the catalog, a card and an order's status with the contract's
 * open schemas, which take fields and words added later at every depth
 * (ADR-0006 §5): the storefront has no version, and a reader built before an
 * addition has to read past it rather than refuse. What goes out is held to
 * the opposite rule — the fields this version names and no others, and only
 * the words it knows — because the outbound check is the last place a
 * merchant's own key, the address of their price check or a buyer's parameters
 * could be stopped before every agent reads them. It used to be the contract's
 * own schema, and when the reader opened, that check opened with it.
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
  MoneySchema,
  OrderStatusSchema,
  ParamSpecSchema,
  PublicCardSchema,
  RefusalSchema,
  SalePriceSchema,
  SellerSchema,
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

const WrittenOrderStatusSchema = AgentOrderStatusSchema.extend({
  status: OrderStatusSchema,
  price: SalePriceSchema.nullable(),
  refusal: RefusalSchema.optional(),
  seller: SellerSchema,
}).strict();

/** An order's status as this gateway answers with it. */
export type WrittenOrderStatus = z.infer<typeof WrittenOrderStatusSchema>;

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

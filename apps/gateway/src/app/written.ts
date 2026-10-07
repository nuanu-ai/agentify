/**
 * The storefront's documents as this gateway writes them: closed.
 *
 * An agent reads the catalog, a card and an order's status with the contract's
 * open schemas, which take fields and words added later (ADR-0006 §5): the
 * storefront has no version, and a reader built before an addition has to read
 * past it rather than refuse. What goes out is held to the opposite rule — the
 * fields this version names and no others, and only the words it knows —
 * because the outbound check is the last place a merchant's own key, the
 * address of their price check or a buyer's parameters could be stopped before
 * every agent reads them. It used to be the contract's own schema, and when
 * the reader opened, that check opened with it.
 *
 * Each closed document is the open one with its words narrowed, its fields
 * shut and its parts swapped for the merchant's own closed shapes of them, so
 * the two cannot name different fields: a field added to what an agent reads is
 * a field this gateway may write, and nothing else is. The parts have to be
 * named one by one, because an agent reads them open too; a test walks both
 * documents and finds every object in them shut.
 */

import {
  AgentOrderStatusSchema,
  CatalogPageSchema,
  FulfillmentSchema,
  MoneySchema,
  OrderStatusSchema,
  ParamSpecSchema,
  PublicCardSchema,
  RefusalSchema,
  SalePriceSchema,
  SellerSchema,
} from "@nuanu-ai/agentify-contracts";
import { type ZodType, z } from "zod";

const WrittenCardSchema = PublicCardSchema.extend({
  price: MoneySchema,
  params: ParamSpecSchema.optional(),
  result: ParamSpecSchema,
  seller: SellerSchema,
  fulfillment: FulfillmentSchema,
}).strict();

const WrittenOrderStatusSchema = AgentOrderStatusSchema.extend({
  status: OrderStatusSchema,
  price: SalePriceSchema.nullable(),
  refusal: RefusalSchema.optional(),
  seller: SellerSchema,
}).strict();

/** An order's status as this gateway answers with it. */
export type WrittenOrderStatus = z.infer<typeof WrittenOrderStatusSchema>;

/**
 * The closed document a response is held to in place of the open one its route
 * names, keyed by the open one: every route that answers with a storefront
 * document is held closed, whichever route it is.
 */
export const WRITTEN_AS: ReadonlyMap<ZodType, ZodType> = new Map<ZodType, ZodType>([
  [CatalogPageSchema, z.strictObject({ items: z.array(WrittenCardSchema) })],
  [AgentOrderStatusSchema, WrittenOrderStatusSchema],
]);

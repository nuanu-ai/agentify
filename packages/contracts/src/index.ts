/**
 * Agentify contracts: the zod schemas for the card, the order, the price check,
 * the receipt and everything else that crosses the boundary between Agentify,
 * a merchant and an agent. Types are inferred from the schemas, and
 * `toJsonSchemas` renders them for readers outside TypeScript.
 *
 * The worker envelope and the route table are described here too, although no
 * merchant reads them directly: they are the format between the gateway and the
 * SDK, which both read.
 */

import type { ZodType } from "zod";
import { z } from "zod";
import {
  AgentOrderStatusSchema,
  CatalogPageSchema,
  ErrorEnvelopeSchema,
  MerchantCardListSchema,
  OrderAcceptResponseSchema,
  OrderCallResponseSchema,
  OrderCloseResponseSchema,
  OrderListQuerySchema,
  OrderListSchema,
  OrderWithStatusSchema,
  PurchaseRequestSchema,
  QuoteAnswerAckSchema,
  ReceiptListSchema,
  WorkerPollRequestSchema,
  WorkerPollResponseSchema,
} from "./api.js";
import {
  CardSchema,
  FulfillmentSchema,
  MerchantCardSchema,
  PriceCheckSchema,
  PublicCardSchema,
  SellerSchema,
  ServiceNameSchema,
  TagsSchema,
} from "./card.js";
import { MerchantClosureSchema, OrderCloseRequestSchema } from "./closure.js";
import { WorkerEnvelopeSchema } from "./envelope.js";
import { OrderEventSchema, UnfulfilledReasonSchema } from "./events.js";
import { EvmAddressSchema } from "./evm-address.js";
import {
  AcceptanceSchema,
  DeliverySchema,
  HandlerAnswerSchema,
  RefusalCodeSchema,
  RefusalSchema,
} from "./handler.js";
import {
  PayoutWalletSchema,
  PendingPayoutWalletSchema,
  SellerNameRequestSchema,
  SellerNameSchema,
} from "./merchant.js";
import { OrderSchema } from "./order.js";
import { OrderEndingReasonSchema, OrderStatusSchema, PaymentStatusSchema } from "./order-status.js";
import {
  FieldSpecSchema,
  ParamNameSchema,
  ParamSpecSchema,
  ParamTypeSchema,
} from "./param-spec.js";
import {
  AmountSchema,
  CurrencyCodeSchema,
  IdentifierSchema,
  MoneySchema,
  OpenWordSchema,
  SalePriceSchema,
  TimestampSchema,
} from "./primitives.js";
import { QuotePurposeSchema, QuoteRequestSchema, QuoteResponseSchema } from "./quote.js";
import { ReceiptOutcomeSchema, ReceiptSchema } from "./receipt.js";
import {
  CallErrorSchema,
  OrderCallResultSchema,
  ProblemSchema,
  PublishResultSchema,
} from "./results.js";
import { SellerSiteSchema } from "./seller-site.js";
import { SellingStateSchema } from "./selling.js";
import { ErasedShipToSchema, ShipToLocalitySchema, ShipToSchema } from "./ship-to.js";
import { RecordedShipmentSchema, ShipmentSchema } from "./shipment.js";

export type {
  AgentOrderStatus,
  AuthMode,
  CatalogPage,
  ErrorCode,
  ErrorEnvelope,
  HttpMethod,
  MerchantCardList,
  OrderAcceptResponse,
  OrderCallResponse,
  OrderCloseResponse,
  OrderList,
  OrderListQuery,
  OrderWithStatus,
  PurchaseRequest,
  QuoteAnswerAck,
  ReceiptList,
  RouteDefinition,
  RouteName,
  RouteResponse,
  WorkerPollRequest,
  WorkerPollResponse,
} from "./api.js";
export {
  AgentOrderStatusSchema,
  API_ROUTES,
  AUTH_MODES,
  CatalogPageSchema,
  cardsOf,
  ERROR_CODES,
  ErrorEnvelopeSchema,
  expandPath,
  HTTP_METHODS,
  MERCHANT_KEY_HEADER,
  MerchantCardListSchema,
  merchantKeyFrom,
  merchantKeyHeaderValue,
  mountableRoutes,
  OrderAcceptResponseSchema,
  OrderCallResponseSchema,
  OrderCloseResponseSchema,
  OrderListQuerySchema,
  OrderListSchema,
  OrderWithStatusSchema,
  PurchaseRequestSchema,
  pathParamsOf,
  QuoteAnswerAckSchema,
  ReceiptListSchema,
  WorkerPollRequestSchema,
  WorkerPollResponseSchema,
} from "./api.js";
export type {
  BazaarDeclaration,
  Card,
  CardInput,
  Fulfillment,
  MerchantCard,
  PriceCheck,
  ProjectedCard,
  PublicCard,
  Seller,
} from "./card.js";
export {
  bazaarDeclarationOf,
  CardSchema,
  deliveryCheckFor,
  FulfillmentSchema,
  MerchantCardSchema,
  PriceCheckSchema,
  PublicCardSchema,
  publicCardOf,
  purchaseCheckFor,
  SellerSchema,
  ServiceNameSchema,
  TagsSchema,
} from "./card.js";
export type { MerchantClosure, OrderCloseRequest } from "./closure.js";
export { MerchantClosureSchema, OrderCloseRequestSchema } from "./closure.js";
export type { WorkerEnvelope, WorkerEnvelopeKind } from "./envelope.js";
export {
  WORKER_ENVELOPE_KINDS,
  WORKER_ENVELOPE_PAYLOADS,
  WorkerEnvelopeSchema,
} from "./envelope.js";
export type { OrderEvent, UnfulfilledReason } from "./events.js";
export { ORDER_EVENT_TYPES, OrderEventSchema, UnfulfilledReasonSchema } from "./events.js";
export type { EvmAddress } from "./evm-address.js";
export { checksummedAddressOf, EvmAddressSchema } from "./evm-address.js";
export type { Acceptance, Delivery, HandlerAnswer, Refusal, RefusalCode } from "./handler.js";
export {
  AcceptanceSchema,
  DeliverySchema,
  HandlerAnswerSchema,
  RECOMMENDED_REFUSAL_CODES,
  RefusalCodeSchema,
  RefusalSchema,
} from "./handler.js";
export type {
  PayoutWallet,
  PendingPayoutWallet,
  SellerName,
  SellerNameRequest,
} from "./merchant.js";
export {
  PayoutWalletSchema,
  PendingPayoutWalletSchema,
  SellerNameRequestSchema,
  SellerNameSchema,
} from "./merchant.js";
export type { Order } from "./order.js";
export { OrderSchema } from "./order.js";
export type { OrderStatus, PaymentStatus } from "./order-status.js";
export {
  ORDER_ENDING_REASONS,
  ORDER_STATUSES,
  OrderEndingReasonSchema,
  OrderStatusSchema,
  PaymentStatusSchema,
} from "./order-status.js";
export type {
  FieldSpec,
  FieldSpecInput,
  ParamSpec,
  ParamSpecDirection,
  ParamSpecInput,
  ParamType,
} from "./param-spec.js";
export {
  FieldSpecSchema,
  ParamNameSchema,
  ParamSpecSchema,
  ParamTypeSchema,
  PROTOTYPE_KEY_IS_DROPPED,
  paramSpecToValidator,
} from "./param-spec.js";
export type { TextLines } from "./plain-text.js";
export { notPlainTextIn } from "./plain-text.js";
export { PAYABLE_CURRENCIES, PAYABLE_DECIMALS, priceProblemsOf } from "./price-rule.js";
export type {
  Amount,
  CurrencyCode,
  Identifier,
  Money,
  OpenWord,
  SalePrice,
  Timestamp,
} from "./primitives.js";
export {
  AmountSchema,
  CurrencyCodeSchema,
  IdentifierSchema,
  MoneySchema,
  OpenWordSchema,
  SalePriceSchema,
  TimestampSchema,
} from "./primitives.js";
export type { QuotePurpose, QuoteRequest, QuoteResponse } from "./quote.js";
export { QuotePurposeSchema, QuoteRequestSchema, QuoteResponseSchema } from "./quote.js";
export type { Receipt, ReceiptOutcome } from "./receipt.js";
export { ReceiptOutcomeSchema, ReceiptSchema } from "./receipt.js";
export type {
  CallError,
  MerchantFinding,
  OrderCallResult,
  Problem,
  PublishResult,
} from "./results.js";
export {
  CARD_REJECTED,
  CallErrorSchema,
  MERCHANT_FINDINGS,
  ORDER_CALL_ERROR_CODES,
  ORDER_CALL_RESULTS,
  OrderCallResultSchema,
  ProblemSchema,
  PublishResultSchema,
} from "./results.js";
export { SellerSiteSchema } from "./seller-site.js";
export type { SellingState } from "./selling.js";
export { SELLING_STATES, SellingStateSchema } from "./selling.js";
export type { ErasedShipTo, ShipTo, ShipToLocality } from "./ship-to.js";
export {
  ErasedShipToSchema,
  localityOf,
  ShipToLocalitySchema,
  ShipToSchema,
} from "./ship-to.js";
export type { RecordedShipment, Shipment } from "./shipment.js";
export { RecordedShipmentSchema, ShipmentSchema } from "./shipment.js";

/**
 * The version of the public contract. It grows when the meaning of the fields
 * changes, not when a schema is added: a consumer uses it to decide whether it
 * understands the other side.
 */
export const CONTRACT_VERSION = "2";

/**
 * Every schema of the public contract, under the name it is known by outside
 * TypeScript. The JSON Schema export walks this registry, and it carries the
 * building blocks as well as the whole documents, so a single amount can be
 * validated without lifting it out of a card.
 */
export const schemas = Object.freeze({
  acceptance: AcceptanceSchema,
  agent_order_status: AgentOrderStatusSchema,
  amount: AmountSchema,
  call_error: CallErrorSchema,
  card: CardSchema,
  catalog_page: CatalogPageSchema,
  currency_code: CurrencyCodeSchema,
  delivery: DeliverySchema,
  erased_ship_to: ErasedShipToSchema,
  error_envelope: ErrorEnvelopeSchema,
  evm_address: EvmAddressSchema,
  field_spec: FieldSpecSchema,
  fulfillment: FulfillmentSchema,
  handler_answer: HandlerAnswerSchema,
  identifier: IdentifierSchema,
  merchant_card: MerchantCardSchema,
  merchant_card_list: MerchantCardListSchema,
  money: MoneySchema,
  open_word: OpenWordSchema,
  order: OrderSchema,
  order_accept_response: OrderAcceptResponseSchema,
  order_call_response: OrderCallResponseSchema,
  order_call_result: OrderCallResultSchema,
  order_close_request: OrderCloseRequestSchema,
  order_close_response: OrderCloseResponseSchema,
  order_event: OrderEventSchema,
  order_list: OrderListSchema,
  order_list_query: OrderListQuerySchema,
  order_status: OrderStatusSchema,
  order_ending_reason: OrderEndingReasonSchema,
  order_with_status: OrderWithStatusSchema,
  payment_status: PaymentStatusSchema,
  merchant_closure: MerchantClosureSchema,
  param_name: ParamNameSchema,
  param_spec: ParamSpecSchema,
  param_type: ParamTypeSchema,
  payout_wallet: PayoutWalletSchema,
  pending_payout_wallet: PendingPayoutWalletSchema,
  price_check: PriceCheckSchema,
  problem: ProblemSchema,
  public_card: PublicCardSchema,
  publish_result: PublishResultSchema,
  purchase_request: PurchaseRequestSchema,
  quote_answer_ack: QuoteAnswerAckSchema,
  quote_purpose: QuotePurposeSchema,
  quote_request: QuoteRequestSchema,
  quote_response: QuoteResponseSchema,
  receipt: ReceiptSchema,
  receipt_list: ReceiptListSchema,
  receipt_outcome: ReceiptOutcomeSchema,
  unfulfilled_reason: UnfulfilledReasonSchema,
  refusal: RefusalSchema,
  refusal_code: RefusalCodeSchema,
  sale_price: SalePriceSchema,
  seller: SellerSchema,
  seller_name: SellerNameSchema,
  seller_name_request: SellerNameRequestSchema,
  selling_state: SellingStateSchema,
  seller_site: SellerSiteSchema,
  service_name: ServiceNameSchema,
  ship_to: ShipToSchema,
  ship_to_locality: ShipToLocalitySchema,
  shipment: ShipmentSchema,
  recorded_shipment: RecordedShipmentSchema,
  tags: TagsSchema,
  timestamp: TimestampSchema,
  worker_envelope: WorkerEnvelopeSchema,
  worker_poll_request: WorkerPollRequestSchema,
  worker_poll_response: WorkerPollResponseSchema,
}) satisfies Readonly<Record<string, ZodType>>;

/** The name of one schema in the registry. */
export type SchemaName = keyof typeof schemas;

/** One JSON Schema document, as zod renders it. */
export type JsonSchemaDocument = z.core.JSONSchema.BaseSchema;

/** The identifier a rendered document carries, so a reader knows what it holds. */
export const jsonSchemaIdOf = (name: SchemaName): string =>
  `urn:agentify:contract:${CONTRACT_VERSION}:${name}`;

/**
 * The whole contract as JSON Schema, one document per registry entry, each
 * stamped with the contract version. It is a function so that the conversion
 * is paid for only by a caller who needs it.
 *
 * It describes parsed output, including filled defaults and expanded short
 * forms. Fields, types, required keys, unknown-key rules, enumerations,
 * patterns and union branches cross intact. Refinements are not translated
 * automatically: metadata carries representable conditions, and descriptions
 * name the remaining runtime checks.
 */
export const toJsonSchemas = (): Record<SchemaName, JsonSchemaDocument> => {
  const documents = {} as Record<SchemaName, JsonSchemaDocument>;

  for (const [name, schema] of Object.entries(schemas) as [SchemaName, ZodType][]) {
    documents[name] = { $id: jsonSchemaIdOf(name), ...z.toJSONSchema(schema) };
  }

  return documents;
};

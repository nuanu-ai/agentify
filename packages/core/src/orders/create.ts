/**
 * A paused merchant takes no new order, and his open orders play out as usual.
 * That is why the selling guard lives here at creation and the transition
 * function never asks about it.
 */

import { assertNever } from "../index.js";
import type { Effect, Order, OrderMode, OrderPolicy, Price } from "./model.js";
import { effectsOnQuoted } from "./model.js";

/** Whether the merchant is taking new orders. */
export const MERCHANT_SELLING = ["open", "paused"] as const;

export type MerchantSelling = (typeof MERCHANT_SELLING)[number];

/**
 * Whether the card's price is asked of the merchant at the moment of purchase.
 * A static card lives off its snapshot and is not asked.
 */
const PRICE_CHECKS = ["none", "merchant"] as const;

export type PriceCheck = (typeof PRICE_CHECKS)[number];

const CREATE_REJECTIONS = ["selling_paused"] as const;

type CreateRejection = (typeof CREATE_REJECTIONS)[number];

export type CreateOrderInput = {
  readonly id: string;
  readonly at: number;
  readonly mode: OrderMode;
  readonly policy: OrderPolicy;
  readonly priceCheck: PriceCheck;
  readonly cardPrice: Price;
  readonly test: boolean;
  readonly selling: MerchantSelling;
};

export type CreateOrderResult =
  | { readonly ok: true; readonly order: Order; readonly effects: readonly Effect[] }
  | {
      readonly ok: false;
      readonly rejection: { readonly code: CreateRejection; readonly message: string };
    };

export function createOrder(input: CreateOrderInput): CreateOrderResult {
  switch (input.selling) {
    case "paused":
      return {
        ok: false,
        rejection: {
          code: "selling_paused",
          // The sentence names the product, not the merchant: the caller folds
          // three causes into "paused" (one card off sale, the whole catalog
          // stopped, a merchant who cannot be paid), and only this is true of
          // all three. It is the same sentence the payment challenge is refused
          // with a step earlier.
          message: "this product is not on sale at the moment, so no new order is taken",
        },
      };
    case "open":
      break;
    default:
      return assertNever(input.selling, "merchant selling status");
  }

  const base: Order = {
    id: input.id,
    state: "created",
    mode: input.mode,
    policy: input.policy,
    payment: "none",
    cardPrice: input.cardPrice,
    price: null,
    quoteSource: null,
    dispatch: { attempts: 0, accepted: false },
    heldFulfillment: false,
    closure: null,
    test: input.test,
    timestamps: {
      createdAt: input.at,
      quotedAt: null,
      confirmationRequestedAt: null,
      confirmedAt: null,
      settleStartedAt: null,
      paidAt: null,
      dispatchedAt: null,
    },
  };

  if (input.priceCheck === "merchant") {
    return { ok: true, order: base, effects: [{ kind: "request_quote" }] };
  }

  // A card without a price check is sold off its own snapshot, so the order is
  // born already quoted and the price carries the card's own `as_of`.
  return {
    ok: true,
    order: {
      ...base,
      state: "quoted",
      price: input.cardPrice,
      quoteSource: "card_snapshot",
      timestamps: { ...base.timestamps, quotedAt: input.at },
    },
    effects: effectsOnQuoted(input.mode),
  };
}

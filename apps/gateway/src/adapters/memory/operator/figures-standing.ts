/**
 * What the memory reader's figures and splits share: where a merchant stands
 * at a moment, and every settled sale with the moment its money moved. Each is
 * the twin of the SQL in `adapters/postgres/operator/figures-sql.ts`.
 */

import { askedOn, type FiguresAsked } from "../../../ports/operator/figures.js";
import { microsOf, paidWithNoPrice } from "../../../ports/operator/money.js";
import type {
  RecordedPayoutSplit,
  StoredCard,
  StoredMerchant,
  StoredOrder,
} from "../../../ports/store.js";
import type { MemoryHoldings } from "../store.js";

/** The wallet a merchant is paid at `at`, with the split recorded for it, or nulls where none is set. */
export function walletAt(
  merchant: StoredMerchant,
  at: number,
): { readonly address: string | null; readonly split: RecordedPayoutSplit | null } {
  const { pending } = merchant.payoutWallet;
  return pending !== null && pending.takesEffectAt <= at
    ? { address: pending.address, split: pending.split }
    : { address: merchant.payoutWallet.address, split: merchant.payoutWallet.split };
}

/** Whether a merchant has a seller name and, where the channel asks, a wallet with a recorded split. */
export function namedAndPaid(merchant: StoredMerchant, asked: FiguresAsked): boolean {
  return (
    merchant.serviceName !== null &&
    (!askedOn(asked.surface).wallet || walletAt(merchant, asked.at).split !== null)
  );
}

/** Whether nothing this channel asks of a merchant is missing. */
export function ready(merchant: StoredMerchant, asked: FiguresAsked): boolean {
  return (
    namedAndPaid(merchant, asked) &&
    (!askedOn(asked.surface).admission || merchant.liveApprovedAt !== null)
  );
}

/** Whether a card is on sale now, as `onSale` in figures-sql.ts reads it, with its gap. */
export function onSale(card: StoredCard, merchant: StoredMerchant, asked: FiguresAsked): boolean {
  return (
    merchant.selling === "open" &&
    !card.paused &&
    card.integration === merchant.integration &&
    ready(merchant, asked)
  );
}

/** One settled sale. */
export interface SettledSale {
  readonly record: StoredOrder;
  /** When the order records it as paid, or null where it records no such moment. */
  readonly settledAt: number | null;
  readonly micros: bigint;
  /** The split it was paid into, matched in either spelling, or null where it went straight to a wallet. */
  readonly split: RecordedPayoutSplit | null;
  readonly delivered: boolean;
}

/** Every settled sale the store holds, on the store's network. */
export function settledSales(holdings: MemoryHoldings, network: string): SettledSale[] {
  const splits = new Map(
    holdings.splits
      .filter((split) => split.network === network)
      .map((split) => [split.address.toLowerCase(), split]),
  );
  return holdings.orders
    .map(({ record }) => record)
    .filter((record) => record.order.payment === "settled")
    .map((record) => {
      const price = priceOf(record);
      return {
        record,
        settledAt: settledAtOf(record),
        micros: microsOf(price.amount, price.currency),
        split: record.payTo === null ? null : (splits.get(record.payTo.toLowerCase()) ?? null),
        delivered: record.order.state === "delivered",
      };
    });
}

/** The price an order was sold at; an order paid with no price is a defect, and the read fails on it. */
export function priceOf(record: StoredOrder): {
  readonly amount: string;
  readonly currency: string;
} {
  const { price } = record.order;
  if (price === null) {
    throw paidWithNoPrice(record.order.id);
  }
  return price;
}

/**
 * The moment a settled sale is dated by: the block's time where the payment
 * was observed on the chain, otherwise when the order records it as paid,
 * which is when the money moved for a payment taken at purchase and when the
 * payment was verified for one taken after the goods. Null where the order
 * records neither.
 */
function settledAtOf(record: StoredOrder): number | null {
  const completion = record.paymentAttempt?.completion;
  if (completion?.settled === true && completion.executedAt !== null) {
    return Math.floor(completion.executedAt);
  }
  return record.order.timestamps.paidAt;
}

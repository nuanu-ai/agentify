/**
 * The dashboard calls the gateway's application in-process, as the merchant on
 * the signed-in account's row. A refusal comes back with the sentence and
 * status the HTTP route gives the same refusal (worded once in the gateway's
 * `merchant-answers.ts`), so a merchant reads on a page what their engineer
 * reads from the API. Two exceptions: a body the request schema refuses gets
 * the schema's own problems as its sentence, and keys and wallet changes,
 * which have no route, are worded here.
 *
 * Requests and answers are held to the schemas the contract's route table names
 * for the same call, before anything is drawn, so a document the contract would
 * not recognise fails here rather than as a blank cell in front of a merchant.
 */

import { fulfillmentDeadline, outcomeFor, UNKNOWN } from "@agentify/core";
import type { CommissionRate } from "@agentify/core/published";
import type {
  Caller,
  Gateway,
  Integration,
  IssuedMerchantKey,
  MerchantKey,
  OrderPlace,
  PageFrom,
  PayoutCheck,
  PayoutTransaction,
  RecordedPayoutSplit,
  StoredOrder,
  WalletChangeRefusal,
} from "@agentify/gateway";
import {
  bodyRefused,
  CONFLICT,
  hold,
  merchantOrderAnswer,
  merchantOrderList,
  merchantPayout,
  NewKeyLabelSchema,
  NO_SUCH_ITEM,
  NO_SUCH_ORDER,
  type Refused,
  SPLITS_PER_PAYOUT,
} from "@agentify/gateway";
import { failureNamed } from "@agentify/gateway/failure-named";
import {
  API_ROUTES,
  type CardInput,
  type Delivery,
  EvmAddressSchema,
  type HandlerAnswer,
  type MerchantCard,
  type MerchantCardList,
  type OrderCallResponse,
  type OrderCloseRequest,
  type OrderCloseResponse,
  type OrderList,
  type OrderWithStatus,
  type PayoutWallet,
  type PublishResult,
  type QuoteAnswerAck,
  type QuoteResponse,
  type ReceiptList,
  type RouteDefinition,
  type WorkerPollResponse,
} from "@nuanu-ai/agentify-contracts";
import type { From, Mark } from "./cursor.js";
import { ANSWER_WITHIN_MS } from "./deadlines.js";
import { PAGE_ROWS } from "./listing.js";
import { NOT_A_PAYOUT_WALLET, type NotAWallet } from "./payout-wallet.js";
import type { LapsedAttempt } from "./views.js";

export type Answer<T> =
  | { readonly ok: true; readonly document: T }
  /**
   * `status` is the route's status for the same refusal, or 0 where nothing
   * answered within the deadline, which a page must not fold into a refusal:
   * that would tell a merchant their catalog is empty when nothing answered.
   */
  | {
      readonly ok: false;
      readonly status: number;
      readonly why: string;
      /**
       * Read for the refusals a screen words for itself; everything else shows
       * `why`.
       */
      readonly code?: string;
      /**
       * The orders a refusal is about, oldest first, for a screen that shows
       * each one to be copied.
       */
      readonly orders?: readonly string[];
      /**
       * Set where the refusal's own words say nothing was written. A refusal
       * with a status under 500 is read as having written nothing even
       * without it, so a call that acts and then refuses with a 4xx must not
       * be added: it would be titled "Nothing was changed".
       */
      readonly nothingRecorded?: true;
    };

/**
 * Why a paid order was left unfulfilled: the merchant refused an order already paid for, its
 * delivery deadline passed, or the payment was confirmed only after the gateway
 * had stopped waiting for it and closed the order. Which confirmed it, the
 * facilitator's late answer or a transfer found on the chain, is not recorded.
 */
export type UnfulfilledCause = "refused" | "deadline_passed" | "charge_confirmed_late";

/** The one transaction that pays out every split that can hold a merchant's money. */
interface PayoutToSend {
  readonly transaction: PayoutTransaction;
  /**
   * The USDC, in millionths, that sending it now would bring the merchant's
   * wallets, as the chain ran it without sending it; `UNKNOWN` where the
   * chain could not be asked or did not answer in time.
   */
  readonly brings: bigint | typeof UNKNOWN;
}

/**
 * What an order's record keeps and its document leaves out. Each moment is
 * the record's own, and null where the record keeps none.
 */
export interface OrderRecord {
  /** Why a paid order was left unfulfilled; null for an order that is not, or whose cause is not recorded. */
  readonly unfulfilled: UnfulfilledCause | null;
  /** When the money moved, where the order's receipt or its charge records it. */
  readonly paidAt: string | null;
  /**
   * The deadline on the goods, while it still runs or where its passing left
   * the order unfulfilled; null for every other order.
   */
  readonly deadline: Readonly<{ at: string; passed: boolean }> | null;
  /**
   * The integration whose card the sale was made on, which is the one that
   * can still deliver it; null where the card cannot be read.
   */
  readonly soldThrough: Integration | null;
  /**
   * Whether it counts toward the stop on the merchant's new purchases: an
   * order left unfulfilled that its merchant answers for.
   */
  readonly counts: boolean;
}

/**
 * A merchant's payout splits on this network, for the payout wallet screen,
 * and their payout. `payout` is null where no split can hold any money, says
 * how many there are where one transaction cannot carry them all, and is
 * `unbuilt` where the builder refused the splits as recorded.
 */
export interface PayoutSplits {
  /** The terms every split recorded on this network from now is made with. */
  readonly rate: CommissionRate;
  readonly inForce: RecordedPayoutSplit | null;
  readonly pending: RecordedPayoutSplit | null;
  readonly payout: PayoutToSend | { readonly tooMany: number } | "unbuilt" | null;
}

/**
 * The payout of these splits, or `unbuilt` where the builder refuses them.
 * The builder is pure and throws only to refuse, and a refusal belongs to the
 * payout panel alone: the rest of Settings, the control that signs every
 * other device out among it, does not depend on it.
 */
const payoutOf = (
  merchantId: string,
  build: () => PayoutTransaction,
): PayoutTransaction | "unbuilt" => {
  try {
    return build();
  } catch (refused) {
    console.error(
      `[dashboard] no payout was built for ${merchantId}: ${refused instanceof Error ? refused.message : String(refused)}`,
    );
    return "unbuilt";
  }
};

/** What `transaction` would bring if sent now, or `UNKNOWN` where the chain gave no answer within `withinMs`. */
const broughtWithin = async (
  check: PayoutCheck | undefined,
  transaction: PayoutTransaction,
  withinMs: number,
): Promise<bigint | typeof UNKNOWN> => {
  if (check === undefined) return UNKNOWN;
  let cut: ReturnType<typeof setTimeout> | undefined;
  // The page keeps its own time too: Settings must be drawn in time even
  // where a check does not keep to `withinMs`.
  const late = new Promise<typeof UNKNOWN>((resolve) => {
    cut = setTimeout(() => resolve(UNKNOWN), Math.max(0, withinMs));
  });
  const read = check.wouldBring(transaction, withinMs).catch((thrown: unknown): typeof UNKNOWN => {
    console.error(
      `[dashboard] what a payout would bring was not read from the chain: ${failureNamed(thrown)}`,
    );
    return UNKNOWN;
  });
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(cut);
  }
};

export interface GatewayClient {
  cards(): Promise<Answer<MerchantCardList>>;
  pauseCard(itemId: string, paused: boolean): Promise<Answer<MerchantCard>>;
  setSelling(selling: boolean): Promise<Answer<MerchantCardList>>;
  /** Every order but the purchases that lapsed unpaid, which are not read here. */
  orders(open: boolean): Promise<Answer<OrderList>>;
  /**
   * One page of the purchases that lapsed unpaid, newest first, where `from`
   * stands, how many there are and how many are newer than the page, and the
   * places of its first and last attempts where the list goes on that way; a
   * cursor past either end reads the page at that end.
   */
  lapsedAttempts(from: From): Promise<
    Answer<{
      readonly attempts: readonly LapsedAttempt[];
      readonly of: number;
      readonly newer: number;
      readonly previous: Mark | null;
      readonly next: Mark | null;
    }>
  >;
  /** How many purchases lapsed unpaid, with none of them read. */
  lapsedCount(): Promise<Answer<number>>;
  /**
   * Every order but the purchases that lapsed unpaid, and what each one's
   * record keeps beside its document, from one read so the two agree.
   */
  ordersWithRecords(): Promise<
    Answer<{
      readonly orders: OrderList;
      readonly records: Readonly<Record<string, OrderRecord>>;
    }>
  >;
  receipts(): Promise<Answer<ReceiptList>>;
  /**
   * The payout split this order's payment was checked against, as recorded,
   * whether or not the charge went through; null where it was checked against
   * the wallet itself, before payments went to splits, or was never paid. The
   * order documents do not name where a payment went.
   */
  paidInto(orderId: string): Promise<Answer<RecordedPayoutSplit | null>>;
  /**
   * The split each order was charged into, by order, for the shares the
   * orders and receipts show: only where the charge went through, into a
   * split recorded for this merchant.
   */
  paidIntoSplits(): Promise<Answer<Readonly<Record<string, RecordedPayoutSplit>>>>;
  keys(): Promise<Answer<readonly MerchantKey[]>>;
  issueKey(label: string): Promise<Answer<IssuedMerchantKey>>;
  disableKey(keyId: string): Promise<Answer<MerchantKey>>;
  /** Null for none. */
  sellerName(): Promise<Answer<string | null>>;
  liveApproval(): Promise<Answer<boolean>>;
  setSellerName(name: string): Promise<Answer<string | null>>;
  /** Either is null where none was given. */
  seller(): Promise<Answer<{ readonly name: string | null; readonly site: string | null }>>;
  setSellerSite(site: string): Promise<Answer<string | null>>;
  payoutWallet(): Promise<Answer<PayoutWallet>>;
  payoutSplits(): Promise<Answer<PayoutSplits>>;
  /** The only way a wallet is set; no HTTP route does it. */
  setPayoutWallet(address: string): Promise<Answer<PayoutWallet>>;
  /**
   * The one call whose failure is a document: a refused publish carries one
   * finding per obstacle, which is what a merchant importing a catalogue reads.
   * Folded into a sentence, the reasons would be lost.
   *
   * Published as the shop's: the WooCommerce import is the only thing in the
   * dashboard that publishes, so a merchant selling through their own code has
   * it refused.
   */
  publishCard(card: CardInput): Promise<Answer<PublishResult>>;
  /**
   * Which integration this merchant sells through now, and their cards that
   * are off sale because the other one published them.
   */
  integration(): Promise<
    Answer<{
      readonly through: Integration;
      readonly offSale: readonly string[];
      readonly selling: "open" | "paused";
    }>
  >;
  /**
   * What the frame says over every page, from one read of the merchant's row
   * and none of their cards: the selling state, the integration, the seller
   * name, the wallet paid now with a change of it waiting, and the operator's
   * approval for live sales.
   */
  standing(): Promise<
    Answer<{
      readonly selling: "open" | "paused";
      readonly through: Integration;
      readonly sellerName: string | null;
      readonly payoutWallet: string | null;
      /** A replacement of the wallet that waits to apply, on live alone, and when it applies. */
      readonly pendingPayoutWallet: {
        readonly address: string;
        readonly takesEffectAt: number;
      } | null;
      readonly liveApproved: boolean;
      /**
       * Present while the merchant's purchases are refused, and their cards
       * left out of the catalogue, because their process has not polled: when
       * it last did, or null where it never has.
       */
      readonly outOfTouch: { readonly since: number | null } | null;
      /** Whether as many purchases wait for payment as the door allows, so the next is refused. */
      readonly busy: boolean;
      /** Whether as many paid orders are left unserved as the door allows, so every new purchase is refused. */
      readonly unserved: boolean;
      /**
       * On the live channel while an operator's withdrawal of the merchant's
       * admission stands: when, and the note the operator wrote for them.
       */
      readonly withdrawn: { readonly at: number; readonly note: string | null } | null;
    }>
  >;
  /**
   * Moves this merchant to an integration: the shop's keys arriving move them
   * to the shop, and Disconnect back to their code. Refused, in words that
   * name the orders, while one still waits on the integration being left.
   */
  sellThrough(to: Integration): Promise<Answer<{ readonly sellingPaused: boolean }>>;
  /**
   * Whether `sellThrough(to)` would be made now, refused in its words where it
   * would not, with nothing switched. Connect asks it before sending anybody to
   * the shop; the switch itself can still be refused when the keys arrive.
   */
  maySellThrough(to: Integration): Promise<Answer<null>>;
  /**
   * Only for the WooCommerce worker, which fills orders for merchants with no
   * code of their own; every page draws and does not wait.
   */
  pollWorker(waitSeconds: number): Promise<Answer<WorkerPollResponse>>;
  answerOrder(orderId: string, answer: HandlerAnswer): Promise<Answer<OrderCallResponse>>;
  getOrder(orderId: string): Promise<Answer<OrderWithStatus>>;
  closeOrder(orderId: string, request: OrderCloseRequest): Promise<Answer<OrderCloseResponse>>;
  /** Idempotent. */
  deliverOrder(orderId: string, delivery: Delivery): Promise<Answer<OrderCallResponse>>;
  answerQuote(priceId: string, answer: QuoteResponse): Promise<Answer<QuoteAnswerAck>>;
}

/**
 * Separate from the client, because every other call is made as some merchant
 * and a `register` on a client bound to one would ignore it.
 */
export interface Registrar {
  register(): Promise<Answer<string>>;
}

/**
 * The address is what the gateway names when a session of this account changes
 * the wallet or issues a key. The WooCommerce worker acts for the account that
 * connected the shop and makes neither call.
 */
export interface Acting {
  readonly merchantId: string;
  readonly email: string;
}

export const lateAnswer = (answerWithinMs: number): Answer<never> => {
  const seconds = Math.max(1, Math.round(answerWithinMs / 1_000));
  return {
    ok: false,
    status: 0,
    why:
      `Agentify did not answer within ${seconds === 1 ? "a second" : `${seconds} seconds`}, so` +
      " what was asked may or may not have been done; reload the page to see where it stands",
  };
};

const refusedAs = (refused: Refused): Answer<never> => ({
  ok: false,
  status: refused.status,
  why: refused.message,
  code: refused.code,
});

const done = <T>(document: T): Answer<T> => ({ ok: true, document });

/**
 * A dependency of the call failed rather than the call, and nothing was
 * recorded.
 */
const UNAVAILABLE = 503;

/** What was asked for cannot be done as asked, and nothing was recorded. */
const BAD_REQUEST = 400;

/**
 * An address a merchant's share could never come back from, which the screen
 * that asked for it words under its box.
 */
export const NOT_A_PAYOUT_WALLET_CODE = "not_a_payout_wallet";

const notAWallet = (is: NotAWallet): Answer<never> => ({
  ok: false,
  status: BAD_REQUEST,
  code: NOT_A_PAYOUT_WALLET_CODE,
  why: NOT_A_PAYOUT_WALLET[is],
});

/**
 * Nothing was written in any case: the address paid now and any change already
 * waiting are as they were. A message that could not be confirmed as sent to
 * every account may still have reached some, and the words say so without
 * naming a cause the gateway cannot know. A race has two wordings, because a
 * change raced after its message went out has a message in an inbox and one
 * raced before has none: a merchant must not be told nothing was sent when it
 * was, nor sent looking for a message that does not exist.
 */
const walletRefusedAs = (why: Exclude<WalletChangeRefusal, object>): Answer<never> => {
  switch (why) {
    case "nobody_to_tell":
      return {
        ok: false,
        nothingRecorded: true,
        status: CONFLICT,
        why: "a change of the payout wallet is told to every dashboard account that names this merchant before it is recorded, and no account names this merchant, so there is nobody to tell; nothing was changed and sales are paid where they were",
      };
    case "not_announced":
      return {
        ok: false,
        nothingRecorded: true,
        status: UNAVAILABLE,
        why: "the message about this change could not be confirmed as sent to every account that names this merchant, so nothing was recorded and sales are paid where they were; an account may still have received it, and it says the change takes effect only if the Payout wallet section of the dashboard's Settings shows it, which it does not",
      };
    case "raced":
      return {
        ok: false,
        nothingRecorded: true,
        status: CONFLICT,
        why: "another change of this merchant's payout wallet was recorded between reading the wallet and writing this one, so this one was not recorded; read the wallet and ask again if this is still the address wanted",
      };
    case "raced_after_announcing":
      return {
        ok: false,
        nothingRecorded: true,
        status: CONFLICT,
        why: "another change of this merchant's payout wallet was recorded while this one was being announced, so this one was not recorded; its message went out and says the change takes effect only if the Payout wallet section of the dashboard's Settings shows it, which it does not. Read the wallet and ask again if this is still the address wanted",
      };
    default: {
      const unanswered: never = why;
      throw new Error(`there are no words for the wallet refusal ${String(unanswered)}`);
    }
  }
};

/**
 * A throw is not turned into an answer: it is our own code failing, possibly
 * after the work was done, so a page must not say nothing was. It goes to the
 * page's handler; one that arrives after the page stopped waiting is logged
 * here.
 */
const within = async <T>(
  name: string,
  answerWithinMs: number,
  work: () => Promise<Answer<T>>,
): Promise<Answer<T>> => {
  let cut: ReturnType<typeof setTimeout> | undefined;
  let gaveUp = false;
  const late = new Promise<Answer<T>>((resolve) => {
    cut = setTimeout(() => {
      gaveUp = true;
      console.error(`[dashboard] ${name} did not finish within ${answerWithinMs} ms`);
      resolve(lateAnswer(answerWithinMs));
    }, answerWithinMs);
  });
  const worked = work();
  worked.catch((thrown: unknown) => {
    if (gaveUp) {
      console.error(
        `[dashboard] ${name} failed after the page stopped waiting: ${failureNamed(thrown)}`,
      );
    }
  });
  try {
    return await Promise.race([worked, late]);
  } finally {
    clearTimeout(cut);
  }
};

/**
 * Returns the value the schema reads, or the refusal the HTTP route gives a
 * body that is not the document the call takes.
 */
const sent = <T>(
  route: RouteDefinition,
  body: T,
):
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refused: Answer<never> } => {
  if (route.request === undefined) {
    throw new Error(`${route.path} takes no body, and a call here sent one`);
  }
  const held = hold(route.request, body);
  return held.ok
    ? { ok: true, value: held.value as T }
    : { ok: false, refused: refusedAs(bodyRefused(held.problems)) };
};

const answered = <T>(route: RouteDefinition, document: T): Answer<T> =>
  done(route.response.document.parse(document) as T);

const orderCallAnswer = <T extends OrderCallResponse | OrderCloseResponse>(
  route: RouteDefinition,
  response: T | null,
): Answer<T> => {
  if (response === null) {
    return refusedAs(NO_SUCH_ORDER);
  }
  const held = route.response.document.parse(response) as T;
  return held.ok
    ? done(held)
    : { ok: false, status: CONFLICT, why: held.error.message, code: held.error.code };
};

/**
 * Also the answer for another merchant's key, so disabling cannot count
 * somebody else's keys.
 */
const NO_SUCH_KEY: Answer<never> = { ok: false, status: 404, why: "there is no such key" };

/**
 * The split recorded at this address among those that can hold this
 * merchant's money, which are every split one of their payments was checked
 * against; null for an address that is none of them, such as the wallet
 * itself.
 */
const splitAt = (
  splits: { readonly toPayOut: readonly RecordedPayoutSplit[] },
  address: string,
): RecordedPayoutSplit | null =>
  splits.toPayOut.find((split) => split.address.toLowerCase() === address.toLowerCase()) ?? null;

/**
 * A switch of integration refused for the orders still waiting on the one
 * being left, which travel beside the refusal: the shop screen words them
 * itself from the open list, and `why` is what a log says.
 */
const switchRefused = (to: Integration, waiting: readonly string[]): Answer<never> => ({
  ok: false,
  status: CONFLICT,
  code: "orders_waiting",
  orders: waiting,
  why: `${waiting.length === 1 ? "1 order still waits" : `${waiting.length} orders still wait`} on the ${to === "woocommerce" ? "code" : "shop"}`,
});

const UNFULFILLED_BY: Readonly<Partial<Record<string, UnfulfilledCause>>> = {
  merchant_refused: "refused",
  deadline_expired: "deadline_passed",
  payment_outcome_unknown: "charge_confirmed_late",
};

/**
 * When the money moved: what the order's receipt says, where it has one, since
 * that is the moment already given to the buyer; otherwise the charge's own
 * record, then the moment an order charged at purchase was paid, then the
 * moment a payment completed after the merchant's closure. An order charged
 * after its goods records as paid the moment its payment was checked, which
 * is not when the money moved.
 */
const moneyMovedAt = (record: StoredOrder, receipted: string | null): string | null => {
  const { order } = record;
  if (receipted !== null) return receipted;
  const completion = record.paymentAttempt?.completion;
  const at =
    (completion?.settled === true ? completion.executedAt : null) ??
    (order.mode.settle === "on_purchase" ? order.timestamps.paidAt : null) ??
    order.merchantClosure?.paymentCompletedAt ??
    null;
  return at === null ? null : new Date(at).toISOString();
};

/**
 * A deadline is said to have passed only where its passing is why the order
 * is unfulfilled: an order refused after payment may have been refused well
 * inside it.
 */
const orderRecordOf = (
  record: StoredOrder,
  receipted: string | null,
  soldThrough: Integration | null,
): OrderRecord => {
  const { order } = record;
  const unfulfilled =
    order.state === "unfulfilled" ? (UNFULFILLED_BY[order.closure?.cause ?? ""] ?? null) : null;
  const running = order.state === "paid" || order.state === "dispatched";
  const due =
    running || unfulfilled === "deadline_passed" ? fulfillmentDeadline(order)[0] : undefined;
  return {
    unfulfilled,
    paidAt: moneyMovedAt(record, receipted),
    deadline: due === undefined ? null : { at: new Date(due.at).toISOString(), passed: !running },
    soldThrough,
    counts: order.state === "unfulfilled" && record.answerable === true,
  };
};

/**
 * One purchase that lapsed unpaid as the dashboard lists it. It is not the
 * API's order document, which carries a sale price and so cannot describe an
 * attempt that ended before anybody named one: such an attempt has no price
 * and no moment it was priced, only the moment it was asked for.
 */
/** A place older than every order: the page nearest before it is the oldest. */
const BEFORE_EVERY_ORDER: OrderPlace = { createdAt: -1, id: "" };

const placeOfMark = (mark: Mark): OrderPlace => ({ createdAt: mark.key[0] ?? 0, id: mark.id });

const placesOf = (from: NonNullable<From>): PageFrom<OrderPlace> =>
  "after" in from ? { after: placeOfMark(from.after) } : { before: placeOfMark(from.before) };

const markOfPlace = (place: OrderPlace): Mark => ({ key: [place.createdAt], id: place.id });

const lapsedAttemptOf = (record: StoredOrder): LapsedAttempt => {
  const { order } = record;
  return {
    id: order.id,
    merchant_item_id: record.merchantItemId,
    status: outcomeFor(order),
    price:
      order.price === null ? null : { amount: order.price.amount, currency: order.price.currency },
    asked_at: new Date(order.timestamps.createdAt).toISOString(),
    priced_at:
      order.price === null || order.timestamps.quotedAt === null
        ? null
        : new Date(order.timestamps.quotedAt).toISOString(),
  };
};

/**
 * Built per request from the signed-in person, so two people signed into one
 * dashboard are two merchants.
 */
export const gatewayFor = (
  application: Gateway,
  acting: Acting,
  answerWithinMs: number = ANSWER_WITHIN_MS,
): GatewayClient => {
  const { merchantId } = acting;
  const session = { kind: "signed_in", email: acting.email } as const;
  const caller: Caller = session;
  const call = <T>(name: string, work: () => Promise<Answer<T>>): Promise<Answer<T>> =>
    within(name, answerWithinMs, work);
  // The gateway refuses every recorded split alike, and the registry row says
  // whose it is; a refused address it holds no row for is a defect, not words.
  const whosePayoutSplit = async (address: string): Promise<NotAWallet> => {
    const split = await application.runtime.store.payoutSplitAt(address);
    if (split === null) {
      throw new Error(
        `the gateway refused ${address} as a payout split the registry does not hold`,
      );
    }
    return split.merchantId === merchantId ? "own_payout_split" : "another_merchants_payout_split";
  };

  return {
    cards: () =>
      call("reading the cards", async () =>
        answered(API_ROUTES.list_merchant_cards, await application.merchantCards(merchantId)),
      ),
    pauseCard: (itemId, paused) =>
      call(paused ? "pausing a card" : "resuming a card", async () => {
        const card = await application.setCardPaused(merchantId, itemId, paused, caller);
        return card === null ? refusedAs(NO_SUCH_ITEM) : answered(API_ROUTES.pause_card, card);
      }),
    setSelling: (selling) =>
      call(selling ? "resuming the selling" : "stopping the selling", async () => {
        const cards = await application.setSelling(merchantId, selling ? "open" : "paused", caller);
        return answered(API_ROUTES.pause_selling, cards);
      }),
    orders: (open) =>
      call("reading the orders", async () =>
        answered(
          API_ROUTES.list_orders,
          merchantOrderList(
            await application.orders(merchantId, open ? true : undefined, {
              leaveOutLapsed: true,
            }),
          ),
        ),
      ),
    lapsedAttempts: (from) =>
      call("reading the purchases that lapsed unpaid", async () => {
        const read = async (at: PageFrom<OrderPlace> | undefined) =>
          await application.lapsedAttempts(merchantId, {
            limit: PAGE_ROWS,
            ...(at === undefined ? {} : { from: at }),
          });
        const asked = from === null ? undefined : placesOf(from);
        let page = await read(asked);
        // A cursor past either end, as an address kept from a longer list
        // holds, reads the page at that end rather than no rows.
        if (asked !== undefined && page.orders.length === 0 && page.of > 0) {
          page = await read("after" in asked ? { before: BEFORE_EVERY_ORDER } : undefined);
        }
        return done({
          attempts: page.orders.map(lapsedAttemptOf),
          of: page.of,
          newer: page.newer,
          previous: page.previous === null ? null : markOfPlace(page.previous),
          next: page.next === null ? null : markOfPlace(page.next),
        });
      }),
    lapsedCount: () =>
      call("counting the purchases that lapsed unpaid", async () =>
        done((await application.lapsedAttempts(merchantId, { limit: 0 })).of),
      ),
    ordersWithRecords: () =>
      call("reading the orders", async () => {
        const read = await application.orders(merchantId, undefined, { leaveOutLapsed: true });
        const paid = new Map(
          (await application.receipts(merchantId)).receipts.map((one) => [
            one.order_id,
            one.paid_at,
          ]),
        );
        const publishedBy = new Map(
          (await application.runtime.store.cards(merchantId)).map((card) => [
            card.id,
            card.integration,
          ]),
        );
        return done({
          orders: API_ROUTES.list_orders.response.document.parse(
            merchantOrderList(read),
          ) as OrderList,
          records: Object.fromEntries(
            read.map((record) => [
              record.order.id,
              orderRecordOf(
                record,
                paid.get(record.order.id) ?? null,
                publishedBy.get(record.itemId) ?? null,
              ),
            ]),
          ),
        });
      }),
    receipts: () =>
      call("reading the receipts", async () =>
        answered(API_ROUTES.list_receipts, await application.receipts(merchantId)),
      ),
    paidInto: (orderId) =>
      call("reading where an order was paid", async () => {
        const record = await application.merchantOrder(merchantId, orderId);
        if (record === null) return refusedAs(NO_SUCH_ORDER);
        const { payTo } = record;
        if (payTo === null) return done(null);
        return done(splitAt(await application.payoutSplitsOf(merchantId), payTo));
      }),
    // The orders are read before the splits: a split an order was paid into
    // is recorded before the order names it, so nothing read here names a
    // split the second read could miss.
    paidIntoSplits: () =>
      call("reading where the orders were paid", async () => {
        // A purchase that lapsed unpaid was paid into nothing, so it is not read.
        const records = await application.orders(merchantId, undefined, { leaveOutLapsed: true });
        const splits = await application.payoutSplitsOf(merchantId);
        const into: Record<string, RecordedPayoutSplit> = {};
        for (const record of records) {
          const split =
            record.payTo === null || record.order.payment !== "settled"
              ? null
              : splitAt(splits, record.payTo);
          if (split !== null) into[record.order.id] = split;
        }
        return done(into);
      }),
    keys: () =>
      call("reading the keys", async () => done(await application.merchantKeys(merchantId))),
    issueKey: (label) =>
      call("issuing a key", async () => {
        const asked = hold(NewKeyLabelSchema, label);
        if (!asked.ok) return refusedAs(bodyRefused(asked.problems));
        return done(await application.issueMerchantKey(merchantId, label, session));
      }),
    disableKey: (keyId) =>
      call("disabling a key", async () => {
        const disabled = await application.disableMerchantKey(merchantId, keyId);
        return disabled === null ? NO_SUCH_KEY : done(disabled);
      }),
    liveApproval: () =>
      call("reading the live approval", async () =>
        done(await application.liveApproved(merchantId)),
      ),
    // Null is a real answer: the merchant has not chosen a name yet.
    sellerName: () =>
      call("reading the seller's name", async () => {
        const held = answered(API_ROUTES.get_seller_name, await application.sellerName(merchantId));
        return held.ok ? done(held.document.seller_name) : held;
      }),
    setSellerName: (name) =>
      call("setting the seller's name", async () => {
        const asked = sent(API_ROUTES.set_seller_name, { seller_name: name });
        if (!asked.ok) return asked.refused;
        const held = answered(
          API_ROUTES.set_seller_name,
          await application.setSellerName(merchantId, asked.value, caller),
        );
        return held.ok ? done(held.document.seller_name) : held;
      }),
    seller: () =>
      call("reading the seller", async () => {
        const held = answered(API_ROUTES.get_seller_name, await application.sellerName(merchantId));
        return held.ok
          ? done({ name: held.document.seller_name, site: held.document.seller_site })
          : held;
      }),
    setSellerSite: (site) =>
      call("setting the shop's site", async () => {
        const asked = sent(API_ROUTES.set_seller_name, { seller_site: site });
        if (!asked.ok) return asked.refused;
        const held = answered(
          API_ROUTES.set_seller_name,
          await application.setSellerName(merchantId, asked.value, caller),
        );
        return held.ok ? done(held.document.seller_site) : held;
      }),
    // The whole document, because the screen must draw a waiting change beside
    // the address paid now; shown only the current address after asking for
    // another, a merchant would think the change did not happen.
    payoutWallet: () =>
      call("reading the payout wallet", async () =>
        answered(API_ROUTES.get_payout_wallet, await application.payoutWallet(merchantId)),
      ),
    // Built from the splits as recorded, on the network's contracts; the rate
    // is the one a wallet saved now is recorded with. The chain gets half the
    // page's deadline counted from the start of this read, so a slow database
    // and a slow chain together still leave the rest of Settings, the control
    // that signs every other device out among it, drawn in time.
    payoutSplits: () =>
      call("reading the payout splits", async () => {
        const chainBy = Date.now() + answerWithinMs / 2;
        const { payoutSplit: network, payoutSplitNetworks } = application.runtime.config;
        const { inForce, pending, toPayOut } = await application.payoutSplitsOf(merchantId);
        const built =
          toPayOut.length === 0
            ? null
            : toPayOut.length > SPLITS_PER_PAYOUT
              ? { tooMany: toPayOut.length }
              : payoutOf(merchantId, () => merchantPayout(network, toPayOut, payoutSplitNetworks));
        return done({
          rate: {
            commissionAllocation: network.commissionAllocation,
            totalAllocation: network.totalAllocation,
          },
          inForce,
          pending,
          payout:
            built === null || built === "unbuilt" || "tooMany" in built
              ? built
              : {
                  transaction: built,
                  brings: await broughtWithin(
                    application.runtime.payoutCheck,
                    built,
                    chainBy - Date.now(),
                  ),
                },
        });
      }),
    setPayoutWallet: (address) =>
      call("setting the payout wallet", async () => {
        const asked = hold(EvmAddressSchema, address);
        if (!asked.ok) return refusedAs(bodyRefused(asked.problems));
        const set = await application.setPayoutWallet(merchantId, asked.value as string, session);
        if (typeof set === "string") return walletRefusedAs(set);
        if ("refused" in set) {
          return notAWallet(
            set.is === "payout_split" ? await whosePayoutSplit(asked.value as string) : set.is,
          );
        }
        return answered(API_ROUTES.get_payout_wallet, set);
      }),
    // A refused card is an answer with findings, checked by the flow itself as
    // at the HTTP route, so there is no request schema to hold it to first.
    publishCard: (card) =>
      call("publishing a card", async () =>
        answered(
          API_ROUTES.publish_card,
          await application.publishCard(merchantId, card, "woocommerce", caller),
        ),
      ),
    integration: () =>
      call("reading the integration", async () =>
        done(await application.integrationOf(merchantId)),
      ),
    standing: () =>
      call("reading the merchant's standing", async () =>
        done(await application.standingOf(merchantId)),
      ),
    sellThrough: (to) =>
      call("switching the integration", async () => {
        const switched = await application.sellThrough(merchantId, to, caller);
        return switched.switched
          ? done({ sellingPaused: switched.sellingPaused })
          : switchRefused(to, switched.waiting);
      }),
    maySellThrough: (to) =>
      call("asking whether the integration can be switched", async () => {
        const waiting = await application.switchHeldBy(merchantId, to);
        return waiting.length === 0 ? done(null) : switchRefused(to, waiting);
      }),
    pollWorker: (waitSeconds) =>
      call("drawing the stream", async () => {
        const asked = sent(API_ROUTES.poll_worker, { wait_seconds: waitSeconds });
        if (!asked.ok) return asked.refused;
        return answered(
          API_ROUTES.poll_worker,
          await application.poll(merchantId, (asked.value.wait_seconds ?? waitSeconds) * 1_000, {
            through: "woocommerce",
          }),
        );
      }),
    answerOrder: (orderId, answer) =>
      call("answering an order", async () => {
        const asked = sent(API_ROUTES.answer_order, answer);
        if (!asked.ok) return asked.refused;
        return orderCallAnswer(
          API_ROUTES.answer_order,
          await application.answerOrder(merchantId, orderId, asked.value),
        );
      }),
    getOrder: (orderId) =>
      call("reading an order", async () => {
        const read = merchantOrderAnswer(await application.merchantOrder(merchantId, orderId));
        return read.ok ? answered(API_ROUTES.get_order, read.document) : refusedAs(read.refused);
      }),
    closeOrder: (orderId, request) =>
      call("closing fulfillment", async () => {
        const asked = sent(API_ROUTES.close_order, request);
        if (!asked.ok) return asked.refused;
        return orderCallAnswer(
          API_ROUTES.close_order,
          await application.closeOrder(merchantId, orderId, asked.value, caller),
        );
      }),
    deliverOrder: (orderId, delivery) =>
      call("delivering an order", async () => {
        const asked = sent(API_ROUTES.deliver_order, delivery);
        if (!asked.ok) return asked.refused;
        return orderCallAnswer(
          API_ROUTES.deliver_order,
          await application.deliverOrder(merchantId, orderId, asked.value),
        );
      }),
    answerQuote: (priceId, answer) =>
      call("answering a price question", async () => {
        const asked = sent(API_ROUTES.answer_quote, answer);
        if (!asked.ok) return asked.refused;
        const said = await application.answerQuote(merchantId, priceId, asked.value);
        return "refused" in said
          ? refusedAs(bodyRefused(said.refused))
          : answered(API_ROUTES.answer_quote, said);
      }),
  };
};

/** A merchant for a signed-in person who pressed for one. */
export const registrarFor = (
  application: Gateway,
  answerWithinMs: number = ANSWER_WITHIN_MS,
): Registrar => ({
  register: () =>
    within("registering a merchant", answerWithinMs, async () =>
      done(await application.registerMerchant()),
    ),
});

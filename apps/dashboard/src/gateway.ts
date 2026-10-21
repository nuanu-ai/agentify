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

import type {
  Caller,
  Gateway,
  Integration,
  IssuedMerchantKey,
  MerchantKey,
  PayoutTransaction,
  RecordedPayoutSplit,
  WalletChangeRefusal,
} from "@agentify/gateway";
import {
  bodyRefused,
  CONFLICT,
  hold,
  merchantDeparted,
  merchantOrderAnswer,
  merchantOrderList,
  merchantPayout,
  NewKeyLabelSchema,
  NO_SUCH_ITEM,
  NO_SUCH_ORDER,
  type Refused,
  SPLITS_PER_PAYOUT,
} from "@agentify/gateway";
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
import { PAGE_ROWS } from "./listing.js";
import { NOT_A_PAYOUT_WALLET, type NotAWallet } from "./payout-wallet.js";
import type { CommissionRate } from "./shares.js";

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
    };

/**
 * Why a paid order was left unfulfilled: the merchant refused an order already paid for, its
 * delivery deadline passed, the merchant left, or the payment network
 * confirmed the charge only after the gateway had stopped waiting for it and
 * closed the order.
 */
export type UnfulfilledCause =
  | "refused"
  | "deadline_passed"
  | "merchant_left"
  | "charge_confirmed_late";

/**
 * A merchant's payout splits on this network, for the payout wallet screen,
 * and the one transaction that pays out every split that can hold their
 * money. `payout` is null where no split can hold any, says how many there
 * are where one transaction cannot carry them all, and is `unbuilt` where the
 * builder refused the splits as recorded.
 */
export interface PayoutSplits {
  /** The terms every split recorded on this network from now is made with. */
  readonly rate: CommissionRate;
  readonly inForce: RecordedPayoutSplit | null;
  readonly pending: RecordedPayoutSplit | null;
  readonly payout: PayoutTransaction | { readonly tooMany: number } | "unbuilt" | null;
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

export interface GatewayClient {
  cards(): Promise<Answer<MerchantCardList>>;
  pauseCard(itemId: string, paused: boolean): Promise<Answer<MerchantCard>>;
  setSelling(selling: boolean): Promise<Answer<MerchantCardList>>;
  /** Every order but the purchases that lapsed unpaid, which are not read here. */
  orders(open: boolean): Promise<Answer<OrderList>>;
  /**
   * One page of the purchases that lapsed unpaid, newest first, counted from
   * one, and how many there are; a page past the last is the last.
   */
  lapsedAttempts(
    page: number,
  ): Promise<Answer<{ readonly orders: OrderList; readonly of: number }>>;
  /** How many purchases lapsed unpaid, with none of them read. */
  lapsedCount(): Promise<Answer<number>>;
  /**
   * Why each paid order was left unfulfilled, by order, for Needs you.
   */
  unfulfilledOrders(): Promise<Answer<Readonly<Record<string, UnfulfilledCause>>>>;
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
      readonly selling: "open" | "paused" | "departed";
    }>
  >;
  /**
   * What the frame says over every page, from one read of the merchant's row
   * and none of their cards: the selling state, the integration, the seller
   * name, the wallet paid now and the operator's approval for live sales.
   */
  standing(): Promise<
    Answer<{
      readonly selling: "open" | "paused" | "departed";
      readonly through: Integration;
      readonly sellerName: string | null;
      readonly payoutWallet: string | null;
      readonly liveApproved: boolean;
      /**
       * Present while the merchant's purchases that charge before their goods
       * are refused because their process has not polled: when it last did,
       * or null where it never has.
       */
      readonly outOfTouch: { readonly since: number | null } | null;
    }>
  >;
  /**
   * Moves this merchant to an integration: Connect moves them to the shop
   * before they are sent to it, and Disconnect back to their code. Refused,
   * in words that name the orders, while one still waits on the integration
   * being left.
   */
  sellThrough(to: Integration): Promise<Answer<{ readonly sellingPaused: boolean }>>;
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

/**
 * The default deadline for one call: a guard on a page, shorter than a
 * person's patience. The work behind a call that runs out is not cancelled (a
 * late database still writes), so the page says it may have been done. A
 * caller may pass its own: a payout wallet change passes a longer one
 * (`WALLET_CHANGE_MS` in `payout-wallet.ts`), because on live the gateway
 * answers only after every announcement is handed to the mail provider, and
 * tests pass a shorter one so as not to wait ten seconds.
 */
export const ANSWER_WITHIN_MS = 10_000;

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
        status: CONFLICT,
        why: "a change of the payout wallet is told to every dashboard account that names this merchant before it is recorded, and no account names this merchant, so there is nobody to tell; nothing was changed and sales are paid where they were",
      };
    case "not_announced":
      return {
        ok: false,
        status: UNAVAILABLE,
        why: "the message about this change could not be confirmed as sent to every account that names this merchant, so nothing was recorded and sales are paid where they were; an account may still have received it, and it says the change takes effect only if the Payout wallet section of the dashboard's Settings shows it, which it does not",
      };
    case "raced":
      return {
        ok: false,
        status: CONFLICT,
        why: "another change of this merchant's payout wallet was recorded between reading the wallet and writing this one, so this one was not recorded; read the wallet and ask again if this is still the address wanted",
      };
    case "raced_after_announcing":
      return {
        ok: false,
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
      console.error(`[dashboard] ${name} failed after the page stopped waiting`, thrown);
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
 * Why a switch of integration was refused, in the words of the shop screen it
 * is drawn on: how many orders still wait on the integration being left, and
 * what lets them finish. The orders themselves travel beside the sentence, for
 * the screen to show each one.
 */
export const switchRefused = (to: Integration, waiting: readonly string[]): Answer<never> => {
  const one = waiting.length === 1;
  const counted = one ? "1 order still waits" : `${waiting.length} orders still wait`;
  const each = one ? "it has" : "each has";
  return {
    ok: false,
    status: CONFLICT,
    code: "orders_waiting",
    orders: waiting,
    why:
      to === "woocommerce"
        ? `${counted} on your own code, and ${each} to end before your shop takes over: delivered or refused by your code, paid or left unpaid by its buyer, or closed when its time runs out. To keep new orders from arriving meanwhile, pause all sales on Cards.`
        : `${counted} on your shop, and ${each} to end before the shop is disconnected, because nothing reads the shop after that: a parcel once it is marked Completed in WooCommerce, an unpaid purchase once its buyer pays or lets it lapse, or any of them when its time runs out.`,
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
  const session: Caller = { kind: "signed_in", email: acting.email };
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
        const card = await application.setCardPaused(merchantId, itemId, paused);
        return card === null ? refusedAs(NO_SUCH_ITEM) : answered(API_ROUTES.pause_card, card);
      }),
    setSelling: (selling) =>
      call(selling ? "resuming the selling" : "stopping the selling", async () => {
        const changed = await application.setSelling(merchantId, selling ? "open" : "paused");
        return changed.ok
          ? answered(API_ROUTES.pause_selling, changed.cards)
          : refusedAs(merchantDeparted(changed.why));
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
    lapsedAttempts: (page) =>
      call("reading the purchases that lapsed unpaid", async () => {
        const pageAt = (at: number) =>
          application.lapsedAttempts(merchantId, {
            offset: (at - 1) * PAGE_ROWS,
            limit: PAGE_ROWS,
          });
        const asked = await pageAt(page);
        const last = Math.max(1, Math.ceil(asked.of / PAGE_ROWS));
        const read = asked.orders.length === 0 && page > last ? await pageAt(last) : asked;
        const listed = answered(API_ROUTES.list_orders, merchantOrderList(read.orders));
        return listed.ok ? done({ orders: listed.document, of: read.of }) : listed;
      }),
    lapsedCount: () =>
      call("counting the purchases that lapsed unpaid", async () =>
        done((await application.lapsedAttempts(merchantId, { offset: 0, limit: 0 })).of),
      ),
    unfulfilledOrders: () =>
      call("reading why orders are unfulfilled", async () => {
        const owed: Record<string, UnfulfilledCause> = {};
        for (const record of await application.orders(merchantId, true)) {
          const cause =
            record.order.state === "unfulfilled" ? record.order.closure?.cause : undefined;
          const said =
            cause === "merchant_refused"
              ? "refused"
              : cause === "deadline_expired"
                ? "deadline_passed"
                : cause === "merchant_departed"
                  ? "merchant_left"
                  : cause === "payment_outcome_unknown"
                    ? "charge_confirmed_late"
                    : undefined;
          if (said !== undefined) {
            owed[record.order.id] = said;
          }
        }
        return done(owed);
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
          await application.setSellerName(merchantId, asked.value),
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
          await application.setSellerName(merchantId, asked.value),
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
    // is the one a wallet saved now is recorded with.
    payoutSplits: () =>
      call("reading the payout splits", async () => {
        const { payoutSplit: network, payoutSplitNetworks } = application.runtime.config;
        const { inForce, pending, toPayOut } = await application.payoutSplitsOf(merchantId);
        return done({
          rate: {
            commissionAllocation: network.commissionAllocation,
            totalAllocation: network.totalAllocation,
          },
          inForce,
          pending,
          payout:
            toPayOut.length === 0
              ? null
              : toPayOut.length > SPLITS_PER_PAYOUT
                ? { tooMany: toPayOut.length }
                : payoutOf(merchantId, () =>
                    merchantPayout(network, toPayOut, payoutSplitNetworks),
                  ),
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
          await application.publishCard(merchantId, card, "woocommerce"),
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
        const switched = await application.sellThrough(merchantId, to);
        return switched.switched
          ? done({ sellingPaused: switched.sellingPaused })
          : switchRefused(to, switched.waiting);
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
          await application.closeOrder(merchantId, orderId, asked.value),
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

/**
 * The flows: what happens when an agent buys, when a merchant's worker draws
 * its stream, and when either of them answers. Nothing here decides what an
 * order does: each flow reads the world, puts one event to the order machine
 * and answers with what the machine made of it. A price question that went
 * unanswered becomes the event "the merchant was silent", and whether silence
 * sells is decided by the mode, not here.
 */

import type {
  Environment,
  MerchantSelling,
  Order,
  PaymentVerificationFailure,
  TransitionRejection,
} from "@agentify/core";
import {
  createOrder,
  deadlines,
  endedWithNothingHeld,
  fulfillmentDeadline,
  isOpen,
  onTheMerchantsOpenList,
  outcomeFor,
  transition,
} from "@agentify/core";
import { SILENT_AFTER_MS, UNSERVED_AT_MOST } from "@agentify/core/published";
import {
  type Acceptance,
  CARD_REJECTED,
  type CallError,
  type Card,
  CardSchema,
  CONTRACT_VERSION,
  type Delivery,
  deliveryCheckFor,
  type HandlerAnswer,
  listedPurchaseOf,
  localityOf,
  MERCHANT_FINDINGS,
  type MerchantCard,
  type MerchantCardList,
  type MerchantFinding,
  type OrderAcceptResponse,
  type OrderCallResponse,
  type OrderCloseRequest,
  type OrderCloseResponse,
  type PayoutWallet,
  type Problem,
  type ProjectedCard,
  type PublishResult,
  paramSpecToValidator,
  priceProblemsOf,
  publicCardOf,
  purchaseCheckFor,
  type QuoteAnswerAck,
  type QuoteResponse,
  type ReceiptList,
  type Refusal,
  type Seller,
  type SellerName,
  type SellerNameRequest,
  ShipmentSchema,
  type ShipTo,
  type WorkerEnvelope,
  type WorkerPollResponse,
} from "@nuanu-ai/agentify-contracts";
import type { PaymentRequirements } from "@x402/core/types";
import { isAddress } from "viem";
import type {
  AnalyticsEvent,
  CardPublishResult,
  SellingChanged,
  SetupResult,
} from "../analytics/events.js";
import type { Announcement, AskedInTheDashboard } from "../announcements.js";
import { failureNamed } from "../failure-named.js";
import { atomicUnits, CLOCK_SKEW_SECONDS, inUsdc, PaymentEdge } from "../http/x402.js";
import type { AnnouncementOutcome } from "../ports/announcer.js";
import { asTimestamp } from "../ports/clock.js";
import type { Charge, NoVerdict, VerifyOutcome } from "../ports/facilitator.js";
import type { DrawnEnvelope, Reminder } from "../ports/queue.js";
import {
  type AdmissionStanding,
  type AnalyticsOf,
  type Integration,
  type IntegrationSwitch,
  type PayoutWalletRead,
  type PayoutWalletWrite,
  type RecordedPayoutSplit,
  type StoredCard,
  type StoredKey,
  type StoredMerchant,
  type StoredOrder,
  type StoredPayoutWallet,
  storeFailureFactsOf,
  type WalletWritten,
} from "../ports/store.js";
import { isSameAddress } from "../split/address.js";
import { type PayoutSplit, payoutSplitFor } from "../split/parameters.js";
import type { NotAPayoutWallet } from "../split/wallet-rule.js";
import { purchaseUrlOf, sameShipTo as sameAddress } from "./addresses.js";
import { orderCallResponseOf } from "./answers.js";
import { MerchantGate } from "./merchant-gate.js";
import {
  issueKey,
  keyDigest,
  NewKeyLabelSchema,
  payoutWalletFrom,
  registerMerchant,
  setSellerSite,
  setServiceName,
} from "./merchants.js";
import { PayerReads, payerOf } from "./payer-proof.js";
import { PAYMENT_PLACE_WAIT_MS, validityNeededAfterCheckMs } from "./payment-window.js";
import {
  decodePriceStamp,
  orderIdForPrice,
  type PriceOffer,
  priceFactsDigest,
  stampPrice,
  verifyPriceStamp,
} from "./price-stamp.js";
import {
  admissionTimed,
  gateRefused,
  type PaymentLane,
  paymentArrived,
  priceAnswered,
  verifyTimed,
} from "./purchase-metrics.js";
import {
  journal,
  recordMissingSplits,
  refuseUnlessTheSplitsAgree,
  whyTheRuleRefuses,
} from "./recorded-splits.js";
import { returningPayment } from "./returning-payment.js";
import {
  type ActingMerchant,
  endingSentenceOf,
  OrderRunner,
  RECONCILE_PAYMENTS,
  SWEEP_EFFECTS,
  takesANewPayment,
} from "./runner.js";
import {
  cardAsHeld,
  missingFrom,
  modeForCard,
  payoutWalletAt,
  payToAt,
  policyFor,
  priceCheckOf,
  type Runtime,
  sellableBy,
  sellingFor,
} from "./runtime.js";
import { canonical, sameGoods } from "./same-goods.js";
import { purchaseOf, Waiting } from "./waiting.js";

/** Price questions one merchant may have open at once; its worker handles four messages at a time. */
const PRICE_QUESTIONS_AT_ONCE = 4;

/** A loose bound on how fast questions reach one merchant, whatever the pace of its answers. */
const PRICE_QUESTIONS_PER_SECOND = 16;

/**
 * How long a price question waits for a place before the agent is told the
 * seller is busy. It is spent inside the question's own answer window, so it
 * never takes more than half of that.
 */
const PRICE_PLACE_WAIT_MS = 2_000;

/** How many price questions may wait in one merchant's line for a place. */
const PRICE_QUESTIONS_WAITING_AT_MOST = 16;

/** Payments of one merchant's checked with the payment layer at once. */
const PAYMENT_CHECKS_AT_ONCE = 4;

/** How many payments may wait in one merchant's line for a check. */
const PAYMENT_CHECKS_WAITING_AT_MOST = 16;

/**
 * Places for payments whose signature is not the key of the wallet they name:
 * a contract wallet's, or noise. They wait behind each other and never in
 * front of a buyer whose key signed.
 */
const UNPROVEN_CHECKS_AT_ONCE = 2;

/** How many such payments may wait in one merchant's line. */
const UNPROVEN_CHECKS_WAITING_AT_MOST = 4;

/**
 * How stale a key's last-used mark may get before a call refreshes it, so a
 * busy key is written a dozen times an hour rather than on every request. A
 * constant rather than a setting: a knob here could put a write on every
 * request of the money path.
 */
const KEY_USE_WRITTEN_EVERY_MS = 5 * 60_000;

/** How much of a caller's user agent is kept: enough for a name and a release. */
const USER_AGENT_KEPT_CHARACTERS = 200;

/**
 * How long a replacement payout wallet waits on the live deployment, counted
 * from the moment every message about it was handed over. A constant rather
 * than a setting: a knob here could turn the guard off on the field money is
 * sent to.
 */
const WALLET_CHANGE_WAITS_MS = 48 * 60 * 60 * 1_000;

/**
 * How long the gateway waits for the dashboard to hand every message of an
 * announcement over. It must stay under the thirty seconds the dashboard's page
 * waits for a wallet change, or the page reports no answer while the change
 * goes on to be recorded.
 */
const ANNOUNCEMENT_ANSWER_MS = 20_000;

/**
 * Why a wallet change was refused, and in every case nothing was written.
 *
 * `nobody_to_tell`: no account names the merchant. `not_announced`: a message
 * could not be confirmed as sent to every account — the provider refused one,
 * or telling failed or did not finish in time — though some may have gone
 * out. `raced`: another write landed between reading the wallet and writing
 * it, on a change nothing had announced; `raced_after_announcing`: the same,
 * after this change's own message went out. `not_a_payout_wallet`: the
 * address is one a merchant's share could never come back from, and `is`
 * says what it is; it is refused before the wallet is read and before
 * anything is written or announced, and the dashboard words it.
 */
export type WalletChangeRefusal =
  | "nobody_to_tell"
  | "not_announced"
  | "raced"
  | "raced_after_announcing"
  | { readonly refused: "not_a_payout_wallet"; readonly is: NotAPayoutWallet };

/**
 * Who a call comes from: a key, as the door resolved it, or a dashboard
 * session, which calls in-process as the merchant on the signed-in account's
 * row and holds no key. A session is known only by its account's email, and
 * that is what a message names.
 */
export type Caller =
  | { readonly kind: "key"; readonly keyId: string }
  | { readonly kind: "signed_in"; readonly email: string };

/** Who asks for the calls only a dashboard session makes: issuing and disabling keys and setting the wallet. */
type SignedIn = Extract<Caller, { readonly kind: "signed_in" }>;

/**
 * One of a merchant's keys as their dashboard lists it, with no field for the
 * secret, which is shown once when the key is issued. The instants are ISO 8601.
 */
export interface MerchantKey {
  readonly id: string;
  readonly label: string;
  readonly created_at: string;
  /**
   * Behind the truth by up to a few minutes, and null where no call is
   * recorded, which a key made before the gateway recorded this shares with
   * one nobody has called.
   */
  readonly last_used_at: string | null;
  /** Null while the key still works. */
  readonly disabled_at: string | null;
}

/** A key just issued: its row, and its secret, readable this once. */
export interface IssuedMerchantKey {
  readonly key: MerchantKey;
  readonly secret: string;
}

/** The queue's name for the daily sweep of claims on payments. */
const SWEEP_CLAIMS = "agentify_forget_old_claims";

/**
 * A price answer the door turned away, and what stands between its price and a
 * sale. Nothing moved: a question it named that is still held stays open, and
 * one that is not held was never looked up.
 */
export interface QuoteAnswerRefused {
  readonly refused: readonly Problem[];
}

/** Everything a payment challenge for one product has to say. */
export interface PaidResource {
  /** The card as it is held, under the catalog identifier we issued for it. */
  readonly stored: StoredCard;
  /** Why a purchase of this card would be refused right now, or null where it would be priced. */
  readonly offSale: OffSale | null;
  /** The seller's name in a discovery catalog. */
  readonly serviceName: string | null;
  /**
   * Where an agent is asked to pay for this card: its own merchant's recorded
   * split, read from the card's owner and nowhere else, or one seller's
   * takings go to another. Null where there is nowhere to pay.
   */
  readonly payTo: string | null;
}

/**
 * The request a payment was sent with: the product whose address it reached,
 * and the parameters its body carried, where it carried any.
 */
export interface PaidRequest {
  readonly itemId: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** A priced snapshot held only in this response, with no order stored yet. */
export type PricedPurchase = Pick<
  StoredOrder,
  "order" | "merchantId" | "itemId" | "merchantItemId" | "params" | "result" | "priceId"
> & { readonly through: Integration; readonly priceOffer: NonNullable<StoredOrder["priceOffer"]> };

/** What a purchase attempt came to. */
export type PurchaseAttempt =
  /** A priced purchase, with no stored order: here is what payment must satisfy. */
  | { readonly step: "pay"; readonly order: PricedPurchase }
  /** The purchase is over, one way or another. */
  | {
      readonly step: "settled";
      readonly order: StoredOrder;
      readonly delivery: Delivery | null;
      readonly seller?: Seller;
    }
  /** The purchase is under way and the agent is not waiting on it. */
  | { readonly step: "under_way"; readonly order: StoredOrder; readonly seller?: Seller }
  | { readonly step: "no_such_item" }
  /**
   * The card's own example purchase, which holds stand-in values: it is
   * answered as the listing is, and its merchant is asked nothing.
   */
  | { readonly step: "listed_example"; readonly itemId: string }
  | { readonly step: "params_rejected"; readonly problems: readonly Problem[] }
  /** A parcel's purchase without an address, or another purchase with one. */
  | { readonly step: "ship_to_rejected"; readonly message: string }
  /** A payment carrying an address other than the one its order was priced for. */
  | { readonly step: "ship_to_changed" }
  /** A payment sent at another product's address, or with other parameters, than its order's. */
  | { readonly step: "another_purchase" }
  | { readonly step: "not_selling"; readonly message: string }
  /**
   * The merchant could not be asked or did not answer in time, or has as many
   * payments being checked as it may; nothing was charged, and the same call
   * may go through in a moment. `why` says which, in the agent's words.
   */
  | {
      readonly step: "seller_busy";
      readonly why: string;
      /** How long the agent is asked to wait, where it is not the usual two seconds. */
      readonly retryAfterSeconds?: number;
    }
  /**
   * Another request for this price is being checked right now; this one was
   * not taken, and the same request answers once that check is over.
   */
  | { readonly step: "payment_being_checked" }
  /**
   * The payment could not be checked or taken because something on Agentify's
   * side failed for a moment before anything was written; it was not used.
   */
  | { readonly step: "not_checked_now" }
  /**
   * Something on Agentify's side failed before anything was written, for a
   * reason that will not pass by itself; the payment was not used.
   */
  | { readonly step: "failed_before_charge" }
  /**
   * Nothing of the integration the seller sells through has polled for
   * longer than `SILENT_AFTER_MS`; nothing was charged.
   */
  | { readonly step: "seller_not_taking_orders" }
  /**
   * As many of the seller's paid orders as `UNSERVED_AT_MOST` are left with
   * nothing delivered, so no purchase of theirs is taken; nothing was charged.
   */
  | { readonly step: "seller_not_fulfilling" }
  /** This payment has already been presented for a different order. */
  | { readonly step: "payment_already_spent" }
  /** The machine would not take this payment on this order, and said why. */
  | { readonly step: "payment_not_taken"; readonly why: string; readonly retryable: boolean }
  /** The payment layer did not vouch for this payment; nothing was touched. */
  | { readonly step: "payment_not_verified"; readonly why: string; readonly retryable: boolean }
  /** Another payer's payment owns this order, and this payment is not it. */
  | { readonly step: "not_this_purchase" };

/** What the steps of one payment share: when it arrived, and how far it got. */
interface Paying {
  readonly arrivedAt: number;
  /** Set just before the first write, after which a failure may have changed something. */
  readonly progress: { wrote: boolean };
  /** Lets another request for this price be checked; called once this one is past its check. */
  readonly leave: () => void;
}

/**
 * How many envelopes one poll draws past without handing anything out before
 * it answers empty. It is few enough that a poll which can record nothing,
 * because every write is failing, still answers in a bounded time.
 */
const PASSED_AT_MOST = 32;

/** The facts every card of one merchant is read through (`Gateway#howTheySell`). */
interface HowTheySell {
  readonly selling: MerchantSelling;
  readonly sellable: boolean;
  readonly sellerSite: string | null;
  readonly integration: Integration;
  /** Whether they have as many paid orders left unserved as the door allows. */
  readonly unserved: boolean;
  /** The latest recorded poll of the integration they sell through, or null where none was. */
  readonly lastContact: number | null;
}

/** What `offSaleNow` asks of one card of a merchant read as `theirs`. */
const saleFactsOf = (stored: StoredCard, theirs: HowTheySell): SaleFacts => ({
  selling: sellingFor(theirs.selling, stored, theirs.sellable, theirs.integration),
  price: stored.card.price,
  fulfillment: stored.card.fulfillment,
  sellerSite: theirs.sellerSite,
  unserved: theirs.unserved,
  lastContact: theirs.lastContact,
});

/**
 * How stale a seller's recorded poll may get in one process before a poll
 * writes it again, so a busy stream is not one more write per envelope. The
 * silence guard waits this long beyond its `SILENT_AFTER_MS`, so no seller
 * is refused before that silence, and every one is within half a minute
 * after.
 */
export const CONTACT_WRITTEN_EVERY_MS = 30_000;

/**
 * How seldom a seller turned away for their waiting purchases, or for their
 * unserved orders, is said in the log, so a flood of refusals is one line a
 * minute rather than one a request.
 */
const SELLER_REFUSALS_LOGGED_EVERY_MS = 60_000;

/** Whether a seller whose process last polled at `polled` is silent at `at`. */
export const silentAt = (polled: number | null, at: number): boolean =>
  polled === null || polled + SILENT_AFTER_MS + CONTACT_WRITTEN_EVERY_MS < at;

/**
 * Why no purchase of a card can be made now (`offSaleNow`), and whether that
 * ends by itself within minutes. A look at a product off sale for a moment
 * still answers with its payment challenge, because a listing someone else
 * runs may drop a product whose look is refused and not take it back by
 * itself; the catalogue and a purchase turn it away all the same.
 */
export type OffSale =
  | { readonly code: "not_selling"; readonly transient: false; readonly message?: string }
  | { readonly code: "seller_not_fulfilling"; readonly transient: false }
  | { readonly code: "seller_not_taking_orders"; readonly transient: true };

/** What decides whether one card can be bought now. */
interface SaleFacts {
  /** The card's word from `sellingFor`. */
  readonly selling: MerchantSelling;
  /** The card's price as stored, held to the price rule as it stands now. */
  readonly price: Card["price"];
  readonly fulfillment: Card["fulfillment"];
  readonly sellerSite: string | null;
  /** Whether its seller has as many paid orders left unserved as the door allows. */
  readonly unserved: boolean;
  /** The latest recorded poll of the integration its seller sells through, or null. */
  readonly lastContact: number | null;
}

/**
 * Why a purchase of this card would be refused at `at` before its price is
 * asked, or null where it would be priced. The public catalogue lists exactly
 * the cards this answers null for, and the purchase door refuses with its
 * answer, so an agent is never shown a product it cannot buy.
 *
 * A card whose stored price the price rule refuses is not on sale: it was
 * published before the rule was as strict, and is sold again once its
 * merchant publishes it at a price the rule takes.
 *
 * A seller silent beyond `SILENT_AFTER_MS` is refused whatever the card's
 * mode: a synchronous purchase would charge nothing, but nobody would draw
 * its order, so it could only lapse after the buyer had signed and waited.
 * A shop's polls are the connector's, which draws a shop's stream only while
 * the shop is connected. A seller whose price questions or payment checks are
 * full is not off sale: places free within seconds, and anybody can fill them
 * without paying, so they must not empty a seller's listing.
 */
const offSaleNow = (facts: SaleFacts, at: number): OffSale | null => {
  if (facts.selling !== "open" || priceProblemsOf(facts.price).length > 0) {
    return { code: "not_selling", transient: false };
  }
  if (siteRequiredFor(facts.fulfillment) && facts.sellerSite === null) {
    return { code: "not_selling", transient: false, message: SELLER_SITE_REQUIRED };
  }
  if (facts.unserved) return { code: "seller_not_fulfilling", transient: false };
  if (silentAt(facts.lastContact, at)) {
    return { code: "seller_not_taking_orders", transient: true };
  }
  return null;
};

/** What an agent is told of a product that went off sale as its order was made. */
const NOT_ON_SALE = "this product is not on sale at the moment, so no new order is taken";

/** The same, told to an agent that has signed a payment for it. */
const NOT_ON_SALE_PAID =
  "this product is not on sale at the moment, so this payment was not taken and nothing was charged";

/** A buyer pays before receiving goods, so needs somewhere to read the merchant's terms. */
const siteRequiredFor = (fulfillment: unknown): boolean =>
  fulfillment === "async" || fulfillment === "ship";

const SELLER_SITE_REQUIRED =
  "this seller has not provided the site of their shop, so this purchase cannot take a payment before delivery or shipment; nothing was charged";

/**
 * Why a publish through the integration not in use is refused. About the
 * merchant rather than a field, so the path is empty; short enough that the
 * refusal's one line carries it whole.
 */
const NOT_THE_INTEGRATION_IN_USE: Readonly<Record<Integration, Problem>> = {
  api: {
    path: [],
    code: "sells_through_a_shop",
    message:
      "this merchant sells through the WooCommerce shop connected in the dashboard; disconnecting it there brings back the cards their own code publishes",
  },
  woocommerce: {
    path: [],
    code: "sells_through_their_code",
    message:
      "this merchant sells through their own code; connecting the WooCommerce shop in the dashboard switches them to it",
  },
};

/** Why a card the other integration published is not taken over by this one. */
function heldByTheOther(integration: Integration, merchantItemId: string): Problem {
  return {
    path: ["merchant_item_id"],
    code: "published_by_the_other_integration",
    message:
      integration === "api"
        ? `"${merchantItemId}" names a product imported from the merchant's WooCommerce shop, and a card stays with what first published it; publish this one under its own merchant_item_id`
        : `"${merchantItemId}" names a card the merchant's own code published, and a card stays with what first published it, so this product was not imported`,
  };
}

/** A reason from the analytics contract's one list. */
type ReasonCode = NonNullable<CardPublishResult["fields"]["reason_code"]>;

/** Who did what an analytics event records, and through which surface. */
interface ActedBy {
  readonly actor: "human" | "merchant_worker" | "unknown";
  readonly source: "dashboard" | "gateway";
}

/**
 * A dashboard session is a person, a key is the merchant's code. A call that
 * names neither, such as a command's or a test's, is claimed for nobody.
 */
function actedBy(askedBy: Caller | undefined): ActedBy {
  if (askedBy === undefined) return { actor: "unknown", source: "gateway" };
  return askedBy.kind === "signed_in"
    ? { actor: "human", source: "dashboard" }
    : { actor: "merchant_worker", source: "gateway" };
}

/** The reason a refused publish is counted under, by the code of the finding named first. */
const REASON_OF_FINDING: Readonly<Record<string, ReasonCode>> = {
  [MERCHANT_FINDINGS.NO_SELLER_NAME]: "profile_missing",
  [MERCHANT_FINDINGS.NO_PAYOUT_WALLET]: "wallet_missing",
  [MERCHANT_FINDINGS.NO_OPERATOR_APPROVAL]: "approval_required",
  [MERCHANT_FINDINGS.NO_SELLER_SITE]: "seller_site_missing",
  [NOT_THE_INTEGRATION_IN_USE.api.code]: "integration_mismatch",
  [NOT_THE_INTEGRATION_IN_USE.woocommerce.code]: "integration_mismatch",
  published_by_the_other_integration: "integration_mismatch",
};

/**
 * Why a refused publish was refused, as product analytics counts it, from the
 * codes of its findings in order: by the first, which is the merchant's own
 * where they lack something. A finding about the card itself is
 * `invalid_input`.
 */
export function publishRefusalReason(codes: readonly string[]): ReasonCode {
  const [first] = codes;
  return (first === undefined ? undefined : REASON_OF_FINDING[first]) ?? "invalid_input";
}

/**
 * A setup step's result, as it is recorded for product analytics. Only a
 * payout wallet's change is ever left waiting; the contract refuses any other
 * step's `pending` when the event is sent.
 */
function setupResult(
  merchantId: string,
  acted: ActedBy,
  step: "seller_name" | "seller_site" | "api_key" | "payout_wallet",
  settled:
    | { readonly outcome: "completed" | "pending" }
    | { readonly outcome: "blocked" | "failed"; readonly reason_code: ReasonCode },
): SetupResult {
  return {
    name: "agc_setup_result",
    ...acted,
    refs: { merchant: merchantId },
    fields: { step, integration: step === "api_key" ? "api" : "none", ...settled },
  } as SetupResult;
}

/**
 * Whether a wallet write changed what the row held: an address in either
 * spelling is the same address, and a waiting change is the same only with
 * the same moment.
 */
function walletMoved(read: PayoutWalletRead, written: StoredPayoutWallet): boolean {
  const same = (one: string | null, other: string | null): boolean =>
    one === null || other === null ? one === other : isSameAddress(one, other);
  return !(
    same(read.address, written.address) &&
    same(read.pending?.address ?? null, written.pending?.address ?? null) &&
    (read.pending?.takesEffectAt ?? null) === (written.pending?.takesEffectAt ?? null)
  );
}

/** How a refused wallet change is counted; a wallet answered is none. */
function walletRefusalOf(
  answer: PayoutWallet | WalletChangeRefusal,
): { readonly outcome: "blocked" | "failed"; readonly reason_code: ReasonCode } | null {
  if (typeof answer !== "string") {
    return "refused" in answer ? { outcome: "blocked", reason_code: "invalid_input" } : null;
  }
  switch (answer) {
    case "not_announced":
      return { outcome: "failed", reason_code: "dependency_unavailable" };
    case "nobody_to_tell":
      return { outcome: "failed", reason_code: "internal_error" };
    // Another write landed in between: nothing was saved, for a reason the
    // contract's list has no word for.
    case "raced":
    case "raced_after_announcing":
      return { outcome: "failed", reason_code: "unknown" };
  }
}

/** Waits out a poll's window with nothing to draw, or less where the poll is ended. */
function quietFor(ms: number, ended: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ended.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      ended.removeEventListener("abort", done);
      resolve();
    }
    ended.addEventListener("abort", done, { once: true });
  });
}

/**
 * Who is drawing a merchant's stream, beside the merchant: the connection
 * that ends the poll when it closes, the key it came in on, and the
 * integration drawing (`Gateway#poll`). A poll a test or the dashboard makes
 * names none of the first two.
 */
export interface PollDrawing {
  readonly gone?: AbortSignal;
  readonly keyId?: string | null;
  readonly through?: Integration;
  /** The HTTP worker's declared contract; in-process callers use this build's. */
  readonly contractVersion?: string;
}

/** One poll held open, the key it came in on, and the way to end it early. */
interface HeldPoll {
  readonly keyId: string | null;
  readonly stop: AbortController;
}

export class Gateway {
  readonly runtime: Runtime;
  readonly runner: OrderRunner;
  /** Purchases parked on a price question, by the identifier of the question. */
  readonly quotes = new Waiting<QuoteResponse>();
  /**
   * Which merchant each transient price question belongs to. A price
   * identifier is not a secret — it travels on a stream and lands in a receipt
   * — so the answer is checked against the merchant too, or anyone holding one
   * from a log could set the price of somebody else's purchase.
   */
  readonly #questions = new Map<string, { merchantId: string; currency: string; until: number }>();
  readonly #priceGate = new MerchantGate({
    atOnce: PRICE_QUESTIONS_AT_ONCE,
    perSecond: PRICE_QUESTIONS_PER_SECOND,
    waitingAtMost: PRICE_QUESTIONS_WAITING_AT_MOST,
  });
  readonly #paymentGate = new MerchantGate({
    atOnce: PAYMENT_CHECKS_AT_ONCE,
    waitingAtMost: PAYMENT_CHECKS_WAITING_AT_MOST,
  });
  readonly #unprovenGate = new MerchantGate({
    atOnce: UNPROVEN_CHECKS_AT_ONCE,
    waitingAtMost: UNPROVEN_CHECKS_WAITING_AT_MOST,
  });
  readonly #payers = new PayerReads(
    () => this.runtime.balances,
    () => this.runtime.clock(),
  );
  /**
   * The order of each price whose payment this process is checking. Held in
   * memory because one process takes a channel's payments; the admission's
   * lock in the store still decides every write.
   */
  readonly #beingChecked = new Set<string>();
  /**
   * The polls held open right now, by merchant, with the key each came in on,
   * so revoking a key in this process ends their waiting at once rather than
   * at the end of their window. A revocation by another process is found when
   * the poll draws (`#drawFor`).
   */
  readonly #held = new Map<string, Set<HeldPoll>>();
  /**
   * When this process last wrote each merchant's poll down
   * (`CONTACT_WRITTEN_EVERY_MS`), for each integration apart, so the first poll
   * after a switch is written even when one of the integration left behind is
   * still being written as the switch goes through.
   */
  readonly #contactWritten: Readonly<Record<Integration, Map<string, number>>> = {
    api: new Map(),
    woocommerce: new Map(),
  };
  /** When this process last logged each merchant's refusals for unserved orders. */
  readonly #unservedLogged = new Map<string, number>();
  readonly #edge: PaymentEdge;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
    this.runner = new OrderRunner(runtime);
    this.#edge = new PaymentEdge(runtime.config);
  }

  /**
   * Checks the registry of payout splits against this network's payout split
   * in the code, and refuses to start where they disagree, before anything is
   * written or any work is taken; then records the split of every wallet that
   * has none. Only then starts the queue and points its reminders at
   * the order machine; each reminder becomes one event and nothing more.
   */
  async start(): Promise<void> {
    await refuseUnlessTheSplitsAgree(this.runtime);
    await recordMissingSplits(this.runtime);

    this.runtime.queue.onReminder(async (reminder) => {
      try {
        await this.#onReminder(reminder);
      } catch (thrown) {
        // Logged and rethrown: only a reminder declares an order overdue, and
        // the queue's retry is what delivers it again. Catching and re-arming
        // here would mean writing to the database whose failure just threw.
        console.error(
          `[gateway] a reminder failed (${reminder.kind}, order ${reminder.orderId}): ${failureNamed(thrown)}`,
        );
        throw thrown;
      }
    });

    await this.runtime.queue.start();

    // Claims are swept by the queue's scheduler rather than a timer of ours: it
    // survives a restart, puts one job on the queue per tick however many
    // gateways run, and registering the name again replaces the schedule. A
    // job may still be handled more than once, which forgetting claims allows.
    await this.runtime.queue.everyDay(SWEEP_CLAIMS, () => this.forgetOldClaims());
    // Forgetting is the same whichever run gets there, so a job handled twice
    // is harmless.

    // What the orders are still owed is swept the same way. Two gateways can
    // run it at once, because pg-boss re-offers a job that outlives its
    // fifteen-minute expiry, so the sweep itself runs under a named lock; a
    // queue policy would not do, as pg-boss writes queue settings only when the
    // queue is first created. A lock wedged for good shows only as the sweep's
    // "did nothing" log line, every day.
    await this.runtime.queue.everyDay(SWEEP_EFFECTS, () => this.runner.sweep());
    await this.runtime.queue.everyMinute(RECONCILE_PAYMENTS, () => this.runner.reconcilePayments());
  }

  /** One reminder, turned into one event and nothing more. */
  async #onReminder(reminder: Reminder): Promise<void> {
    if (reminder.kind === "deadline") {
      await this.runner.apply(reminder.orderId, {
        kind: "deadline_expired",
        at: reminder.at,
        deadline: reminder.deadline,
      });
      return;
    }

    // A delivery went unanswered. It counts only while it is still the
    // hand-over the order waits on, so the check and the clearing are one
    // conditional write. Split in two, a late answer, a worker's fresh
    // hand-over or a retried delivery of this same reminder lands in between,
    // and a duplicate spends a second delivery: running out closes an order
    // that has been paid for before the merchant can finish it.
    await this.runner.apply(
      reminder.orderId,
      { kind: "handler_undelivered", at: this.runtime.clock() },
      { openDeliveryId: null },
      undefined,
      reminder.handOver,
    );
  }

  /**
   * Forgets claims on payments too old to guard anything and returns how many
   * went. A claim only has to cover the window between verifying a payment and
   * executing the charge, after which the token itself refuses a reused
   * authorisation; and claims cannot be kept forever, because the route that
   * makes them takes no key.
   */
  async forgetOldClaims(): Promise<number> {
    const gone = await this.runtime.store.forgetClaimsBefore(
      this.runtime.clock() - this.runtime.config.claimRetentionMs,
    );
    if (gone > 0) {
      console.log(`[gateway] forgot ${gone} claims on payments older than the retention`);
    }
    return gone;
  }

  async stop(): Promise<void> {
    await this.runtime.queue.stop();
    this.quotes.giveUpAll();
    this.runner.purchases.giveUpAll();
  }

  // --- the catalog ----------------------------------------------------------

  /**
   * Puts one card in the catalog, or returns everything standing in its way.
   * What the merchant lacks — a name, a payout wallet, the operator's approval
   * for the live catalog — is reported beside the card's own problems and
   * first, so a screen that shows one finding shows the one the card cannot
   * explain.
   *
   * Each attempt is one result for product analytics: a new card's first
   * publication, a refusal under its first finding's reason, or a failure,
   * which is thrown on as it was. A card published again records nothing.
   */
  async publishCard(
    merchantId: string,
    body: unknown,
    integration: Integration = "api",
    askedBy?: Caller,
  ): Promise<PublishResult> {
    const acted = actedBy(askedBy);
    const at = this.runtime.clock();
    const result = (fields: CardPublishResult["fields"], item?: string): CardPublishResult =>
      ({
        name: "agc_card_publish_result",
        ...acted,
        refs: item === undefined ? { merchant: merchantId } : { merchant: merchantId, item },
        fields,
      }) as CardPublishResult;
    let published: PublishResult;
    try {
      published = await this.#publish(merchantId, body, integration, (made) =>
        result({ integration, outcome: "completed" }, made.id),
      );
    } catch (thrown) {
      this.#observe(result({ integration, outcome: "failed", reason_code: "internal_error" }), at);
      throw thrown;
    }
    if (!published.ok) {
      this.#observe(
        result({
          integration,
          outcome: "blocked",
          reason_code: publishRefusalReason(
            published.error.problems.map((problem) => problem.code),
          ),
        }),
        at,
      );
    }
    return published;
  }

  /**
   * Records an observation without waiting for it, so the answer it is about
   * goes out first; a failure to record it is only logged.
   */
  #observe(event: AnalyticsEvent, at: number): void {
    const logged = (thrown: unknown): void => {
      console.error(`[gateway] an analytics event could not be recorded: ${failureNamed(thrown)}`);
    };
    try {
      this.runtime.store.recordAnalytics(event, at).catch(logged);
    } catch (thrown) {
      logged(thrown);
    }
  }

  async #publish(
    merchantId: string,
    body: unknown,
    integration: Integration,
    made: AnalyticsOf<StoredCard>,
  ): Promise<PublishResult> {
    const parsed = CardSchema.safeParse(body);

    const merchant = await this.runtime.store.merchantById(merchantId);
    // Every caller arrives with a merchant the door already resolved, so a
    // missing one is an internal contradiction: thrown, not reported as a
    // publish finding.
    if (merchant === null) {
      throw new Error(`publishing resolved to ${merchantId}, and there is no such merchant`);
    }
    // Asked first and alone: nothing else about the card matters while it
    // would go off sale the moment it was published.
    if (merchant.integration !== integration) {
      return cardRejected([], [NOT_THE_INTEGRATION_IN_USE[integration]]);
    }
    // The question the selling word asks of every card later, asked here where
    // somebody can be told what is missing.
    const missing = missingFrom(merchant, this.runtime.config, this.runtime.clock());

    // Check the mode as sent so a malformed prepaid card still names the
    // missing merchant setting together with its own findings.
    const prepaidWithoutSite =
      typeof body === "object" &&
      body !== null &&
      siteRequiredFor((body as { readonly fulfillment?: unknown }).fulfillment) &&
      merchant.sellerSite === null
        ? [MERCHANT_FINDINGS.NO_SELLER_SITE]
        : [];
    if (!parsed.success) {
      return cardRejected([...missing, ...prepaidWithoutSite], findingsOf(parsed.error.issues));
    }
    // Asked of the parsed card, so a price written as one string meets the same
    // rule in the same words as one written as two fields.
    const unsellable = [
      ...priceProblemsOf(parsed.data.price),
      ...oversizedChallenge(this.runtime.widestChallenge(parsed.data)),
    ];
    const lacking = [...missing, ...prepaidWithoutSite];
    if (lacking.length > 0 || unsellable.length > 0) {
      return cardRejected(lacking, unsellable);
    }

    const stored = await this.runtime.store.publishCard(
      merchantId,
      parsed.data,
      this.runtime.clock(),
      integration,
      made,
    );
    if (stored.integration !== integration) {
      return cardRejected([], [heldByTheOther(integration, parsed.data.merchant_item_id)]);
    }
    return { ok: true, id: stored.id };
  }

  /**
   * The catalog an agent reads: the cards that can be bought now
   * (`offSaleNow`), because an agent budgets against what it lists and would
   * only find out at the till. The sellers stopped for their unserved orders
   * are asked in one read, for the sellers of the cards otherwise listed.
   */
  async catalog(): Promise<{ readonly items: ProjectedCard[] }> {
    const entries = await this.runtime.store.catalogEntries();
    const at = this.runtime.clock();
    const open = entries.flatMap((entry) => {
      const selling = sellingFor(
        entry.merchant,
        entry.card,
        sellableBy({ ...entry, id: entry.card.merchantId }, this.runtime.config, at),
        entry.integration,
      );
      return selling === "open" ? [{ ...entry, selling }] : [];
    });
    const stopped = await this.runtime.store.stoppedSellers(
      [...new Set(open.map((entry) => entry.card.merchantId))],
      UNSERVED_AT_MOST,
    );
    return {
      items: open
        .filter(
          (entry) =>
            offSaleNow(
              {
                selling: entry.selling,
                price: entry.card.card.price,
                fulfillment: entry.card.card.fulfillment,
                sellerSite: entry.sellerSite,
                unserved: stopped.has(entry.card.merchantId),
                lastContact: entry.lastContact,
              },
              at,
            ) === null,
        )
        .map((entry) =>
          publicCardOf(cardAsHeld(entry.card.card, this.runtime.config), {
            id: entry.card.id,
            purchase_url: purchaseUrlOf(this.runtime.config, entry.card.id),
            as_of: asTimestamp(entry.card.asOf),
            seller: { name: entry.serviceName, site: entry.sellerSite },
          }),
        ),
    };
  }

  /**
   * One product as a thing that can be paid for, or null where there is no
   * such card. A card off sale is one whose purchase the door refuses, so it
   * must not be offered a challenge. Unscoped, like every read on the buying
   * surface: an agent has no key.
   */
  async paidResource(itemId: string): Promise<PaidResource | null> {
    const stored = await this.runtime.store.cardById(itemId);
    if (stored === null) {
      return null;
    }
    const merchant = await this.runtime.store.merchantById(stored.merchantId);
    const at = this.runtime.clock();
    return {
      stored,
      // The database refuses a card with no owner; if one were ever found, the
      // safe reading is that it is not for sale.
      offSale:
        merchant === null
          ? { code: "not_selling", transient: false }
          : offSaleNow(saleFactsOf(stored, await this.#theirsOf(merchant, at)), at),
      serviceName: merchant?.serviceName ?? null,
      // A pending wallet change's split is the one paid once its moment has
      // come, and not before.
      payTo: merchant === null ? null : payToAt(merchant, this.runtime.config, at),
    };
  }

  // --- the merchant's own catalog -------------------------------------------

  /**
   * Every card this merchant published, with the word each sells under. The
   * store's query carries the merchant, so another merchant's card is never
   * selected rather than selected and filtered out.
   */
  async merchantCards(merchantId: string): Promise<MerchantCardList> {
    const theirs = await this.#howTheySell(merchantId);
    const cards = await this.runtime.store.cards(merchantId);
    return {
      selling: theirs.selling,
      cards: cards.map((stored) => merchantCardOf(stored, theirs, this.runtime.clock())),
    };
  }

  /** One own card, with the same selling decision as the complete catalogue. */
  async merchantCard(merchantId: string, id: string): Promise<MerchantCard | null> {
    const stored = await this.runtime.store.cardById(id);
    if (stored?.merchantId !== merchantId) return null;
    return merchantCardOf(stored, await this.#howTheySell(merchantId), this.runtime.clock());
  }

  /**
   * The merchant's selling word, the integration they sell through, whether a
   * sale of theirs could be made at all (a payout wallet and a name), whether
   * they are stopped for unserved orders and when their code last polled.
   * Every key and every card names a merchant that exists, so a missing one is
   * a defect and this throws rather than answer "open" for somebody nobody can
   * find.
   */
  async #howTheySell(merchantId: string): Promise<HowTheySell> {
    const merchant = await this.runtime.store.merchantById(merchantId);
    if (merchant === null) {
      throw new Error(`there is no merchant ${merchantId}, so there is no word for their selling`);
    }
    return await this.#theirsOf(merchant, this.runtime.clock());
  }

  /** `#howTheySell` for a merchant already read. */
  async #theirsOf(merchant: StoredMerchant, at: number): Promise<HowTheySell> {
    return {
      selling: merchant.selling,
      sellable: sellableBy(merchant, this.runtime.config, at),
      sellerSite: merchant.sellerSite,
      integration: merchant.integration,
      unserved: await this.#unserved(merchant.id),
      lastContact: await this.runtime.store.lastContact(merchant.id),
    };
  }

  /**
   * Takes one card off sale, or puts it back; null where there is no such card.
   * Open orders are untouched: the machine guards only the birth of an order.
   */
  async setCardPaused(
    merchantId: string,
    itemId: string,
    paused: boolean,
    askedBy?: Caller,
  ): Promise<MerchantCard | null> {
    const stored = await this.runtime.store.setCardPaused(
      merchantId,
      itemId,
      paused,
      (card): SellingChanged => ({
        name: "agc_selling_changed",
        ...actedBy(askedBy),
        refs: { merchant: merchantId, item: card.id },
        fields: { entity: "card", change: paused ? "paused" : "resumed" },
      }),
    );
    if (stored === null) {
      // No such card, or not this merchant's: the same answer on purpose, so a
      // pause call cannot probe what somebody else sells.
      return null;
    }
    return merchantCardOf(stored, await this.#howTheySell(merchantId), this.runtime.clock());
  }

  /**
   * Stops all selling for this merchant, or starts it again. Resuming leaves
   * the cards paused in their own right paused, and the answer carries the
   * whole catalog so which cards came back is stated rather than inferred.
   */
  async setSelling(
    merchantId: string,
    selling: MerchantSelling,
    askedBy?: Caller,
  ): Promise<MerchantCardList> {
    await this.runtime.store.setSelling(merchantId, selling, {
      name: "agc_selling_changed",
      ...actedBy(askedBy),
      refs: { merchant: merchantId },
      fields: { entity: "merchant", change: selling === "paused" ? "paused" : "resumed" },
    });
    return this.merchantCards(merchantId);
  }

  /**
   * The integration this merchant sells through now, their cards that are off
   * sale because the other one published them, and their own selling word,
   * for the screens that say why a card is not selling.
   */
  async integrationOf(merchantId: string): Promise<{
    readonly through: Integration;
    readonly offSale: readonly string[];
    readonly selling: MerchantSelling;
  }> {
    const merchant = await this.runtime.store.merchantById(merchantId);
    if (merchant === null) {
      throw new Error(`there is no merchant ${merchantId}, so nothing they sell through`);
    }
    const through = merchant.integration;
    const cards = await this.runtime.store.cards(merchantId);
    return {
      through,
      offSale: cards.filter((card) => card.integration !== through).map((card) => card.id),
      selling: merchant.selling,
    };
  }

  /**
   * What the dashboard says over every page about a merchant, from one read of
   * their row, and of their cards only while their integration is silent:
   * whether they are selling and through which integration, the name they
   * sell under, the wallet paid now, whether the operator has approved them
   * for live sales, and, while purchases of theirs are refused for that
   * silence, when their integration last polled (null where it never has), and
   * whether as many of their purchases wait for payment as the door allows,
   * so that the next is refused, and whether as many of their paid orders are
   * left unserved as the door allows; and, on the live channel while an
   * operator's withdrawal of their admission stands, when it was withdrawn and
   * the note the operator wrote for them. Each answer is the one the call that
   * reads it alone gives.
   */
  async standingOf(merchantId: string): Promise<{
    readonly selling: MerchantSelling;
    readonly through: Integration;
    readonly sellerName: string | null;
    readonly payoutWallet: string | null;
    readonly pendingPayoutWallet: {
      readonly address: string;
      readonly takesEffectAt: number;
    } | null;
    readonly liveApproved: boolean;
    readonly hasProducts: boolean;
    readonly lastContact: number | null;
    readonly contactAlive: boolean;
    readonly outOfTouch: { readonly since: number | null } | null;
    readonly unserved: boolean;
    readonly withdrawn: { readonly at: number; readonly note: string | null } | null;
  }> {
    const merchant = await this.runtime.store.merchantById(merchantId);
    if (merchant === null) {
      throw new Error(`this call was made as ${merchantId}, and there is no such merchant`);
    }
    const at = this.runtime.clock();
    const wallet = payoutWalletAt(merchant.payoutWallet, at);
    const lastContact = await this.runtime.store.lastContact(merchant.id);
    return {
      hasProducts: await this.runtime.store.hasProducts(merchantId, merchant.integration),
      lastContact,
      contactAlive: !silentAt(lastContact, at),
      selling: merchant.selling,
      through: merchant.integration,
      sellerName: merchant.serviceName,
      payoutWallet: wallet.address,
      pendingPayoutWallet:
        wallet.pending === null
          ? null
          : { address: wallet.pending.address, takesEffectAt: wallet.pending.takesEffectAt },
      liveApproved: merchant.liveApprovedAt !== null,
      outOfTouch: await this.#refusedForSilence(merchant, at, lastContact),
      // Read while paused too, so a seller learns of it before resuming into it.
      unserved: await this.#unserved(merchant.id),
      withdrawn: await this.#standingWithdrawal(merchant),
    };
  }

  /**
   * The withdrawal of this merchant's admission that stands, read only on the
   * live channel, the one that asks for admission, and only while they are not
   * admitted. Its reason is the note the operator wrote for them to read.
   */
  async #standingWithdrawal(
    merchant: StoredMerchant,
  ): Promise<{ readonly at: number; readonly note: string | null } | null> {
    if (this.runtime.config.surfaceMode !== "live" || merchant.liveApprovedAt !== null) return null;
    const row = await this.runtime.store.standingWithdrawal(merchant.id);
    return row === null ? null : { at: row.at, note: row.reason };
  }

  /**
   * When the integration this merchant sells through last polled, where the
   * silence since is what refuses a purchase of theirs and keeps their cards
   * out of the catalogue: nothing else holds their sales, and a card of that
   * integration is on sale. Null where nothing is refused for it.
   */
  async #refusedForSilence(
    merchant: StoredMerchant,
    at: number,
    since: number | null,
  ): Promise<{ readonly since: number | null } | null> {
    if (merchant.selling !== "open" || !sellableBy(merchant, this.runtime.config, at)) {
      return null;
    }
    if (!silentAt(since, at)) {
      return null;
    }
    const cards = await this.runtime.store.cards(merchant.id);
    const onSale = cards.some(
      (stored) => !stored.paused && stored.integration === merchant.integration,
    );
    return onSale ? { since } : null;
  }

  /** The integration this merchant sells through now. */
  async sellsThrough(merchantId: string): Promise<Integration> {
    const merchant = await this.runtime.store.merchantById(merchantId);
    if (merchant === null) {
      throw new Error(`there is no merchant ${merchantId}, so nothing they sell through`);
    }
    return merchant.integration;
  }

  /**
   * Moves this merchant to the other integration, or says which orders hold
   * them where they are (`IntegrationSwitch`). A poll held open across the
   * switch ends with nothing, whichever integration's it was: the one being
   * left has nothing more coming to it, and the one taking over has just been
   * told what it is. A switch that stops the merchant's selling records that
   * pause for product analytics, as the caller's.
   */
  async sellThrough(
    merchantId: string,
    to: Integration,
    askedBy?: Caller,
  ): Promise<IntegrationSwitch> {
    const switched = await this.runtime.store.switchIntegration(merchantId, to, {
      name: "agc_selling_changed",
      ...actedBy(askedBy),
      refs: { merchant: merchantId },
      fields: { entity: "merchant", change: "paused" },
    });
    if (switched.switched) {
      this.#letGo(merchantId, () => true);
      // The first poll after a switch is written at once, even back on an
      // integration whose poll this process wrote moments ago.
      this.#contactWritten.api.delete(merchantId);
      this.#contactWritten.woocommerce.delete(merchantId);
    }
    return switched;
  }

  /**
   * The orders that would refuse this merchant's switch to `to` if it were
   * asked now, with nothing switched; none where it would be made. Only a
   * read: the switch itself decides, and an order made in between holds it.
   */
  async switchHeldBy(merchantId: string, to: Integration): Promise<readonly string[]> {
    return await this.runtime.store.switchHeldBy(merchantId, to);
  }

  /**
   * Every receipt this merchant has. The merchant is in the query, so somebody
   * else's receipt is never read at all.
   */
  async receipts(merchantId: string): Promise<ReceiptList> {
    return { receipts: [...(await this.runtime.store.receipts(merchantId))] };
  }

  // --- merchants and their keys ---------------------------------------------

  /**
   * Registers a merchant and returns their identifier. Only the dashboard
   * reaches it, in-process for a signed-in person: it decides beforehand
   * whether they may and writes the merchant onto their account. The new
   * merchant has no seller name, so publishing is refused until they set one.
   */
  async registerMerchant(): Promise<string> {
    const registered = await registerMerchant(
      this.runtime.store,
      this.runtime.ids,
      this.runtime.clock(),
    );

    if (registered === null) {
      // A freshly generated identifier was taken: a collision rather than a
      // second registration, and nothing a caller can fix.
      throw new Error(
        "registering made no merchant: the identifier it generated was already taken",
      );
    }
    return registered.id;
  }

  /** Whether the operator has approved this merchant for live sales. */
  async liveApproved(merchantId: string): Promise<boolean> {
    const merchant = await this.runtime.store.merchantById(merchantId);
    if (merchant === null) {
      throw new Error(`this call was made as ${merchantId}, and there is no such merchant`);
    }
    return merchant.liveApprovedAt !== null;
  }

  /**
   * What this merchant's products are sold under. Having no name is an
   * ordinary state, answered with null; a merchant missing behind a key the
   * door just resolved is the gateway contradicting itself, so it throws.
   */
  async sellerName(merchantId: string): Promise<SellerName> {
    const merchant = await this.runtime.store.merchantById(merchantId);
    if (merchant === null) {
      throw new Error(`this call was made as ${merchantId}, and there is no such merchant`);
    }
    return { seller_name: merchant.serviceName, seller_site: merchant.sellerSite };
  }

  /**
   * Who sold an order, as an agent reads it on the order's status: the
   * merchant's name and site as they stand now, not as they stood at the sale.
   * A missing merchant throws rather than reading as a seller who gave no name
   * and no site, which would turn "unknown" into a claim.
   */
  async sellerOf(merchantId: string): Promise<Seller> {
    const merchant = await this.runtime.store.merchantById(merchantId);
    if (merchant === null) {
      throw new Error(`an order names the merchant ${merchantId}, and there is no such merchant`);
    }
    return { name: merchant.serviceName, site: merchant.sellerSite };
  }

  /**
   * Sets what this merchant's products are sold under. A name cannot be taken
   * away here: without one every card of theirs comes off sale, which must not
   * arrive as an edit to a setting. The answer is read off the written row
   * rather than echoed, so it shows whether the write landed.
   */
  async setSellerName(
    merchantId: string,
    asked: SellerNameRequest,
    askedBy?: Caller,
  ): Promise<SellerName> {
    // Only the fields the request names are written; one left out stays as it
    // was. The route already checked both, so a throw from either is a caller
    // that skipped it.
    const at = this.runtime.clock();
    const acted = actedBy(askedBy);
    let merchant = await this.runtime.store.merchantById(merchantId);
    if (asked.seller_name !== undefined) {
      merchant = await setServiceName(
        this.runtime.store,
        merchantId,
        asked.seller_name,
        at,
        setupResult(merchantId, acted, "seller_name", { outcome: "completed" }),
      );
    }
    if (asked.seller_site !== undefined) {
      merchant = await setSellerSite(
        this.runtime.store,
        merchantId,
        asked.seller_site,
        at,
        setupResult(merchantId, acted, "seller_site", { outcome: "completed" }),
      );
    }
    if (merchant === null) {
      throw new Error(`this call was made as ${merchantId}, and there is no such merchant`);
    }
    return { seller_name: merchant.serviceName, seller_site: merchant.sellerSite };
  }

  /** Fills a missing seller site, preserving any site chosen before the write lands. */
  async fillSellerSite(merchantId: string, site: string, askedBy: Caller): Promise<SellerName> {
    const merchant = await setSellerSite(
      this.runtime.store,
      merchantId,
      site,
      this.runtime.clock(),
      setupResult(merchantId, actedBy(askedBy), "seller_site", { outcome: "completed" }),
      true,
    );
    if (merchant === null) throw new Error("the merchant whose site was being filled is missing");
    return { seller_name: merchant.serviceName, seller_site: merchant.sellerSite };
  }

  /**
   * Records setup steps the API refused before anything was written, such as
   * a seller name the contract does not carry, one result for each step the
   * refused call asked for. The refusal's answer is the route's own.
   */
  async setupRefused(
    merchantId: string,
    steps: readonly ("seller_name" | "seller_site" | "api_key")[],
    askedBy: Caller,
  ): Promise<void> {
    for (const step of steps) {
      await this.runtime.store.recordAnalytics(
        setupResult(merchantId, actedBy(askedBy), step, {
          outcome: "blocked",
          reason_code: "invalid_input",
        }),
        this.runtime.clock(),
      );
    }
  }

  /**
   * Where this merchant's sales are paid, as it stands now. Having none is an
   * ordinary state rather than a refusal.
   */
  async payoutWallet(merchantId: string): Promise<PayoutWallet> {
    const merchant = await this.runtime.store.merchantById(merchantId);
    if (merchant === null) {
      throw new Error(`this call was made as ${merchantId}, and there is no such merchant`);
    }
    return payoutWalletAnswer(payoutWalletAt(merchant.payoutWallet, this.runtime.clock()));
  }

  /**
   * This merchant's payout splits on this network, for their payout screen:
   * the split of the wallet in force now, the split of a wallet waiting (null
   * where none waits), and every split that can hold money, which their
   * payout transaction covers: the one in force and each one a payment of
   * theirs was checked against, in the order they were recorded. Only their
   * own; the dashboard calls it in-process, and no route answers with it.
   */
  async payoutSplitsOf(merchantId: string): Promise<{
    readonly inForce: RecordedPayoutSplit | null;
    readonly pending: RecordedPayoutSplit | null;
    readonly toPayOut: readonly RecordedPayoutSplit[];
  }> {
    const merchant = await this.runtime.store.merchantById(merchantId);
    if (merchant === null) {
      throw new Error(`this call was made as ${merchantId}, and there is no such merchant`);
    }
    const at = this.runtime.clock();
    const now = payoutWalletAt(merchant.payoutWallet, at);
    return {
      inForce: now.split,
      pending: now.pending?.split ?? null,
      toPayOut: await this.runtime.store.splitsToPayOutFor(
        this.runtime.config.payoutSplit.network,
        merchantId,
        at,
      ),
    };
  }

  /**
   * Every split recorded on this network, every merchant's, for the
   * operator's payout, in the order they were recorded: any of them
   * may hold money, and a payout of one that holds nothing costs only gas.
   * A split waiting behind a wallet change not yet in force is left out and
   * counted, unless it can hold money already: until the change lands nobody
   * is asked to pay into it, and its address is the merchant's new wallet.
   * Across merchants on purpose, so nothing reachable from a request may call
   * it.
   */
  async splitsToPayOut(): Promise<{
    readonly splits: readonly RecordedPayoutSplit[];
    readonly waiting: number;
  }> {
    const { store, config, clock } = this.runtime;
    const network = config.payoutSplit.network;
    const at = clock();
    const waiting: string[] = [];
    for (const merchant of await store.merchants()) {
      const split = payoutWalletAt(merchant.payoutWallet, at).pending?.split;
      if (split == null) continue;
      const holding = await store.splitsToPayOutFor(network, merchant.id, at);
      if (!holding.some((each) => isSameAddress(each.address, split.address))) {
        waiting.push(split.address);
      }
    }
    const recorded = await store.payoutSplitsOn(network);
    const splits = recorded.filter(
      (split) => !waiting.some((address) => isSameAddress(address, split.address)),
    );
    return { splits, waiting: recorded.length - splits.length };
  }

  /**
   * Sets where this merchant's sales are paid, or asks for a change of it to
   * wait, and returns the wallet as it then stands or why it was refused. Only
   * a dashboard session reaches it, in-process; no route at the door calls it,
   * so a copied key can neither move the money nor send a message about it.
   *
   * Where no money is real (the test channel and the sandbox) the address
   * applies at once and nobody is told. On the live deployment the first
   * address applies at once and is announced afterwards, since it replaces
   * nothing. A replacement is announced to every account naming the merchant
   * before anything is written, and recorded as pending for forty-eight hours
   * only if every message was handed over: a change nobody was told of is the
   * dangerous failure, while a message about a change that then did not land
   * is safe, because the message says the change holds only if the wallet
   * screen shows it.
   *
   * Asking for the pending address again is a retry and sends nothing; asking
   * for the current address while a change is pending cancels it, written at
   * once and announced afterwards. An address is the same in either spelling.
   * A wallet in force with no recorded split is paid nothing, so the wallet set
   * over it replaces nothing and is set as a first one is. A replacement is
   * announced from the split recorded for the wallet in force, the one buyers
   * pay into until it applies. No lock is held across the announcement:
   * the write is conditional on the row still holding what was read, so a
   * change recorded in between turns this one away as `raced`. The answer is
   * read off the written row, never echoed.
   *
   * On every path, live or not, an address a merchant's share could never
   * come back from is refused first, before any message goes out: any
   * merchant's split, a commission wallet, a contract a payout calls, a
   * network's token, or the zero address. Every address written is recorded
   * with its split in the same write.
   *
   * Each change asked for is one result for product analytics: a wallet
   * applied, a change left waiting, or a refusal. Asking again for what
   * already stands records nothing.
   */
  async setPayoutWallet(
    merchantId: string,
    wallet: string,
    askedBy: SignedIn,
  ): Promise<PayoutWallet | WalletChangeRefusal> {
    const acted = actedBy(askedBy);
    const answer = await this.#changePayoutWallet(merchantId, wallet, askedBy, acted);
    const refused = walletRefusalOf(answer);
    if (refused !== null) {
      await this.runtime.store.recordAnalytics(
        setupResult(merchantId, acted, "payout_wallet", refused),
        this.runtime.clock(),
      );
    }
    return answer;
  }

  async #changePayoutWallet(
    merchantId: string,
    wallet: string,
    askedBy: SignedIn,
    acted: ActedBy,
  ): Promise<PayoutWallet | WalletChangeRefusal> {
    const askedWith: AskedInTheDashboard = { kind: "signed_in", email: askedBy.email };
    // The dashboard holds the same rule on the way in, so a throw from here is
    // a caller that skipped it.
    const address = payoutWalletFrom(wallet);
    const is = await whyTheRuleRefuses(this.runtime, address);
    if (is !== null) {
      return { refused: "not_a_payout_wallet", is };
    }
    const merchant = await this.runtime.store.merchantById(merchantId);
    if (merchant === null) {
      throw new Error(`this call was made as ${merchantId}, and there is no such merchant`);
    }
    const read = merchant.payoutWallet;
    const now = payoutWalletAt(read, this.runtime.clock());
    // The row held `read` when any write below lands, so comparing the two
    // says whether the wallet changed or the same one was saved again.
    const saved: AnalyticsOf<WalletWritten> = (written) =>
      walletMoved(read, written.merchant.payoutWallet)
        ? setupResult(merchantId, acted, "payout_wallet", {
            outcome: written.merchant.payoutWallet.pending === null ? "completed" : "pending",
          })
        : null;
    // Every address written goes with its split, computed by this network's
    // payout split and recorded in the same write as the wallet.
    const splitOf = (wallet: string): PayoutSplit =>
      payoutSplitFor(this.runtime.config.payoutSplit, merchantId, wallet);
    const alone = { address, split: splitOf(address), pending: null };

    if (!this.#announces()) {
      return await this.#recordWallet(merchantId, read, alone, saved);
    }

    const paidNow = now.split;
    if (paidNow === null) {
      // The first address replaces nothing, so it waits on nothing and a
      // message that cannot be sent refuses nothing; the message is how the
      // owner hears of a session that is not theirs setting it.
      const set = await this.#recordWallet(merchantId, read, alone, saved);
      if (typeof set !== "string") {
        this.#announceAfterwards({
          kind: "wallet_set",
          merchant_id: merchantId,
          to: address,
          to_split: alone.split.address,
          asked_with: askedWith,
        });
      }
      return set;
    }

    if (isSameAddress(address, paidNow.merchantWallet)) {
      if (now.pending === null) {
        return payoutWalletAnswer(now);
      }
      const cancelled = now.pending.address;
      const written = await this.#recordWallet(merchantId, read, alone, saved);
      if (typeof written !== "string") {
        this.#announceAfterwards({
          kind: "wallet_change_cancelled",
          merchant_id: merchantId,
          kept: address,
          kept_split: alone.split.address,
          cancelled,
          asked_with: askedWith,
        });
      }
      return written;
    }

    if (now.pending !== null && isSameAddress(now.pending.address, address)) {
      return payoutWalletAnswer(now);
    }

    // The splits the message names are the ones the write records, or finds
    // recorded as these, or it refuses: the merchant is never told of an
    // address buyers will not pay.
    const told = await this.#announce({
      kind: "wallet_change",
      merchant_id: merchantId,
      from: paidNow.merchantWallet,
      from_split: paidNow.address,
      to: address,
      to_split: alone.split.address,
      not_before: asTimestamp(this.runtime.clock() + WALLET_CHANGE_WAITS_MS),
      asked_with: askedWith,
    });
    if (told !== "handed_over") {
      console.warn(`[gateway] a payout wallet change for ${merchantId} was refused: ${told}`);
      return told === "not_handed_over" ? "not_announced" : told;
    }
    // Counted from now, after every message was handed over, so the change
    // takes effect no earlier than the moment any message named.
    const recorded = await this.#recordWallet(
      merchantId,
      read,
      {
        address: paidNow.merchantWallet,
        split: paidNow,
        pending: {
          address,
          takesEffectAt: this.runtime.clock() + WALLET_CHANGE_WAITS_MS,
          split: alone.split,
        },
      },
      saved,
    );
    return recorded === "raced" ? "raced_after_announcing" : recorded;
  }

  /**
   * Refuses, in words, where the registry of payout splits disagrees with this
   * network's payout split in the code (`RefusedToStart`). `start` asks it
   * first; a command that reads the registry asks it alone, starting nothing.
   */
  async refuseUnlessTheSplitsAgree(): Promise<void> {
    await refuseUnlessTheSplitsAgree(this.runtime);
  }

  /** Whether this deployment waits on and announces a change: the live one alone. */
  #announces(): boolean {
    return this.runtime.config.surfaceMode === "live";
  }

  /**
   * Writes a merchant's wallet where the row still holds what was read, and
   * answers with it as it then stands — or `raced` where it moved to anything
   * but what this write asked for.
   */
  async #recordWallet(
    merchantId: string,
    read: PayoutWalletRead,
    next: PayoutWalletWrite,
    saved: AnalyticsOf<WalletWritten>,
  ): Promise<PayoutWallet | "raced"> {
    const written = await this.runtime.store.setPayoutWallet(
      merchantId,
      read,
      next,
      this.runtime.clock(),
      saved,
    );
    if (written === null) {
      throw new Error(`this call was made as ${merchantId}, and there is no such merchant`);
    }
    if (written !== "moved") {
      journal(written.recorded);
      return payoutWalletAnswer(
        payoutWalletAt(written.merchant.payoutWallet, this.runtime.clock()),
      );
    }
    // Another write landed in between. If it wrote exactly what this call
    // asked for, it was a retry after a dropped connection, and the answer is
    // that change rather than a refusal, because asking again must be safe.
    const merchant = await this.runtime.store.merchantById(merchantId);
    const standing =
      merchant === null ? null : payoutWalletAt(merchant.payoutWallet, this.runtime.clock());
    const asked = next.pending;
    return standing !== null &&
      standing.address === next.address &&
      (asked === null ? standing.pending === null : standing.pending?.address === asked.address)
      ? payoutWalletAnswer(standing)
      : "raced";
  }

  /**
   * Asks the dashboard to tell the merchant. A telling that threw or did not
   * finish within `ANNOUNCEMENT_ANSWER_MS` counts as not handing every message
   * over, though some may have gone out.
   */
  async #announce(announcement: Announcement): Promise<AnnouncementOutcome> {
    let cut: ReturnType<typeof setTimeout> | undefined;
    const outOfTime = new Promise<"out_of_time">((resolve) => {
      cut = setTimeout(() => resolve("out_of_time"), ANNOUNCEMENT_ANSWER_MS);
      cut.unref?.();
    });
    try {
      const told = await Promise.race([this.runtime.announcer.announce(announcement), outOfTime]);
      if (told === "out_of_time") {
        console.error(
          `[gateway] an announcement (${announcement.kind}) did not finish within ${ANNOUNCEMENT_ANSWER_MS} ms`,
        );
        return "not_handed_over";
      }
      return told;
    } catch (thrown) {
      console.error(
        `[gateway] an announcement (${announcement.kind}) failed: ${failureNamed(thrown)}`,
      );
      return "not_handed_over";
    } finally {
      clearTimeout(cut);
    }
  }

  /**
   * Announces something already done, without waiting: a new key or a
   * cancelled change is not refused, delayed or undone for want of a message.
   * The outcome goes to the log and nowhere else.
   */
  #announceAfterwards(announcement: Announcement): void {
    void this.#announce(announcement).then((outcome) => {
      if (outcome !== "handed_over") {
        console.warn(
          `[gateway] ${announcement.kind} for ${announcement.merchant_id} was done and not announced: ${outcome}`,
        );
      }
    });
  }

  /** This merchant's keys, revoked ones included. */
  async merchantKeys(merchantId: string): Promise<readonly MerchantKey[]> {
    return (await this.runtime.store.keysOf(merchantId)).map(merchantKeyOf);
  }

  /**
   * Issues another key for this merchant's own code and returns its secret
   * once. On the live deployment the merchant is told afterwards and the key
   * never waits on the message: a key cannot move money or set the wallet, and
   * mail being down must not keep a merchant from a key.
   */
  async issueMerchantKey(
    merchantId: string,
    label: string,
    askedBy: SignedIn,
  ): Promise<IssuedMerchantKey> {
    const issued = await issueKey(
      this.runtime.store,
      this.runtime.ids,
      merchantId,
      // Throws with the schema's own words, which the dashboard checks for
      // first and shows.
      NewKeyLabelSchema.parse(label),
      this.runtime.clock(),
      this.runtime.config.environment,
      setupResult(merchantId, actedBy(askedBy), "api_key", { outcome: "completed" }),
    );
    if (this.#announces()) {
      this.#announceAfterwards({
        kind: "key_issued",
        merchant_id: merchantId,
        key: { id: issued.key.id, label: issued.key.label },
        asked_with: { kind: "signed_in", email: askedBy.email },
      });
    }
    return { key: merchantKeyOf(issued.key), secret: issued.secret };
  }

  /**
   * Stops one of this merchant's keys working, any of them, the one their own
   * code calls with included: a session holds no key it could lock itself out
   * with. `null` is a key that does not exist or is somebody else's, told
   * apart nowhere, so a refusal cannot count another merchant's keys.
   */
  async disableMerchantKey(merchantId: string, keyId: string): Promise<MerchantKey | null> {
    const disabled = await this.runtime.store.disableKeyOf(merchantId, keyId, this.runtime.clock());
    if (disabled === null) {
      return null;
    }
    this.#letGo(merchantId, (held) => held.keyId === keyId);
    return merchantKeyOf(disabled.key);
  }

  // --- buying ---------------------------------------------------------------

  /**
   * Prices a purchase without durable state. The merchant is asked only when
   * the card calls for a check; the answer becomes a buyer-held stamped offer.
   */
  async beginPurchase(
    itemId: string,
    params: Readonly<Record<string, unknown>>,
    shipTo?: ShipTo,
  ): Promise<PurchaseAttempt> {
    const stored = await this.runtime.store.cardById(itemId);
    if (stored === null) {
      return { step: "no_such_item" };
    }
    if (this.#isListedExample(stored, params, shipTo)) {
      return { step: "listed_example", itemId };
    }

    const fit = purchaseCheckFor(stored.card).safeParse(params);
    if (!fit.success) {
      return { step: "params_rejected", problems: findingsOf(fit.error.issues) };
    }

    // An address sent with anything but a parcel would be a buyer's details
    // handed over for nothing, so it is refused rather than dropped.
    const parcel = stored.card.fulfillment === "ship";
    if (parcel && shipTo === undefined) {
      return {
        step: "ship_to_rejected",
        message:
          "this product is a parcel, and its purchase carries ship_to, the address it goes to",
      };
    }
    if (!parcel && shipTo !== undefined) {
      return {
        step: "ship_to_rejected",
        message: "this product is not shipped, so its purchase takes no ship_to",
      };
    }

    const at = this.runtime.clock();
    const theirs = await this.#howTheySell(stored.merchantId);
    // Before the order is written or the price asked, and in every mode.
    const off = offSaleNow(saleFactsOf(stored, theirs), at);
    switch (off?.code) {
      case "not_selling":
        return { step: "not_selling", message: off.message ?? NOT_ON_SALE };
      case "seller_not_fulfilling":
        this.#sayUnserved(stored.merchantId, at);
        return { step: "seller_not_fulfilling" };
      case "seller_not_taking_orders":
        return { step: "seller_not_taking_orders" };
      case undefined:
        break;
    }

    const priceId = this.runtime.ids("prc");
    const created = createOrder({
      id: orderIdForPrice({ priceId, itemId, merchantId: stored.merchantId }),
      at,
      mode: modeForCard(stored.card),
      policy: policyFor(stored.card, this.runtime.config),
      priceCheck: priceCheckOf(stored.card),
      cardPrice: { ...stored.card.price, asOf: stored.asOf },
      test: this.runtime.config.environment === "test",
      selling: sellingFor(theirs.selling, stored, theirs.sellable, theirs.integration),
    });
    if (!created.ok) return { step: "not_selling", message: created.rejection.message };
    let order = created.order;
    let reference: string | undefined;
    let unavailable = false;
    if (priceCheckOf(stored.card) === "merchant") {
      const entered = await this.#priceGate.enter(
        stored.merchantId,
        Math.min(PRICE_PLACE_WAIT_MS, this.runtime.config.deadlines.quoteResponseMs / 2),
      );
      const place = typeof entered === "function" ? entered : null;
      if (place === null) gateRefused("price");
      // A synchronous card with no place sells at its card price, as in a silence.
      if (place === null && order.mode.settle !== "after_fulfillment") {
        return { step: "seller_busy", why: QUESTIONS_FULL };
      }
      let answer: QuoteResponse | null = null;
      if (place !== null) {
        const asked = this.runtime.clock();
        try {
          answer = await this.#askThePrice(
            stored,
            fit.data as Readonly<Record<string, unknown>>,
            priceId,
            at,
            shipTo,
          );
        } finally {
          place();
        }
        priceAnswered(
          answer === null ? "silent" : answer.available ? "answered" : "unavailable",
          stored.integration,
          this.runtime.clock() - asked,
        );
      }
      unavailable = answer?.available === false;
      const pricedAt = this.runtime.clock();
      const event =
        answer === null
          ? { kind: "quote_silent" as const, at: pricedAt }
          : answer.available
            ? {
                kind: "quote_answered" as const,
                at: pricedAt,
                available: true as const,
                price: { ...answer.price, asOf: Date.parse(answer.as_of) },
              }
            : { kind: "quote_answered" as const, at: pricedAt, available: false as const };
      const priced = transition(order, event);
      if (!priced.ok) return { step: "not_selling", message: priced.rejection.message };
      order = priced.order;
      if (answer?.available) reference = answer.quote_reference;
    }
    if (order.price === null || order.timestamps.quotedAt === null || order.quoteSource === null) {
      return unavailable
        ? { step: "not_selling", message: MERCHANT_SAID_UNAVAILABLE }
        : {
            step: "seller_busy",
            why: NO_PRICE_IN_TIME,
            retryAfterSeconds: SILENT_PRICE_RETRY_AFTER_SECONDS,
          };
    }
    const merchant = await this.runtime.store.merchantById(stored.merchantId);
    const payTo =
      merchant === null ? null : payToAt(merchant, this.runtime.config, this.runtime.clock());
    if (payTo === null) return { step: "not_selling", message: NOT_ON_SALE };
    const terms = this.#edge.requirementsFor(order.price, null, payTo);
    const key = this.runtime.config.priceStampKeys.current;
    const offer: PriceOffer = {
      version: 1,
      priceId,
      itemId,
      merchantId: stored.merchantId,
      integration: stored.integration,
      cardDigest: priceFactsDigest(this.#cardFacts(stored), key, "card"),
      paramsDigest: priceFactsDigest(fit.data as Readonly<Record<string, unknown>>, key, "params"),
      placeDigest: priceFactsDigest(shipTo === undefined ? null : localityOf(shipTo), key, "place"),
      amount: order.price.amount,
      currency: order.price.currency as "USD" | "USDC",
      source: order.quoteSource,
      asOf: order.price.asOf,
      quotedAt: order.timestamps.quotedAt,
      expiresAt: order.timestamps.quotedAt + order.policy.deadlines.quoteTtlMs,
      network: terms.network,
      payTo: terms.payTo,
      asset: terms.asset,
      assetName: String(terms.extra?.name),
      assetVersion: String(terms.extra?.version),
      maxTimeoutSeconds: terms.maxTimeoutSeconds,
      ...(reference === undefined ? {} : { quoteReference: reference }),
    };
    const stamp = stampPrice(offer, key);
    return {
      step: "pay",
      order: {
        order,
        merchantId: stored.merchantId,
        itemId,
        merchantItemId: stored.card.merchant_item_id,
        params: fit.data as Readonly<Record<string, unknown>>,
        through: stored.integration,
        ...(stored.card.result === undefined ? {} : { result: stored.card.result }),
        priceId: order.quoteSource === "merchant_answer" ? priceId : null,
        priceOffer: {
          stamp,
          expiresAt: offer.expiresAt,
          requirements: this.#requirementsOf(offer, stamp),
        },
      },
    };
  }

  /**
   * Whether a purchase body is the card's own listed example, where that
   * example holds a stand-in no buyer sends: the word naming a string
   * parameter's type, or the schema's sample address. A discovery catalog
   * replays it after a payment goes through. A stand-in for a number or a
   * boolean, zero or false, is a value buyers send, so an example made only of
   * those is a purchase like any other.
   */
  #isListedExample(
    stored: StoredCard,
    params: Readonly<Record<string, unknown>>,
    shipTo: ShipTo | undefined,
  ): boolean {
    const { card } = stored;
    const standsIn =
      card.fulfillment === "ship" ||
      Object.values(card.params ?? {}).some((field) => field.type === "string");
    return (
      standsIn &&
      canonical({ params, ...(shipTo === undefined ? {} : { ship_to: shipTo }) }) ===
        canonical(listedPurchaseOf(card))
    );
  }

  /**
   * What a price depends on in its card: the published terms, the policy they
   * give, and the integration that sells them. Not when the card was last
   * published, since publishing it again unchanged changes no price.
   */
  #cardFacts(stored: StoredCard): unknown {
    return {
      card: stored.card,
      integration: stored.integration,
      policy: policyFor(stored.card, this.runtime.config),
    };
  }

  #requirementsOf(offer: PriceOffer, stamp: string) {
    return {
      scheme: "exact",
      network: offer.network as `${string}:${string}`,
      asset: offer.asset,
      amount: atomicUnits(offer.amount, 6),
      payTo: offer.payTo,
      maxTimeoutSeconds: offer.maxTimeoutSeconds,
      extra: { name: offer.assetName, version: offer.assetVersion, price_stamp: stamp },
    };
  }

  /**
   * Presents a payment against a stamped price. What follows is the machine's, and
   * how long the agent waits for it depends on the mode — a synchronous
   * purchase is answered with the goods, so the agent stays on the call until
   * the order has an answer or the promised ceiling runs out.
   *
   * The stamp is authenticated before anything is read or waited for, so a
   * forged one costs at most the read of the order it names. A stamp signed
   * under a key since retired is taken only as the exact saved price of the
   * order it already bought.
   */
  async payPurchase(
    stamp: string,
    payment: string,
    fingerprint: string,
    shipTo?: ShipTo,
    asked?: PaidRequest,
    arrivedAt = this.runtime.clock(),
  ): Promise<PurchaseAttempt> {
    const progress = { wrote: false };
    let leave = (): void => undefined;
    try {
      const authenticated = verifyPriceStamp(stamp, this.runtime.config.priceStampKeys);
      const offer = authenticated?.offer ?? (await this.#savedPriceOf(stamp));
      if (offer === null) return unknownPrice();
      const orderId = orderIdForPrice(offer);
      if (this.#beingChecked.has(orderId)) return { step: "payment_being_checked" };
      this.#beingChecked.add(orderId);
      leave = () => {
        this.#beingChecked.delete(orderId);
        leave = () => undefined;
      };
      const before = await this.runtime.store.orderById(orderId);
      if (before === null) {
        return authenticated === null
          ? unknownPrice()
          : await this.#admit(authenticated, stamp, payment, fingerprint, shipTo, asked, {
              arrivedAt,
              progress,
              leave: () => leave(),
            });
      }
      const saved = before.priceOffer;
      if (saved?.stamp !== stamp) return unknownPrice();
      return await this.#payAgain(before, saved, payment, fingerprint, shipTo, asked, {
        arrivedAt,
        progress,
        leave: () => leave(),
      });
    } catch (thrown) {
      // Before the first write, and where that write never began, nothing was
      // written and nothing charged. Only a failure that can pass by itself is
      // worth the same request again; a defect would answer the same forever.
      const facts = storeFailureFactsOf(thrown);
      if (progress.wrote && !facts.nothingWritten) throw thrown;
      console.error(
        `[gateway] a payment could not be checked, and nothing was written for it: ${failureNamed(thrown)}`,
      );
      return facts.passing ? { step: "not_checked_now" } : { step: "failed_before_charge" };
    } finally {
      leave();
    }
  }

  /** The decoded price of a stamp that is, byte for byte, the saved price of an existing order. */
  async #savedPriceOf(stamp: string): Promise<PriceOffer | null> {
    const decoded = decodePriceStamp(stamp);
    if (decoded === null) return null;
    const saved = await this.runtime.store.orderById(orderIdForPrice(decoded));
    return saved?.priceOffer?.stamp === stamp ? decoded : null;
  }

  /**
   * Where a payment waits for its check, and for whom, or its refusal here
   * for what the token would refuse anyway. A payment its wallet's own key
   * signed, from a wallet the chain shows holds the price, waits in the
   * merchant's lane for buyers. Any other waits in the lane nobody can vouch
   * for: a contract wallet's, noise, and a key's payment whose wallet could
   * not be read. In either lane the payer is one wallet, so holding more
   * places takes more wallets. A return of a paid order is never held to the
   * wallet's balance.
   */
  async #laneOf(
    merchantId: string,
    payment: string,
    requirements: PaymentRequirements,
    charges: boolean,
  ): Promise<
    { readonly lane: PaymentLane; readonly payer: string } | { readonly refused: PurchaseAttempt }
  > {
    const proof = await payerOf(payment, requirements);
    const now = BigInt(Math.floor(this.runtime.clock() / 1_000));
    if (proof.validAfter !== null && proof.validAfter > now + BigInt(CLOCK_SKEW_SECONDS)) {
      return { refused: signedWrongly("the signed authorization is not valid yet") };
    }
    if (!proof.signedByKey) return { lane: "unproven", payer: proof.claimed };
    const payer = proof.wallet.toLowerCase();
    if (!proof.lowS) {
      return {
        refused: signedWrongly(
          "the signature is the high-s form, which the token refuses; sign again with the wallet's own signer",
        ),
      };
    }
    if (!charges) return { lane: "proven", payer };
    const asked = BigInt(requirements.amount);
    const state = await this.#payers.stateOf(
      merchantId,
      requirements.asset,
      proof.wallet,
      proof.nonce,
      asked,
    );
    if (state === null) return { lane: "unproven", payer };
    if (state.used) {
      return {
        refused: signedWrongly(
          "the signed authorization has already been used, and each payment needs one of its own",
        ),
      };
    }
    if (state.held < asked) {
      return {
        refused: verificationRefusal({
          verified: false,
          reason: "insufficient_funds",
          message: `the paying wallet holds ${inUsdc(state.held)} USDC on ${requirements.network}, less than the ${inUsdc(asked)} USDC this price asks`,
        }),
      };
    }
    return { lane: "proven", payer };
  }

  /**
   * Runs one check with the payment layer once this merchant has a place for
   * it in `lane`, or answers the refusal for why no place came in time. Other
   * merchants' checks never take this merchant's places.
   */
  async #checked<T extends object>(
    merchantId: string,
    waits: { readonly lane: PaymentLane; readonly payer: string },
    check: () => Promise<T>,
  ): Promise<T | { readonly refused: PurchaseAttempt }> {
    const gate = waits.lane === "proven" ? this.#paymentGate : this.#unprovenGate;
    const place = await gate.enter(merchantId, PAYMENT_PLACE_WAIT_MS, waits.payer);
    if (typeof place !== "function") {
      gateRefused(waits.lane);
      return {
        refused: {
          step: "seller_busy",
          why: place === "payer" ? WALLETS_PAYMENT_BEING_CHECKED : PAYMENT_CHECKS_FULL,
        },
      };
    }
    try {
      return await check();
    } finally {
      place();
    }
  }

  /** One check by the payment layer, timed for the operator by the lane it waited in. */
  #verify(charge: Charge, lane: PaymentLane): Promise<VerifyOutcome> {
    return verifyTimed(
      () => this.runtime.clock(),
      lane,
      () => this.runtime.facilitator.verify(charge),
    );
  }

  /**
   * Whether a stamped price can still be bought, judged on the merchant and
   * card as they stand. Asked when the payment arrives and again inside its
   * admission, so a change gets the same answer whenever it lands.
   */
  #standingOf(
    offer: PriceOffer,
    key: string,
    merchant: StoredMerchant | null,
    card: StoredCard | null,
    at: number,
  ): AdmissionStanding {
    if (
      merchant === null ||
      card === null ||
      merchant.id !== offer.merchantId ||
      card.merchantId !== offer.merchantId ||
      card.id !== offer.itemId ||
      card.integration !== offer.integration
    ) {
      return "off_sale";
    }
    const selling = sellingFor(
      merchant.selling,
      card,
      sellableBy(merchant, this.runtime.config, at),
      merchant.integration,
    );
    if (
      selling !== "open" ||
      priceProblemsOf(card.card.price).length > 0 ||
      (siteRequiredFor(card.card.fulfillment) && merchant.sellerSite === null)
    ) {
      return "off_sale";
    }
    if (
      priceFactsDigest(this.#cardFacts(card), key, "card") !== offer.cardDigest ||
      payToAt(merchant, this.runtime.config, at)?.toLowerCase() !== offer.payTo.toLowerCase()
    ) {
      return "changed";
    }
    return "stands";
  }

  /**
   * The first payment for a stamped price: checked against the price and the
   * card as they stand, verified with no database connection held, then
   * admitted in one short transaction, and only then charged.
   */
  async #admit(
    authenticated: NonNullable<ReturnType<typeof verifyPriceStamp>>,
    stamp: string,
    payment: string,
    fingerprint: string,
    shipTo: ShipTo | undefined,
    asked: PaidRequest | undefined,
    paying: Paying,
  ): Promise<PurchaseAttempt> {
    const { offer } = authenticated;
    const { arrivedAt } = paying;
    const keys = this.runtime.config.priceStampKeys;
    const key = authenticated.key === "current" ? keys.current : keys.previous;
    if (key === undefined) throw new Error("a price authenticated under a key that is not held");
    paymentArrived(arrivedAt - offer.quotedAt);
    if (arrivedAt < offer.quotedAt || arrivedAt >= offer.expiresAt) {
      return {
        step: "payment_not_taken",
        why: "nothing was charged: this price has expired; request a new price before signing",
        retryable: false,
      };
    }
    const stored = await this.runtime.store.cardById(offer.itemId);
    const merchant = await this.runtime.store.merchantById(offer.merchantId);
    if (stored === null || merchant === null)
      return { step: "not_selling", message: NOT_ON_SALE_PAID };
    // Asked before the standing, so a reason it names, such as a missing
    // seller site, reaches the buyer in its own words.
    const off = offSaleNow(
      saleFactsOf(stored, await this.#theirsOf(merchant, arrivedAt)),
      arrivedAt,
    );
    switch (off?.code) {
      case "not_selling":
        return { step: "not_selling", message: off.message ?? NOT_ON_SALE_PAID };
      case "seller_not_fulfilling":
        this.#sayUnserved(merchant.id, arrivedAt);
        return { step: "seller_not_fulfilling" };
      case "seller_not_taking_orders":
        return { step: "seller_not_taking_orders" };
      case undefined:
        break;
    }
    const standing = this.#standingOf(offer, key, merchant, stored, arrivedAt);
    if (standing === "off_sale") return { step: "not_selling", message: NOT_ON_SALE_PAID };
    if (standing === "changed") return offerChanged();

    const fit = purchaseCheckFor(stored.card).safeParse(asked?.params ?? {});
    if (!fit.success) return { step: "params_rejected", problems: findingsOf(fit.error.issues) };
    if (stored.card.fulfillment === "ship" && shipTo === undefined)
      return {
        step: "ship_to_rejected",
        message: "this parcel needs its complete ship_to address repeated with payment",
      };
    if (stored.card.fulfillment !== "ship" && shipTo !== undefined)
      return {
        step: "ship_to_rejected",
        message: "this product is not shipped, so its purchase takes no ship_to",
      };
    const orderId = orderIdForPrice(offer);
    const requirements = this.#requirementsOf(offer, stamp);
    const charge = {
      orderId,
      requirements,
      amount: offer.amount,
      currency: offer.currency,
      payment,
      payTo: offer.payTo,
    };
    const lane = await this.#laneOf(offer.merchantId, payment, requirements, true);
    if ("refused" in lane) return lane.refused;
    const anotherPurchase =
      (asked !== undefined && asked.itemId !== offer.itemId) ||
      priceFactsDigest(fit.data as Readonly<Record<string, unknown>>, key, "params") !==
        offer.paramsDigest;
    const anotherPlace =
      priceFactsDigest(shipTo === undefined ? null : localityOf(shipTo), key, "place") !==
      offer.placeDigest;
    if (anotherPurchase || anotherPlace) {
      // Even a mismatch is private: a published offer must not become an address/parameter oracle.
      const checked = await this.#checked(offer.merchantId, lane, () =>
        this.#verify(charge, lane.lane),
      );
      if ("refused" in checked) return checked.refused;
      if (checked.verified !== true) {
        logVerificationRefusal(checked, "price", offer.priceId);
        return verificationRefusal(checked);
      }
      return anotherPurchase ? { step: "another_purchase" } : { step: "ship_to_changed" };
    }

    const policy = policyFor(stored.card, this.runtime.config);
    const born = createOrder({
      id: orderId,
      at: offer.quotedAt,
      mode: modeForCard(stored.card),
      policy: {
        ...policy,
        deadlines: { ...policy.deadlines, quoteTtlMs: offer.expiresAt - offer.quotedAt },
      },
      priceCheck: offer.source === "merchant_answer" ? "merchant" : "none",
      // The card's price as it was named, which an identical republish leaves unchanged.
      cardPrice: {
        ...stored.card.price,
        asOf: offer.source === "card_snapshot" ? offer.asOf : stored.asOf,
      },
      selling: "open",
      test: this.runtime.config.environment === "test",
    });
    if (!born.ok) return { step: "not_selling", message: born.rejection.message };
    let order = born.order;
    if (offer.source === "merchant_answer") {
      const priced = transition(order, {
        kind: "quote_answered",
        at: offer.quotedAt,
        available: true,
        price: { amount: offer.amount, currency: offer.currency, asOf: offer.asOf },
      });
      if (!priced.ok) return { step: "not_selling", message: priced.rejection.message };
      order = priced.order;
    }
    const presented = transition(order, { kind: "payment_presented", at: arrivedAt });
    if (!presented.ok) return { step: "not_selling", message: presented.rejection.message };
    const record: StoredOrder = {
      order: presented.order,
      merchantId: stored.merchantId,
      itemId: stored.id,
      merchantItemId: stored.card.merchant_item_id,
      buyerKey: this.runtime.ids("bk"),
      ...(stored.card.result === undefined ? {} : { result: stored.card.result }),
      params: fit.data as Readonly<Record<string, unknown>>,
      priceId: offer.source === "merchant_answer" ? offer.priceId : null,
      priceOffer: {
        stamp,
        requirements,
        expiresAt: offer.expiresAt,
        ...(offer.quoteReference === undefined ? {} : { reference: offer.quoteReference }),
      },
      delivery: null,
      payment: null,
      payTo: null,
      paidBy: null,
      settlement: null,
      paymentWords: [],
      paymentWordsDropped: 0,
      openDeliveryId: null,
      through: stored.integration,
    };

    const verified = await this.#checked(offer.merchantId, lane, () =>
      this.#verify(charge, lane.lane),
    );
    if ("refused" in verified) return verified.refused;
    if (verified.verified !== true) {
      logVerificationRefusal(verified, "price", offer.priceId);
      return verificationRefusal(verified);
    }
    const checkedAt = this.runtime.clock();
    const needed = validityNeededAfterCheckMs(record.order.policy.deadlines);
    if (
      record.order.mode.settle === "after_fulfillment" &&
      verified.validUntil !== null &&
      verified.validUntil < checkedAt + needed
    )
      return {
        step: "payment_not_verified",
        why: `nothing was charged and nothing was made: a purchase delivered in the answer is charged after its goods, so its authorisation has to last ${needed / 1_000} seconds past the check, and this one ends sooner; ${
          checkedAt < offer.expiresAt
            ? "sign the payment again and send it at once, while its price holds"
            : "its price has lapsed since, so request a new price and sign that at once"
        }`,
        retryable: false,
      };
    const prepared = this.runner.preparePurchase(
      record,
      walletThatPaid(verified.payer) ?? fingerprint,
      payment,
      offer.payTo,
      checkedAt,
      {
        fingerprint,
        standing: (current, card) =>
          this.#standingOf(offer, key, current, card, this.runtime.clock()),
        ...(shipTo === undefined ? {} : { shipTo }),
        ...(verified.recovery === undefined ? {} : { recovery: verified.recovery }),
      },
    );
    if (!prepared.ok)
      return {
        step: "payment_not_taken",
        why: prepared.rejection.message,
        retryable: prepared.rejection.retryable,
      };

    paying.progress.wrote = true;
    const admitted = await admissionTimed(
      () => this.runtime.clock(),
      () => this.runtime.store.admitOrder(prepared.prepared.accept),
    );
    switch (admitted.kind) {
      case "busy":
      case "existing":
        return { step: "payment_being_checked" };
      case "held_up":
        return { step: "not_checked_now" };
      case "payment_already_spent":
        return { step: "payment_already_spent" };
      case "off_sale":
        return { step: "not_selling", message: NOT_ON_SALE_PAID };
      case "offer_changed":
        return offerChanged();
      case "admitted":
        break;
    }
    paying.leave();
    const owner = prepared.prepared.accept.record.paidBy;
    if (owner === null) throw new Error("an admitted purchase has no verified owner");
    const parkedKey = purchaseOf(orderId, owner);
    const parked =
      record.order.mode.settle === "after_fulfillment"
        ? this.runner.purchases.wait(parkedKey, this.runtime.config.deadlines.syncBudgetMs)
        : null;
    await this.runner.finishAdmission(prepared.prepared);
    if (parked !== null) {
      const settled = await this.runtime.store.orderById(orderId);
      if (settled !== null && outcomeFor(settled.order) !== "in_progress")
        this.runner.purchases.giveUp(parkedKey);
      await parked;
      await this.#closeOverdueSynchronously(orderId);
    }
    return this.#wherePurchaseStands(orderId, merchant);
  }

  /**
   * A payment for a price whose order already exists: a buyer getting back a
   * purchase it paid for, or paying for one whose first answer it lost.
   * Checked against the terms saved on the order, never the card as it stands.
   */
  async #payAgain(
    found: StoredOrder,
    saved: NonNullable<StoredOrder["priceOffer"]>,
    payment: string,
    fingerprint: string,
    shipTo: ShipTo | undefined,
    asked: PaidRequest | undefined,
    { arrivedAt, progress, leave }: Paying,
  ): Promise<PurchaseAttempt> {
    const orderId = found.order.id;
    let before = found;
    if (unresolvedPayment(before.order)) return noPaymentTakenFor(before.order);

    // An order that is over with no goods held takes no payment and is not
    // verified for one: a refusal could only tell the agent to pay again for a
    // price that is gone. The answer names no order, because the payment has
    // not been checked and the identifier it carries can be published. A buyer
    // who lost its first answer learns from it all the order would tell it:
    // that nothing was charged, or that whether anything was is not known.
    if (overWithNothingHeld(before)) {
      return noPaymentTakenFor(before.order);
    }

    // An address sent for a product that is not shipped is refused at once:
    // the card says as much to anyone.
    if (shipTo !== undefined && before.order.mode.parcel !== true) {
      return {
        step: "ship_to_rejected",
        message: "this product is not shipped, so a payment for it carries no ship_to",
      };
    }

    const price = before.order.price;
    if (price === null) throw new Error(`the order ${orderId} keeps a saved price and no price`);

    // An existing purchase is verified outside its row lock. No owner or
    // address comparison from before that lock can decide acceptance.
    // Used authorizations and signatures can be read from the chain, so even
    // the exact saved payment is no private credential for an order or goods.
    //
    // A payment that will be charged is checked against the merchant's split
    // in force now, read once here, and the same string is kept on the order
    // for the charge, so the money goes where the payer signed for it to go
    // rather than wherever the merchant's wallet has moved by then. A payment
    // for an order already paid, which only returns the purchase to its payer,
    // is checked against where that order's money went: the payment request
    // its payer kept names that split, whatever the merchant is paid at today.
    // Where that split is one the merchant has left, the payment is fit only
    // for that return, and the order's lock refuses to charge it.
    const payingMerchant = await this.runtime.store.merchantById(before.merchantId);

    // A new payment for an order paid before its goods needs the seller's
    // site, as the first one did. Paid recovery and payments already accepted
    // for execution continue.
    if (
      payingMerchant?.sellerSite === null &&
      before.order.mode.settle === "on_purchase" &&
      takesANewPayment(before.order)
    ) {
      return { step: "not_selling", message: SELLER_SITE_REQUIRED };
    }

    // A new payment for an order paid before its goods is refused while the
    // seller is silent, since nobody would draw the order; a repeat of a
    // synchronous one that releases goods already made is not.
    if (
      payingMerchant !== null &&
      before.order.mode.settle === "on_purchase" &&
      takesANewPayment(before.order) &&
      silentAt(await this.runtime.store.lastContact(payingMerchant.id), arrivedAt)
    ) {
      return { step: "seller_not_taking_orders" };
    }

    const payeeNow =
      payingMerchant === null
        ? null
        : payToAt(payingMerchant, this.runtime.config, this.runtime.clock());
    const paidFor =
      before.paidBy !== null && before.payTo !== null && !takesANewPayment(before.order);
    const payTo = saved.requirements.payTo;

    // A payment for an order already paid is never charged, so it is checked
    // here and not by the payment layer, which would refuse a wallet that
    // could not pay again: getting back a purchase must not depend on what is
    // left in the wallet that paid for it. Only a wallet can sign again, so an
    // order owned by a payment's fingerprint, where the payment layer named no
    // payer, is still checked there.
    const paidBy = before.paidBy;
    const lane = await this.#laneOf(before.merchantId, payment, saved.requirements, !paidFor);
    if ("refused" in lane) return lane.refused;
    const checked = await this.#checked(before.merchantId, lane, async () => {
      const here =
        paidFor && paidBy !== null && isAddress(paidBy)
          ? await returningPayment(
              payment,
              { orderId, priceOffer: saved },
              {
                now: this.runtime.clock(),
                claimHolder: (held) => this.runtime.store.paymentClaimHolder(held),
                ...(this.runtime.chain === undefined ? {} : { chain: this.runtime.chain }),
              },
            )
          : null;
      return {
        here: here !== null,
        verified:
          here ??
          (await this.#verify(
            {
              orderId,
              requirements: saved.requirements,
              amount: price.amount,
              currency: price.currency,
              payment,
              payTo,
              ...(paidFor ? { returnsAPaidOrder: true } : {}),
            },
            lane.lane,
          )),
      };
    });
    if ("refused" in checked) return checked.refused;
    const { verified } = checked;
    const onlyReturns = checked.here || payTo.toLowerCase() !== payeeNow?.toLowerCase();

    if (verified.verified !== true) logVerificationRefusal(verified, "order", orderId);
    leave();
    const current = await this.runtime.store.orderById(orderId);
    if (current === null) return { step: "no_such_item" };
    if (unresolvedPayment(current.order)) return noPaymentTakenFor(current.order);
    before = current;

    if (verified.verified !== true) return verificationRefusal(verified);

    // The owner is who the payment layer says paid, or whose signature this
    // gateway checked, never the address the payment declares of itself.
    // Where the layer names no payer, the
    // payment's fingerprint stands in; it is derived from what was signed, so
    // it is no more forgeable.
    const owner = walletThatPaid(verified.payer) ?? fingerprint;

    // A payer who is not the buyer of an order already paid for is turned
    // away before the order tells it anything more. Verifying moves no money,
    // and for a paid order needs no money in the wallet, so without this any
    // wallet could try addresses against a paid parcel. The decision that counts is taken again under
    // the order's lock below; this one only answers sooner.
    if (before.paidBy !== null && before.paidBy !== owner) {
      return { step: "not_this_purchase" };
    }

    // A payment is for the address its order was priced for: one naming
    // another address is a different purchase, and one naming none pays for
    // the priced one. It is compared only once the payment has verified and
    // its payer may be the buyer, so a payment that is not one cannot try
    // addresses against the order, and still before anything is claimed or
    // charged. Once Agentify's copy is erased there is nothing left to
    // compare with.
    const held = before.shipTo;
    if (
      shipTo !== undefined &&
      held !== undefined &&
      !("erasedAt" in held) &&
      !sameAddress(held, shipTo)
    ) {
      return { step: "ship_to_changed" };
    }
    // The product and its parameters are held to the same rule and compared at
    // the same moment, for the same reason: parameters can carry the buyer's
    // own details, such as where the goods are sent.
    if (
      asked !== undefined &&
      (asked.itemId !== before.itemId ||
        (asked.params !== undefined && canonical(asked.params) !== canonical(before.params)))
    ) {
      return { step: "another_purchase" };
    }

    // The park below waits `syncBudgetMs` from this instant, where the ceiling
    // promised to the agent is counted from. Counted from when the order opened
    // or when this call arrived, the park would give up while the answer is
    // still on its way, and the agent is charged and told "in progress" while
    // holding nothing. The goods' clock runs from `paidAt`, which
    // `presentVerifiedPayment` stamps a little later, and the charge's from the
    // merchant's answer, so with both used to the end the machine can still be
    // deciding when the park ends; the agent is then told "in progress", which
    // is true, and keeps the order's status address.
    const checkedOutAt = this.runtime.clock();

    // One authorisation buys one order, which ownership by payer cannot ensure
    // since the same wallet would own both. It is claimed after verification,
    // so a payment that never checked out never burns a claim.
    progress.wrote = true;
    const claim = await this.runtime.store.claimPayment(fingerprint, orderId);
    if (!claim.claimed) {
      return { step: "payment_already_spent" };
    }

    // In the synchronous mode the goods reach the agent only through the park.
    // It is keyed on the order and its owner, so two buyers racing one order
    // never take each other's goods, while one buyer's two concurrent calls
    // both wake.
    const key = purchaseOf(orderId, owner);
    const waits = before.order.mode.settle === "after_fulfillment";
    const spent = this.runtime.clock() - checkedOutAt;
    const left = Math.max(this.runtime.config.deadlines.syncBudgetMs - spent, 0);
    const parked = waits ? this.runner.purchases.wait(key, left) : null;

    // The ownership decision and the state change, both inside the order's lock.
    const taken = await this.runner.presentVerifiedPayment(
      orderId,
      owner,
      payment,
      payTo,
      this.runtime.clock(),
      {
        fingerprint,
        onlyReturns,
        ...(shipTo === undefined ? {} : { shipTo }),
        ...(verified.recovery === undefined ? {} : { recovery: verified.recovery }),
      },
    );

    // These turned the payment away before it spent anything, so the claim
    // is released; held, it would tell the buyer who lost the race that their
    // next attempt was already spent on somebody else's order. `refused` keeps
    // its claim, because some of its causes have moved money.
    if (taken.kind === "no_such_order") {
      this.runner.purchases.giveUp(key);
      await this.runtime.store.releaseClaim(fingerprint, orderId);
      return { step: "no_such_item" };
    }
    if (taken.kind === "switched_away" || taken.kind === "ship_to_required") {
      this.runner.purchases.giveUp(key);
      await this.runtime.store.releaseClaim(fingerprint, orderId);
      return taken.kind === "switched_away"
        ? { step: "not_selling", message: NOT_ON_SALE_PAID }
        : {
            step: "ship_to_rejected",
            message: "this parcel needs the complete ship_to address with payment",
          };
    }
    if (taken.kind === "not_owner") {
      this.runner.purchases.giveUp(key);
      await this.runtime.store.releaseClaim(fingerprint, orderId);
      return { step: "not_this_purchase" };
    }
    if (taken.kind === "ship_to_changed") {
      this.runner.purchases.giveUp(key);
      await this.runtime.store.releaseClaim(fingerprint, orderId);
      return { step: "ship_to_changed" };
    }
    if (taken.kind === "only_returns") {
      this.runner.purchases.giveUp(key);
      await this.runtime.store.releaseClaim(fingerprint, orderId);
      // What this payment is told if it is presented again, now that the order
      // takes a new charge: checked by the payment layer, against where the
      // merchant is paid today.
      const moved = payTo.toLowerCase() !== payeeNow?.toLowerCase();
      return {
        step: "payment_not_verified",
        why: `nothing was charged: ${NEXT_STEP_AFTER[moved ? "price_stale" : "signature"]}`,
        retryable: false,
      };
    }
    if (taken.kind === "refused") {
      this.runner.purchases.giveUp(key);
      return {
        step: "payment_not_taken",
        why: taken.rejection.message,
        retryable: taken.rejection.retryable,
      };
    }

    // Took it, or it was already the owner's: the goods, if any, come through
    // the park.
    if (parked !== null) {
      const settled = await this.runtime.store.orderById(orderId);
      if (settled !== null && outcomeFor(settled.order) !== "in_progress") {
        // Already answered, so there is nothing to wait for.
        this.runner.purchases.giveUp(key);
      }
      await parked;
      await this.#closeOverdueSynchronously(orderId);
    }

    return this.#wherePurchaseStands(orderId, payingMerchant);
  }

  /**
   * Closes a synchronous order whose merchant's deadline has passed but whose
   * timer has not landed yet: the queue polls for due reminders, so the timer
   * can arrive after the agent's wait ends, and the agent is owed how the
   * purchase ended. Only the merchant's deadline is applied; a late answer
   * from the payment layer is ordinary rather than an ending.
   */
  async #closeOverdueSynchronously(orderId: string): Promise<void> {
    const record = await this.runtime.store.orderById(orderId);
    if (record === null || record.order.mode.settle !== "after_fulfillment") {
      return;
    }
    const due = deadlines(record.order).find((deadline) => deadline.kind === "sync_response");
    if (due === undefined || due.at > this.runtime.clock()) {
      return;
    }
    await this.runner.apply(orderId, { kind: "deadline_expired", at: due.at, deadline: due.kind });
  }

  /**
   * One order, whoever it belongs to: the buying surface's read, for routes
   * that take no key because a buyer has no merchant to be scoped to. Nothing
   * here scopes it, so what keeps a caller from reading across merchants is
   * the shape of the answer built from it. A merchant's own read is
   * {@link merchantOrder}.
   */
  async orderById(orderId: string): Promise<StoredOrder | null> {
    return this.runtime.store.orderById(orderId);
  }

  /** The order a buyer's key opens, whoever it belongs to; only the agent's status read asks. */
  async orderByBuyerKey(buyerKey: string): Promise<StoredOrder | null> {
    return this.runtime.store.orderByBuyerKey(buyerKey);
  }

  /** One of this merchant's orders. Another merchant's is not found. */
  async merchantOrder(merchantId: string, orderId: string): Promise<StoredOrder | null> {
    return this.runtime.store.merchantOrder(merchantId, orderId);
  }

  /**
   * Which key a request presented, or null. The lookup is by digest, so no
   * secret is compared and the timing says nothing about how much of a key was
   * right; a key never issued and a disabled one look the same. The whole row
   * comes back because a merchant may not disable the key they are calling
   * with, and this is the one place a key's last use is marked, with what the
   * caller said it runs.
   */
  async keyBehind(presented: string, userAgent?: string): Promise<StoredKey | null> {
    const key = await this.runtime.store.workingKey(keyDigest(presented));
    if (key !== null) {
      await this.#noteKeyUse(key, userAgent);
    }
    return key;
  }

  /**
   * Marks this key as used, unless it was marked within the window. Awaited
   * rather than left running, because an unheld rejection takes the process
   * down and a late write can land on a pool being closed. A failure is only
   * logged: no sale may be refused because this column could not be updated.
   */
  async #noteKeyUse(key: StoredKey, userAgent: string | undefined): Promise<void> {
    const at = this.runtime.clock();
    if (key.lastUsedAt !== null && at - key.lastUsedAt < KEY_USE_WRITTEN_EVERY_MS) {
      return;
    }
    // An operator's terminal prints this later, so only printable text is kept.
    const said =
      userAgent
        ?.replace(/[^\x20-\x7e]/g, "")
        .trim()
        .slice(0, USER_AGENT_KEPT_CHARACTERS) || null;
    try {
      await this.runtime.store.noteKeyUse(key.id, at, said);
    } catch (thrown) {
      console.error(
        `[gateway] the last use of the key ${key.id} was not written down: ${failureNamed(thrown)}`,
      );
    }
  }

  get environment(): Environment {
    return this.runtime.config.environment;
  }

  // --- the merchant's stream ------------------------------------------------

  /**
   * Draws the next envelope off the merchant's stream and records the
   * hand-over if it is an order. One envelope per poll, whatever the worker
   * asks for: the wait for a handler's answer starts at the hand-over, so an
   * order at the back of a batch would wait out the handler calls ahead of it
   * and be taken for a silence, spending one of its deliveries. An order that
   * has moved on since it was queued is not handed out.
   *
   * A poll hands out nothing once the key it came in on is revoked, by this
   * process or any other, and a merchant selling through an integration other
   * than `drawing.through` is handed nothing.
   */
  async poll(
    merchantId: string,
    waitMs: number,
    drawing: PollDrawing = {},
  ): Promise<WorkerPollResponse> {
    const { gone, keyId = null, through = "api", contractVersion = CONTRACT_VERSION } = drawing;
    if (contractVersion !== CONTRACT_VERSION) {
      return { contract_version: CONTRACT_VERSION, envelopes: [] };
    }
    const held: HeldPoll = { keyId, stop: new AbortController() };
    const holding = this.#held.get(merchantId) ?? new Set<HeldPoll>();
    holding.add(held);
    this.#held.set(merchantId, holding);
    const signal =
      gone === undefined ? held.stop.signal : AbortSignal.any([gone, held.stop.signal]);
    try {
      // The key is asked again once the poll is held: a revocation between the
      // door letting it in and this point found no held poll to end
      // (`disableMerchantKey`). Answered at once, because the next poll is the
      // door's to refuse.
      if (keyId !== null && !(await this.keyStillWorks(merchantId, keyId))) {
        return { contract_version: CONTRACT_VERSION, envelopes: [] };
      }
      // Asked once the poll is held, so a switch either came before this read
      // and is seen by it, or comes after and ends the poll (`sellThrough`).
      // Answered as a quiet stream is, after its window: answered at once, a
      // worker that polls again on an empty answer would spin.
      if ((await this.sellsThrough(merchantId)) !== through) {
        await quietFor(Math.min(waitMs, this.runtime.config.worker.pollWaitMs), signal);
        return { contract_version: CONTRACT_VERSION, envelopes: [] };
      }
      await this.#noteContact(merchantId, through);
      return await this.#drawFor(merchantId, waitMs, signal, keyId);
    } finally {
      holding.delete(held);
      if (holding.size === 0 && this.#held.get(merchantId) === holding) {
        this.#held.delete(merchantId);
      }
    }
  }

  /**
   * Whether as many of this merchant's paid orders are left unserved as the
   * door allows. Only an order a buyer paid for counts, so nobody can stop a
   * seller's sales without paying, and nothing is stored: a late delivery or a
   * closure that leaves fewer lets the next purchase through.
   */
  async #unserved(merchantId: string): Promise<boolean> {
    return (
      (await this.runtime.store.unservedOrders(merchantId, UNSERVED_AT_MOST)) >= UNSERVED_AT_MOST
    );
  }

  /**
   * Logs that this merchant's purchases are refused for their unserved
   * orders, at most once a minute per merchant: nothing else tells the
   * operator. Nothing about the buyer goes in it.
   */
  #sayUnserved(merchantId: string, at: number): void {
    const said = this.#unservedLogged.get(merchantId);
    if (said === undefined || at - said >= SELLER_REFUSALS_LOGGED_EVERY_MS) {
      this.#unservedLogged.set(merchantId, at);
      console.warn(
        `[gateway] ${merchantId} has ${UNSERVED_AT_MOST} or more paid orders left unfulfilled, so new purchases of theirs are refused as seller_not_fulfilling`,
      );
    }
  }

  /**
   * Writes down that this merchant's process polled through `through`, unless
   * this process wrote it within `CONTACT_WRITTEN_EVERY_MS`. A failure is only
   * logged, as for a key's last use: the poll goes on, and the next one writes
   * it.
   */
  async #noteContact(merchantId: string, through: Integration): Promise<void> {
    const at = this.runtime.clock();
    const written = this.#contactWritten[through].get(merchantId);
    if (written !== undefined && at - written < CONTACT_WRITTEN_EVERY_MS) {
      return;
    }
    try {
      await this.runtime.store.noteContact(merchantId, at, through);
      this.#contactWritten[through].set(merchantId, at);
    } catch (thrown) {
      console.error(
        `[gateway] the poll of ${merchantId} was not written down: ${failureNamed(thrown)}`,
      );
    }
  }

  /** Whether this merchant's key exists and has not been disabled. */
  async keyStillWorks(merchantId: string, keyId: string): Promise<boolean> {
    const keys = await this.runtime.store.keysOf(merchantId);
    return keys.some((key) => key.id === keyId && key.disabledAt === null);
  }

  /**
   * Whether the key still works, read once something has been drawn. A read
   * that fails counts as a key that does not, because what was drawn never
   * returns to the stream by itself: given back, it waits for the next poll,
   * where a thrown poll would lose it.
   */
  async #keyConfirmed(merchantId: string, keyId: string): Promise<boolean> {
    try {
      return await this.keyStillWorks(merchantId, keyId);
    } catch (thrown) {
      console.error(
        `[gateway] the key of a poll of ${merchantId} could not be read, so what it drew goes back on the stream: ${failureNamed(thrown)}`,
      );
      return false;
    }
  }

  /** Ends the held polls of one merchant that `which` picks out, with nothing. */
  #letGo(merchantId: string, which: (held: HeldPoll) => boolean): void {
    for (const held of this.#held.get(merchantId) ?? []) {
      if (which(held)) {
        held.stop.abort();
      }
    }
  }

  async #drawFor(
    merchantId: string,
    waitMs: number,
    gone: AbortSignal,
    keyId: string | null,
  ): Promise<WorkerPollResponse> {
    const { config, queue } = this.runtime;
    // Real time, not the order clock: the window bounds how long a worker's
    // request is held.
    const window = Math.min(waitMs, config.worker.pollWaitMs);
    const until = performance.now() + window;
    const nothing = { contract_version: CONTRACT_VERSION, envelopes: [] };

    // An envelope turned away is drawn past rather than answered with nothing,
    // because a worker rests after an empty answer and everything live behind
    // a closed order would wait for it. Drawing past still has to end: an
    // envelope whose hand-over could not be recorded returns after a delay, so
    // there may always be one to draw. A held poll stops at the end of its
    // window, and any poll after `PASSED_AT_MOST` envelopes turned away, the
    // only bound a drain with no window has.
    for (let passed = 1; ; passed += 1) {
      if (gone.aborted) {
        return nothing;
      }
      const drawn = await queue.draw(merchantId, 1, Math.max(0, until - performance.now()), gone);
      if (drawn.length === 0) {
        return nothing;
      }
      // Another process may have revoked the key while the poll waited, and
      // nothing in this one heard of it. An order's hand-over is checked again
      // under its hold, which a revocation landing after this read cannot pass.
      if (keyId !== null && !(await this.#keyConfirmed(merchantId, keyId))) {
        for (const delivery of drawn) {
          await this.#giveBack(merchantId, delivery);
        }
        return nothing;
      }
      const { handing, revoked } = await this.#handOut(merchantId, drawn, keyId);
      if (handing.length > 0) {
        return { contract_version: CONTRACT_VERSION, envelopes: handing };
      }
      if (revoked) {
        return nothing;
      }
      if (passed >= PASSED_AT_MOST || (window > 0 && performance.now() >= until)) {
        return nothing;
      }
    }
  }

  /**
   * Records the hand-over of what was drawn, and returns what may go to the
   * worker, and whether the key it came in on turned out revoked, after which
   * everything left goes back on the stream.
   */
  async #handOut(
    merchantId: string,
    drawn: readonly DrawnEnvelope[],
    keyId: string | null,
  ): Promise<{ handing: WorkerPollResponse["envelopes"]; revoked: boolean }> {
    const { config, queue, clock } = this.runtime;
    const handing: WorkerPollResponse["envelopes"] = [];
    const finished: string[] = [];
    let revoked = false;

    for (const delivery of drawn) {
      if (revoked) {
        await this.#giveBack(merchantId, delivery);
        continue;
      }
      if (delivery.envelope.kind !== "order") {
        if (delivery.envelope.kind === "quote_request") {
          const question = this.#questions.get(delivery.envelope.payload.price_id);
          if (
            question === undefined ||
            question.merchantId !== merchantId ||
            question.until <= clock()
          ) {
            finished.push(delivery.handle);
            continue;
          }
        }
        handing.push(delivery.envelope);
        finished.push(delivery.handle);
        continue;
      }

      const orderId = delivery.envelope.payload.id;
      const at = clock();
      // Minted per hand-over: the envelope's identifier changes on redelivery
      // and the order's is shared by every attempt, but the reminder must tell
      // whether the hand-over it was armed for is still the one the order
      // waits on.
      const handOver = this.runtime.ids("dlv");
      let applied: Awaited<ReturnType<OrderRunner["apply"]>>;
      try {
        applied = await this.runner.apply(
          orderId,
          { kind: "order_dispatched", at },
          { openDeliveryId: handOver },
          // Cannot fire while an envelope reaches only the stream of its own
          // order's merchant, so no test covers it. It stays because if the two
          // ever came apart the order would go to the wrong merchant; with it,
          // nobody is given the order, the smaller and more noticeable wrong.
          { merchantId, ...(keyId === null ? {} : { keyId }) },
        );
      } catch (thrown) {
        // Recording the hand-over failed. The envelope goes back on the
        // stream rather than being lost with a failed response, and the poll
        // draws past it to whatever is next.
        console.error(
          `[gateway] could not record the hand-over of order ${orderId}: ${failureNamed(thrown)}`,
        );
        await this.#putBack(merchantId, delivery.envelope, at, config.settleInFlightRetryMs);
        finished.push(delivery.handle);
        continue;
      }

      if (applied.outcome === "refused" && applied.rejection.retryable) {
        // Refused for now because a charge on this order is being executed.
        // The order goes back on the stream, since dropping it would leave a
        // paid order that never reaches the merchant.
        await this.#putBack(merchantId, delivery.envelope, at, config.settleInFlightRetryMs);
        finished.push(delivery.handle);
        continue;
      }

      // The hold finds no order through a key revoked before it was taken
      // either. A revocation is never undone, so a key that does not work now
      // is the reason.
      if (
        applied.outcome === "no_such_order" &&
        keyId !== null &&
        !(await this.#keyConfirmed(merchantId, keyId))
      ) {
        revoked = true;
        await this.#giveBack(merchantId, delivery);
        continue;
      }

      if (applied.outcome !== "moved") {
        if (applied.outcome === "no_such_order") {
          // Orders are never deleted, so this means the scope refused an order
          // that is not this merchant's. That cannot happen while envelopes
          // reach only their own merchant's stream, so it is logged loudly.
          console.error(
            `[gateway] ${merchantId} drew an envelope for order ${orderId}, which is not their order`,
          );
        }
        // The machine refused the hand-over, so nobody is given the order:
        // passing it on would ask a merchant to work on a purchase that is
        // over, or hand them a parcel whose buyer's address is already erased.
        // An ordinary unfulfilled order remains deliverable until its
        // merchant closes fulfillment.
        finished.push(delivery.handle);
        continue;
      }

      handing.push(delivery.envelope);
      finished.push(delivery.handle);
    }

    // The queue is told last, once the hand-over has been recorded. Told
    // first, a throw part way through would leave an envelope finished that
    // nobody was ever handed.
    for (const handle of finished) {
      await queue.finish(merchantId, handle);
    }

    return { handing, revoked };
  }

  /**
   * Puts something drawn for a key that turned out revoked back on the stream
   * at once, for a key that works. A parcel's price question goes back only
   * under the hold on its order, as it was first sent, and not at all once
   * nobody waits for its answer.
   */
  async #giveBack(merchantId: string, delivery: DrawnEnvelope): Promise<void> {
    const { envelope } = delivery;
    if (envelope.kind === "order") {
      await this.#putBack(merchantId, envelope, this.runtime.clock(), 0);
    } else if (envelope.kind === "quote_request") {
      const asked = this.#questions.get(envelope.payload.price_id);
      if (asked !== undefined) {
        if (asked.until > this.runtime.clock()) {
          await this.runtime.queue.publish(merchantId, envelope);
        }
      }
    } else {
      await this.runtime.queue.publish(merchantId, envelope);
    }
    await this.runtime.queue.finish(merchantId, delivery.handle);
  }

  /**
   * Puts a hand-over a poll drew and gave to nobody back on the stream, behind
   * a delay and with its identifier untouched. One carrying a parcel's address
   * goes back only under the hold on its order, and not at all once the
   * address is erased; every other goes straight back, because under the hold
   * a put-back would fail exactly when the store is failing.
   */
  async #putBack(
    merchantId: string,
    envelope: Extract<WorkerEnvelope, { kind: "order" }>,
    at: number,
    afterMs: number,
  ): Promise<void> {
    const again = sentNow(envelope, at);
    if (envelope.payload.ship_to === undefined) {
      await this.runtime.queue.publish(merchantId, again, afterMs);
      return;
    }
    await this.runner.sendWhileTheAddressIsHeld(envelope.payload.id, () => again, afterMs);
  }

  /**
   * The price and availability for a question that came off the stream.
   * `used` means the machine took this answer as the purchase's price, not
   * merely that the question was still held: our own clock can close it a
   * moment before the answer lands. A price no payment can be taken at is
   * refused first, by the rule a published card's price meets, and the
   * question stays open for a corrected answer.
   */
  async answerQuote(
    merchantId: string,
    priceId: string,
    response: QuoteResponse,
    _by?: Caller,
  ): Promise<QuoteAnswerAck | QuoteAnswerRefused> {
    const unsellable = response.available ? priceProblemsOf(response.price) : [];
    if (unsellable.length > 0) {
      return { refused: unsellable };
    }

    const asked = this.#questions.get(priceId);
    // A question asked of another merchant is answered exactly like one no
    // longer held, so the answer reveals nothing about somebody else's sale.
    if (asked === undefined || asked.merchantId !== merchantId) {
      return { used: false };
    }

    const at = this.runtime.clock();
    if (asked.until <= at) {
      this.#questions.delete(priceId);
      this.quotes.giveUp(priceId);
      return { used: false };
    }
    if (response.available && response.price.currency !== asked.currency) {
      return {
        refused: [
          {
            path: ["price", "currency"],
            code: "currency_mismatch",
            message: "the answer must use the currency of this card",
          },
        ],
      };
    }
    this.#questions.delete(priceId);
    this.quotes.answer(priceId, response);
    return { used: true };
  }

  /**
   * What the merchant's handler returned for an order it was given. Every
   * answer route scopes the hold on the order to the calling merchant, so
   * another merchant's order is not found, the same answer as one that never
   * existed.
   */
  async answerOrder(
    merchantId: string,
    orderId: string,
    answer: HandlerAnswer,
    by?: Caller,
  ): Promise<OrderCallResponse | null> {
    if ("delivered" in answer) {
      return this.deliverOrder(merchantId, orderId, answer.delivered, "handler", by);
    }
    if ("refused" in answer) {
      return this.refuseOrder(merchantId, orderId, answer.refused, "handler", by);
    }

    return this.#takeOrderOn(merchantId, orderId, answer.accepted, by);
  }

  /**
   * Records a delivery, after holding the goods to what the order was sold
   * with. The check is outside the machine, which knows nothing about cards,
   * and comes first because a delivery that does not fit must change nothing:
   * no goods on the order, no receipt, and the hand-over still open so its
   * clock and redelivery are unchanged.
   */
  async deliverOrder(
    merchantId: string,
    orderId: string,
    delivery: Delivery,
    from: "handler" | "call" = "call",
    by?: Caller,
  ): Promise<OrderCallResponse | null> {
    // Read before the check, so an order that is not this merchant's is
    // answered exactly as one that never existed.
    const record = await this.runtime.store.merchantOrder(merchantId, orderId);
    if (record === null) {
      return null;
    }

    // Goods are checked only where they could still be written: the order
    // carries none yet. A repeat is not checked, because delivery is at least
    // once and a refusal is marked retryable, which on a delivered order would
    // turn the merchant's safe retry into a loop that can never succeed.
    const parcel = record.order.mode.parcel === true;
    const misfit =
      record.delivery === null ? await this.#goodsAgainstTheCard(record, delivery) : null;
    if (misfit !== null) {
      return { ok: false, error: misfit };
    }

    const at = this.runtime.clock();
    const applied = await this.runner.apply(
      orderId,
      from === "handler" ? { kind: "handler_delivered", at } : { kind: "deliver_called", at },
      {
        // A parcel's shipment is stamped with when it was recorded, which is
        // this gateway's to say and never the merchant's.
        delivery: parcel ? { ...delivery, shipped_at: asTimestamp(at) } : delivery,
        openDeliveryId: null,
      },
      actingAs(merchantId, by),
    );

    // A parcel's shipment is the exception to repeats: a different shipment is
    // refused rather than answered "already delivered", which the merchant
    // would read as a correction taken. It is compared with the order as the
    // hold read it, because two shipments sent at once both find nothing
    // recorded in the earlier read and only one lands.
    if (
      parcel &&
      applied.outcome === "moved" &&
      applied.order.delivery !== null &&
      !sameGoods(applied.order.delivery, delivery, true)
    ) {
      return {
        ok: false,
        error: {
          code: "shipment_already_recorded",
          message:
            "a shipment is already recorded on this order, and a recorded shipment cannot be changed: the agent reads the one recorded first, on the order's status",
          retryable: false,
        },
      };
    }
    return this.#answerFor(applied, "delivered");
  }

  async refuseOrder(
    merchantId: string,
    orderId: string,
    refusal: Refusal,
    from: "handler" | "call" = "call",
    by?: Caller,
  ): Promise<OrderCallResponse | null> {
    const at = this.runtime.clock();
    const applied = await this.runner.apply(
      orderId,
      from === "handler"
        ? { kind: "handler_refused", at, code: refusal.code, message: refusal.message }
        : { kind: "refuse_called", at, code: refusal.code, message: refusal.message },
      { openDeliveryId: null },
      actingAs(merchantId, by),
    );
    return this.#answerFor(applied, "refused");
  }

  /** Stops future Agentify fulfillment, preserving the original payment and goods. */
  async closeOrder(
    merchantId: string,
    orderId: string,
    request: OrderCloseRequest,
    by?: Caller,
  ): Promise<OrderCloseResponse | null> {
    const applied = await this.runner.apply(
      orderId,
      { kind: "close_called", at: this.runtime.clock(), ...request },
      { openDeliveryId: null },
      actingAs(merchantId, by),
    );
    const answered = this.#answerFor(applied, "accepted");
    return answered === null || !answered.ok ? answered : { ok: true };
  }

  /**
   * Takes an order on through its own route, whose published answer has no
   * room for the word the answer route carries. A merchant accepting an order
   * already delivered therefore hears a bare success here rather than
   * `already_delivered`: less than the whole truth, but nothing untrue.
   */
  async acceptOrder(
    merchantId: string,
    orderId: string,
    acceptance: Acceptance,
    by?: Caller,
  ): Promise<OrderAcceptResponse | null> {
    const taken = await this.#takeOrderOn(merchantId, orderId, acceptance, by);
    return taken === null || !taken.ok ? taken : { ok: true };
  }

  /**
   * Taking an order on, for both routes that do it. It returns the full answer
   * with the word, because the SDK posts every handler answer to the answer
   * route and reports anything short of a success to the merchant as a
   * problem.
   */
  async #takeOrderOn(
    merchantId: string,
    orderId: string,
    _acceptance: Acceptance,
    by?: Caller,
  ): Promise<OrderCallResponse | null> {
    // The acceptance carries no field, since `AcceptanceSchema` is empty: the
    // merchant is held to the card's delivery deadline and to nothing they say
    // here.
    const at = this.runtime.clock();
    const applied = await this.runner.apply(
      orderId,
      { kind: "handler_accepted", at },
      { openDeliveryId: null },
      actingAs(merchantId, by),
    );

    return this.#answerFor(applied, "accepted");
  }

  /** This merchant's accepted orders; open means fulfillment a restarted worker may resume. */
  async orders(merchantId: string, open: boolean | undefined): Promise<readonly StoredOrder[]> {
    const records = await this.runtime.store.orders(merchantId, open === undefined ? {} : { open });
    return open === true
      ? records.filter((record) => onTheMerchantsOpenList(record.order))
      : records;
  }

  // --- the parts the flows above lean on ------------------------------------

  /**
   * Puts the price question to the merchant and waits out our own patience for
   * it; whatever comes back, silence included, reaches the machine as an event.
   */
  async #askThePrice(
    stored: StoredCard,
    params: Readonly<Record<string, unknown>>,
    priceId: string,
    at: number,
    shipTo?: ShipTo,
  ): Promise<QuoteResponse | null> {
    const { queue, ids, clock, config } = this.runtime;
    const until = at + config.deadlines.quoteResponseMs;
    if (until <= clock()) return null;
    this.#questions.set(priceId, {
      merchantId: stored.merchantId,
      currency: stored.card.price.currency,
      until,
    });
    const parked = this.quotes.wait(priceId, until - clock());
    try {
      await queue.publish(stored.merchantId, {
        kind: "quote_request",
        id: ids("env"),
        sent_at: asTimestamp(clock()),
        payload: {
          merchant_item_id: stored.card.merchant_item_id,
          params: { ...params },
          ...(shipTo === undefined ? {} : { ship_to: localityOf(shipTo) }),
          price_id: priceId,
          purpose: "purchase",
          expires_at: asTimestamp(until + config.deadlines.quoteTtlMs),
        },
      });
      return await parked;
    } finally {
      this.#questions.delete(priceId);
      this.quotes.giveUp(priceId);
      await queue.forgetPrice(stored.merchantId, priceId);
    }
  }

  /**
   * What is wrong with these goods against what this order was sold with, or
   * null where nothing is. The order is held to its own promise, never to the
   * card as it stands: the catalog keeps one version per key, and a card
   * republished mid-order would let through goods the agent was not promised
   * or refuse exactly what it read. An order stored without a result of its
   * own is held to the card as it stands.
   */
  async #goodsAgainstTheCard(record: StoredOrder, delivery: Delivery): Promise<CallError | null> {
    const parcel = record.order.mode.parcel === true;
    const promised = parcel ? ShipmentSchema : await this.#promiseOf(record);
    if ("code" in promised) {
      return promised;
    }
    const fit = promised.safeParse(delivery);
    if (fit.success) {
      return null;
    }

    const goods = parcel
      ? "this is not a parcel's shipment, so nothing was written down"
      : `these goods are not what this order for "${cutShort(record.merchantItemId)}" was sold with, so nothing was written down`;
    // The findings travel twice on purpose: `problems` for a handler to walk
    // field by field, and a sentence naming a few and counting the rest for a
    // person reading a log.
    const problems = findingsOf(fit.error.issues);
    const misfits = misfitsIn(problems);

    // On an order that has ended, "this order still stands" marked retryable
    // would tell the merchant to fix his handler and make the goods again for
    // a sale that is over. So an ended order says so and is not retryable,
    // with the misfit fields still named. A synchronous order past its
    // deadline counts as ended before its timer fires, as the machine judges
    // goods by the instant they arrive.
    const ending = isOpen(record.order.state)
      ? this.#overdueSynchronously(record)
        ? "expired"
        : null
      : record.order.state;
    if (ending !== null) {
      return {
        code: "delivery_does_not_match_card",
        message: `${goods} — and this order ended as ${ending}, so there is nothing left to deliver against — ${misfits}`,
        retryable: false,
        problems,
      };
    }

    return {
      code: "delivery_does_not_match_card",
      message: `${goods} and this order still stands where it did — ${misfits}`,
      // The merchant can fix his handler and deliver again until the order's
      // deadline; closing it here would end a sale he could still make on the
      // strength of one bad call.
      retryable: true,
      problems,
    };
  }

  /** Whether a synchronous order's deadline has passed, fired or not. */
  #overdueSynchronously(record: StoredOrder): boolean {
    if (record.order.mode.settle !== "after_fulfillment") {
      return false;
    }
    const due = fulfillmentDeadline(record.order)[0];
    return due !== undefined && this.runtime.clock() >= due.at;
  }

  /**
   * The goods an order for goods is held to: the result it was sold with, or,
   * for an order stored without one, the result its card declares now.
   */
  async #promiseOf(record: StoredOrder): Promise<ReturnType<typeof deliveryCheckFor> | CallError> {
    if (record.result !== undefined) {
      return paramSpecToValidator(record.result, "delivery");
    }

    const stored = await this.runtime.store.cardById(record.itemId);
    if (stored === null) {
      // Nothing removes a card, so this is a defect: stop rather than wave
      // through goods nothing can be compared with.
      throw new Error(
        `the order ${record.order.id} was sold against ${record.itemId}, and there is no such card to hold its goods to`,
      );
    }
    if (stored.card.result === undefined) {
      // Not retryable: only declaring the goods on the card again, or refusing
      // the order, moves this sale.
      const why =
        "this order was sold for goods, and its card has since been republished as a parcel's, which declares no goods to hold these to";
      return {
        code: "delivery_does_not_match_card",
        message: `${why}: nothing was written down, and no delivery can be taken for it until the card declares the goods again or the order is refused`,
        retryable: false,
        problems: [{ path: [], code: "card_declares_no_goods", message: why }],
      };
    }
    return deliveryCheckFor(stored.card);
  }

  /**
   * Where a paid purchase stands, with its seller as read before the payment
   * was checked, so an answer after a charge rests on as few reads as it can.
   */
  async #wherePurchaseStands(
    orderId: string,
    merchant: StoredMerchant | null,
  ): Promise<PurchaseAttempt> {
    const record = await this.runtime.store.orderById(orderId);
    if (record === null) {
      return { step: "no_such_item" };
    }
    const seller =
      merchant === null
        ? {}
        : { seller: { name: merchant.serviceName, site: merchant.sellerSite } };

    if (outcomeFor(record.order) !== "in_progress") {
      return { step: "settled", order: record, delivery: record.delivery, ...seller };
    }

    return { step: "under_way", order: record, ...seller };
  }

  /**
   * The document one of the merchant's calls is answered with. Where the
   * machine has a word for him it is used; where it has none, the answer is
   * his own word for what he sent, never one guessed from what the machine did
   * next, or a refusal could come back as "delivered".
   */
  #answerFor(
    applied: Awaited<ReturnType<OrderRunner["apply"]>>,
    landed: "delivered" | "refused" | "accepted",
  ): OrderCallResponse | null {
    if (applied.outcome === "no_such_order") {
      return null;
    }
    if (applied.outcome === "refused") {
      return { ok: false, error: refusedCall(applied.rejection) };
    }
    if (applied.outcome === "moved_on") {
      // Only the reminder holds an order to a hand-over, never a merchant's
      // call, so reaching this is a defect; throwing beats guessing a word for
      // him.
      throw new Error(
        `a merchant's ${landed} was held to a hand-over, and there is no answer written for an order that moved on`,
      );
    }
    if (applied.answer === null) {
      return { ok: true, result: landed };
    }
    return orderCallResponseOf(applied.answer);
  }
}

/**
 * The payment layer's own words, as many as an agent reads at a glance: its
 * first line, cut at a sentence's length and said to be cut. A refusal can
 * carry a contract call's whole diagnostic, and none of it changes what the
 * agent does next.
 */
function briefly(said: string): string {
  const line = said.split("\n")[0]?.trim() ?? "";
  const cut = line.length > 200 ? `${line.slice(0, 200)}…` : line;
  return cut === said.trim() ? cut : `${cut} (shortened)`;
}

/** What a buyer is told for a payment that got no verdict, by why. */
const NO_VERDICT_WORDS: Readonly<Record<NoVerdict, string>> = {
  no_answer:
    "this payment charged nothing: the payment check gave no verdict on it, because it could not be reached, did not answer or failed on its own side, so the payment was neither accepted nor refused; present the same payment again, which for a new purchase has to arrive while its price holds",
  refused_agentify:
    "this payment charged nothing and was not checked: the payment check turned away Agentify itself or the terms Agentify asked it to check, so Agentify cannot check payments right now and no payment can be taken until it can",
  seller_cannot_be_paid:
    "this payment charged nothing and was not checked: the seller cannot be paid for this purchase right now, so no payment for it can be taken",
  payer_contradicted:
    "this payment charged nothing: the payment check vouched for it but named a different payer from the wallet that signed it, so Agentify did not accept it",
};

/** What an agent whose payment was refused does next, by why it was refused. */
const NEXT_STEP_AFTER: Readonly<Record<PaymentVerificationFailure, string>> = {
  price_stale:
    "the offer it was made against no longer stands, because the price moved or the seller changed where they are paid, so start a new purchase for a fresh price and pay against that",
  insufficient_funds: "fund the paying wallet and pay again for the same price while it holds",
  signature: "sign a new payment for the same price and present it while the price holds",
  amount_not_payable:
    "the payment network will not carry a payment of this amount, which is this purchase's own price, so neither a new signature nor a new purchase at this price will pass",
  wallet_refused:
    "the payment network refused this payment from the wallet that signed it, as that wallet stands",
  unexplained:
    "the payment layer's refusal names no fault Agentify can act on, so Agentify cannot tell whether signing again, funding the wallet or a new purchase would help",
  unrecognised:
    "the payment layer refused it for a reason this system does not recognise, so Agentify cannot tell whether signing again, funding the wallet or a new purchase would help",
};

/** A payment refused here for what the token would refuse in its signature. */
const signedWrongly = (said: string): PurchaseAttempt =>
  verificationRefusal({ verified: false, reason: "signature", message: said });

/** A stamp Agentify did not sign, or one changed since, that is no saved price either. */
const unknownPrice = (): PurchaseAttempt => ({
  step: "payment_not_verified",
  why: "nothing was charged: the price this payment was signed for is not one Agentify recognises now, because it was changed or was issued under a key Agentify no longer holds; request a new price and sign that",
  retryable: false,
});

/** The card's terms or the seller's payee changed after the price was named, whenever that was noticed. */
const offerChanged = (): PurchaseAttempt => ({
  step: "payment_not_taken",
  why: "nothing was charged: this product's terms or where its seller is paid changed after this price was named, so the price no longer stands; request a new price and sign that",
  retryable: false,
});

const QUESTIONS_FULL =
  "this seller is answering as many price questions as it can right now, so this purchase was not started and nothing was charged; ask again in a few seconds";

const NO_PRICE_IN_TIME =
  "the seller's price check did not name a price in time, so this purchase was not started and nothing was charged; it may go through if asked again, and if this repeats, the seller's price check is not answering";

/**
 * How long an agent is asked to wait after the seller's price check was asked
 * and named no price. Unlike a full gate it may be down for good: a handler
 * that always times out, or a shop whose keys are gone.
 */
const SILENT_PRICE_RETRY_AFTER_SECONDS = 10;

const MERCHANT_SAID_UNAVAILABLE =
  "the merchant answered that this product is unavailable; nothing was charged";

const PAYMENT_CHECKS_FULL =
  "this seller has as many payments being checked as Agentify checks at once, so this payment was not used and nothing was charged for it; send the same request with the same payment again in a few seconds";

/**
 * One wallet holds one place and one place in line at a seller, so its next
 * payment waits on its own, however idle the seller is.
 */
const WALLETS_PAYMENT_BEING_CHECKED =
  "this wallet already has a payment being checked at this seller, and Agentify checks one wallet's payments to a seller one after another, so this payment was not used and nothing was charged for it; send the same request with the same payment again once that payment has its answer";

/** The adapter supplies safe diagnostics; its external refusal message can contain private payment bytes. */
function logVerificationRefusal(
  verified: Exclude<VerifyOutcome, { readonly verified: true }>,
  kind: "order" | "price",
  id: string,
): void {
  const code =
    verified.verified === false &&
    verified.code !== undefined &&
    /^[A-Za-z0-9_-]{1,128}$/.test(verified.code)
      ? ` (${verified.code})`
      : "";
  console.warn(
    `[gateway] a payment for ${kind} ${id} did not verify: ${
      verified.verified === false
        ? `refused as ${verified.reason}${code}`
        : `the payment layer gave no verdict (${verified.cause}): ${verified.failure}`
    }`,
  );
}

function verificationRefusal(
  verified: Exclude<VerifyOutcome, { readonly verified: true }>,
): PurchaseAttempt {
  return {
    step: "payment_not_verified",
    why:
      verified.verified === "unknown"
        ? NO_VERDICT_WORDS[verified.cause]
        : `this request charged nothing: ${NEXT_STEP_AFTER[verified.reason]}; it was refused, saying: ${briefly(verified.message)}; if this purchase was already paid for, a fresh payment for the same payment request from the wallet that signed it returns it without a second charge`,
    retryable: verified.verified === "unknown" && verified.cause === "no_answer",
  };
}

const unresolvedPayment = (order: Order): boolean =>
  order.payment === "settling" || order.payment === "outcome_unknown";

/**
 * The refusal before verification for an ended order or an unresolved charge.
 * It names no private order, since whoever sent the payment has not been shown
 * to be its buyer.
 */
function noPaymentTakenFor(order: Order): PurchaseAttempt {
  if (unresolvedPayment(order)) {
    return {
      step: "payment_not_taken",
      why: "this payment was not taken: whether an earlier payment for this order went through is not known yet, and no second one is taken while it is not; asking again later may find out",
      retryable: true,
    };
  }
  return {
    step: "payment_not_taken",
    why: `this payment was not taken, because this order is over. ${
      endingSentenceOf(order) ?? "Nothing was charged for it; start a new purchase to buy it again."
    }`,
    retryable: false,
  };
}

/**
 * Whether an order is over with nothing held for its buyer, so a payment has
 * nothing to buy: an ending that holds nothing, or an order its merchant closed
 * before anyone paid for it. A closed order somebody paid for is that payer's
 * to read, and a payment from anyone else is turned away as somebody else's.
 */
const overWithNothingHeld = (record: StoredOrder): boolean =>
  endedWithNothingHeld(record.order) ||
  (record.order.state === "fulfillment_closed" && record.paidBy === null);

/**
 * Why the machine would not take a merchant's call. Only a closed order gets
 * `order_already_closed`, because merchants branch on that code; every other
 * refusal carries the machine's own code, which the contract's open set of
 * codes allows, together with the state the order was in.
 */
/**
 * The merchant an order call is held to, and how they made it: a key is their
 * worker, a session is a person in the dashboard. A key's call lands only
 * while that key works, read under the order's own hold, so a revocation that
 * arrives after the door let the call in still stops it. A caller who says
 * neither is left unnamed rather than guessed.
 */
function actingAs(merchantId: string, by: Caller | undefined): ActingMerchant {
  if (by === undefined) return { merchantId };
  return by.kind === "key"
    ? { merchantId, keyId: by.keyId, actor: "merchant_worker" }
    : { merchantId, actor: "human" };
}

function refusedCall(rejection: TransitionRejection): CallError {
  const closed = !isOpen(rejection.state);
  return {
    code: closed ? "order_already_closed" : rejection.code,
    message: closed
      ? `this order ended as ${rejection.state}, and ${rejection.event} does not reopen it`
      : `this order is in ${rejection.state}: ${rejection.message}`,
    retryable: rejection.retryable,
  };
}

/**
 * One wallet in one spelling, or null. No facilitator promises a canonical
 * address (a client writes it checksummed, in mixed case) and the ownership
 * guard compares exactly, so the address is lowercased here, the only source
 * of `paidBy`, rather than in each adapter. A blank must become null so the
 * caller's `??` falls back to the payment's fingerprint; an empty string would
 * be one identity shared by every unnamed payer, handing one sender another's
 * purchase.
 */
function walletThatPaid(payer: string | null): string | null {
  const wallet = (payer ?? "").toLowerCase();
  return wallet === "" ? null : wallet;
}

/**
 * The same envelope, restamped to go back on the stream now. No worker has
 * seen it, so it keeps its identifier; a redelivery the machine decides on is
 * a fresh envelope built elsewhere.
 */
function sentNow(envelope: WorkerEnvelope, at: number): WorkerEnvelope {
  return { ...envelope, sent_at: asTimestamp(at) };
}

/**
 * One stored card as its own merchant reads it. `selling` is open exactly
 * where the public catalogue lists the card (`offSaleNow`); `paused` is the
 * card's own flag, so the merchant still sees which cards they paused
 * themselves while the card is off sale for another reason.
 */
function merchantCardOf(stored: StoredCard, theirs: HowTheySell, at: number): MerchantCard {
  return {
    id: stored.id,
    as_of: asTimestamp(stored.asOf),
    card: stored.card,
    selling: offSaleNow(saleFactsOf(stored, theirs), at) === null ? "open" : "paused",
    paused: stored.paused,
  };
}

/**
 * One stored key as its own merchant reads it, built field by field rather
 * than by dropping fields from the row, so a column added to the row later
 * never reaches a screen by accident.
 */
function merchantKeyOf(stored: StoredKey): MerchantKey {
  return {
    id: stored.id,
    label: stored.label,
    created_at: asTimestamp(stored.createdAt),
    last_used_at: stored.lastUsedAt === null ? null : asTimestamp(stored.lastUsedAt),
    disabled_at: stored.disabledAt === null ? null : asTimestamp(stored.disabledAt),
  };
}

/**
 * How many misfits a refusal's one-line message names before it counts the
 * rest instead. The rest are counted rather than dropped, so a reader can tell
 * "these five" from "these five and eleven more".
 */
const MISFITS_NAMED = 5;

/**
 * How much of one misfit is quoted before it is cut short. Capping the count
 * is not enough: every field the card never declared arrives in a single
 * finding that lists them all, so its length is set by what the merchant sent.
 */
const LETTERS_PER_MISFIT = 160;

/**
 * Somebody else's text held to a length, marked where it was cut so nobody
 * reads a cut as the whole. Nothing it trims has a maximum of its own.
 */
function cutShort(text: string): string {
  return text.length <= LETTERS_PER_MISFIT
    ? text
    : `${text.slice(0, LETTERS_PER_MISFIT)}… (cut short)`;
}

/** One finding, said where it is, in a length a line of prose can carry. */
function misfitOf(finding: Problem): string {
  // An unrecognized key carries no path — zod names it in the message instead —
  // so the path is a prefix where there is one rather than the whole of it.
  return cutShort(
    finding.path.length === 0 ? finding.message : `${finding.path.join(".")}: ${finding.message}`,
  );
}

/** Everything wrong with a delivery, in one line a person can act on. */
function misfitsIn(findings: readonly Problem[]): string {
  const named = findings.slice(0, MISFITS_NAMED).map(misfitOf).join("; ");

  const rest = findings.length - MISFITS_NAMED;
  return rest > 0 ? `${named} (and ${rest} more)` : named;
}

/**
 * The most bytes a card's payment challenge header may take. Node's HTTP client
 * and fetch read at most 16 KiB of a response's headers in all; taking half is
 * a margin, chosen rather than measured, for the other headers and for
 * whatever stands between the gateway and the buyer.
 */
const CHALLENGE_HEADER_MAX = 8_192;

/** A card whose challenge at its widest passes the bound, refused while its merchant can be told. */
function oversizedChallenge(widest: number): Problem[] {
  return widest > CHALLENGE_HEADER_MAX
    ? [
        {
          path: [],
          code: "challenge_too_large",
          message:
            `this card's payment challenge, the PAYMENT-REQUIRED header that asks an agent to pay,` +
            ` would be up to ${widest} bytes, and a card is published only if it stays within` +
            ` ${CHALLENGE_HEADER_MAX}: Node's HTTP client and fetch read at most 16384 bytes of a` +
            " response's headers in all, and half of that is kept as a margin for the other" +
            " headers and for whatever stands between us and the buyer; the header carries the" +
            " description, the tags and the name of every declared field, so declare fewer" +
            " fields, give them shorter names, or shorten the description",
        },
      ]
    : [];
}

/**
 * A card that is not going in the catalog, with everything standing in its
 * way. A program reads `problems`; the message is one line for a log, naming
 * every merchant finding plainly, since each is a few words, and quoting only
 * the first of the card's own, which can be many and long.
 */
function cardRejected(
  merchant: readonly MerchantFinding[],
  card: readonly Problem[],
): PublishResult {
  return {
    ok: false,
    error: {
      code: CARD_REJECTED,
      message: `this card was not published: ${whatStands(merchant, card)}`,
      // The same card published again is refused again; only fixing what the
      // findings name changes the outcome.
      retryable: false,
      problems: [...merchant.map((finding) => MERCHANT_PROBLEMS[finding]), ...card],
    },
  };
}

/** What a refusal's line calls each missing merchant setting. */
const MERCHANT_WORDS: Readonly<Record<MerchantFinding, string>> = {
  no_seller_name: "no seller name",
  no_payout_wallet: "no payout wallet",
  no_operator_approval: "no operator approval for the live catalog",
  no_seller_site: "no site for their shop, needed for a purchase paid before delivery or shipment",
};

/** The body of the line: the merchant's missing settings, then the card's findings. */
function whatStands(merchant: readonly MerchantFinding[], card: readonly Problem[]): string {
  const [first] = card;
  const words = merchant.map((finding) => MERCHANT_WORDS[finding]);
  const last = words.pop();
  if (last === undefined) {
    if (first === undefined) {
      // A refusal naming nothing is a defect: the contract cannot carry it and
      // nobody could act on it.
      throw new Error("a card was refused with nothing named as standing in its way");
    }
    const counted = card.length === 1 ? "one thing stands" : `${card.length} things stand`;
    return `${counted} between it and the catalog, and the first of them is ${misfitOf(first)}`;
  }
  const lacks = `the merchant has ${words.length === 0 ? last : `${words.join(", ")} and ${last}`}`;
  if (first === undefined) {
    return `${lacks}, and nothing about the card itself stands in its way; problems carries each of them in full`;
  }
  const counted =
    card.length === 1
      ? "one thing about the card stands in its way as well, which is"
      : `${card.length} things about the card stand in its way as well, the first of which is`;
  return `${lacks}, and ${counted} ${misfitOf(first)}`;
}

/**
 * Each finding about the merchant, as the publish door says it. None is about
 * a field of the card, so each path is empty and each message names what
 * fixes it, writing out the merchant's own call where there is one. The
 * wallet is set only in the dashboard, so its message names the Settings
 * screen; the gateway's own configured address is the operator's and must
 * never stand in for a merchant's, or their takings go to somebody else.
 */
const MERCHANT_PROBLEMS: Readonly<Record<MerchantFinding, Problem>> = {
  no_seller_name: {
    path: [],
    code: MERCHANT_FINDINGS.NO_SELLER_NAME,
    message:
      "this merchant has not set the name their products are sold under, and a card published" +
      " without one is offered for sale through a payment request that names no seller at all;" +
      " set a name with POST /v0/seller-name and publish this card again",
  },
  no_payout_wallet: {
    path: [],
    code: MERCHANT_FINDINGS.NO_PAYOUT_WALLET,
    message:
      "this merchant has not set a wallet for their share of sales, so the money from sales of" +
      " this card would have nowhere to go — a buyer's agent pays into a payout contract made for" +
      " the merchant's wallet, which sends the merchant's share there, and nothing of it is held" +
      " here; a person signed in to the merchant's dashboard sets one on its Settings screen, and" +
      " then this card can be published again",
  },
  no_operator_approval: {
    path: [],
    code: MERCHANT_FINDINGS.NO_OPERATOR_APPROVAL,
    message:
      "this merchant has not been approved by the operator for the live catalog; test" +
      " publication remains available, but live publication stays refused until the operator" +
      " admits this merchant",
  },
  no_seller_site: {
    path: [],
    code: MERCHANT_FINDINGS.NO_SELLER_SITE,
    message:
      "this merchant has not set the site of their shop, and an asynchronous or parcel card" +
      " is published only with one: the buyer needs it to read the merchant's terms and ask" +
      " about an unfulfilled purchase; set it with POST /v0/seller-name and publish" +
      " this card again",
  },
};

/**
 * A merchant's wallet, already read at an instant, as the route answers with
 * it. The pending change travels with the address, so a caller that reads its
 * old address back sees in the same answer that its change is waiting, not
 * lost.
 */
function payoutWalletAnswer(wallet: StoredPayoutWallet): PayoutWallet {
  return {
    payout_wallet: wallet.address,
    pending:
      wallet.pending === null
        ? null
        : {
            payout_wallet: wallet.pending.address,
            takes_effect_at: asTimestamp(wallet.pending.takesEffectAt),
          },
  };
}

/** Zod's account of what is wrong, in the shape the contract publishes. */
function findingsOf(
  issues: readonly { path: readonly PropertyKey[]; code: string; message: string }[],
): Problem[] {
  return issues.map((issue) => ({
    path: issue.path.map((step) => String(step)),
    code: issue.code,
    message: issue.message,
  }));
}

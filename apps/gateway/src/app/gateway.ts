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
  OrderState,
  PaymentVerificationFailure,
  TransitionRejection,
} from "@agentify/core";
import {
  createOrder,
  deadlines,
  fulfillmentDeadline,
  isOpen,
  onTheMerchantsOpenList,
  outcomeFor,
} from "@agentify/core";
import {
  type Acceptance,
  CARD_REJECTED,
  type CallError,
  type Card,
  CardSchema,
  CONTRACT_VERSION,
  type Delivery,
  type DisabledKey,
  deliveryCheckFor,
  type HandlerAnswer,
  type IssuedKey,
  localityOf,
  MERCHANT_FINDINGS,
  type MerchantCard,
  type MerchantCardList,
  type MerchantFinding,
  type MerchantKey,
  type MerchantKeyList,
  type OrderAcceptResponse,
  type OrderCallResponse,
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
import {
  type Announcement,
  type AskedInTheDashboard,
  type AskedWith,
  announcedLabel,
} from "../announcements.js";
import { failureNamed } from "../failure-named.js";
import type { AnnouncementOutcome } from "../ports/announcer.js";
import { asTimestamp } from "../ports/clock.js";
import type { DrawnEnvelope, Reminder } from "../ports/queue.js";
import type {
  Integration,
  IntegrationSwitch,
  StoredCard,
  StoredKey,
  StoredOrder,
  StoredPayoutWallet,
} from "../ports/store.js";
import { orderCallResponseOf } from "./answers.js";
import {
  issueKey,
  keyDigest,
  payoutWalletFrom,
  registerMerchant,
  setSellerSite,
  setServiceName,
} from "./merchants.js";
import { OrderRunner, SWEEP_EFFECTS } from "./runner.js";
import {
  cardAsHeld,
  missingFrom,
  modeForCard,
  payoutWalletAt,
  policyFor,
  priceCheckOf,
  type Runtime,
  sellableBy,
  sellingFor,
} from "./runtime.js";
import { purchaseOf, Waiting } from "./waiting.js";

/**
 * How stale a key's last-used mark may get before a call refreshes it, so a
 * busy key is written a dozen times an hour rather than on every request. A
 * constant rather than a setting: a knob here could put a write on every
 * request of the money path.
 */
const KEY_USE_WRITTEN_EVERY_MS = 5 * 60_000;

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
 * after this change's own message went out.
 */
export type WalletChangeRefusal =
  | "nobody_to_tell"
  | "not_announced"
  | "raced"
  | "raced_after_announcing";

/**
 * Who a call comes from: a key, as the door resolved it, or a dashboard
 * session, which calls in-process as the merchant on the signed-in account's
 * row and holds no key. A session is known only by its account's email, and
 * that is what a message names.
 */
export type Caller =
  | { readonly kind: "key"; readonly keyId: string }
  | { readonly kind: "signed_in"; readonly email: string };

/** The queue's name for the daily sweep of claims on payments. */
const SWEEP_CLAIMS = "agentify_forget_old_claims";

/**
 * The catalog as it stands after the selling switch, or a refusal. A merchant
 * who has left can still press the switch, so that is an ordinary refusal
 * rather than a thrown error.
 */
export type SellingChange =
  | { readonly ok: true; readonly cards: MerchantCardList }
  | { readonly ok: false; readonly why: string };

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
  /** What a purchase of this card would meet right now. */
  readonly selling: MerchantSelling;
  /** The seller's name in a discovery catalog. */
  readonly serviceName: string | null;
  /**
   * Where this card's own merchant is paid. It is read from the card's owner
   * and nowhere else, or one seller's takings go to another.
   */
  readonly payoutWallet: string | null;
}

/** What a purchase attempt came to. */
export type PurchaseAttempt =
  /** The order is priced and waiting to be paid for: here is what it costs. */
  | { readonly step: "pay"; readonly order: StoredOrder }
  /** The purchase is over, one way or another. */
  | { readonly step: "settled"; readonly order: StoredOrder; readonly delivery: Delivery | null }
  /** The purchase is under way and the agent is not waiting on it. */
  | { readonly step: "under_way"; readonly order: StoredOrder }
  | { readonly step: "no_such_item" }
  | { readonly step: "params_rejected"; readonly problems: readonly Problem[] }
  /** A parcel's purchase without an address, or another purchase with one. */
  | { readonly step: "ship_to_rejected"; readonly message: string }
  /** A payment carrying an address other than the one its order was priced for. */
  | { readonly step: "ship_to_changed" }
  | { readonly step: "not_selling"; readonly message: string }
  /** This payment has already been presented for a different order. */
  | {
      readonly step: "payment_already_spent";
      readonly heldBy: string;
      /** Whether that order is still one an agent could collect anything from. */
      readonly collectable: boolean;
    }
  /** The machine would not take this payment on this order, and said why. */
  | { readonly step: "payment_not_taken"; readonly why: string; readonly retryable: boolean }
  /** The payment layer did not vouch for this payment; nothing was touched. */
  | { readonly step: "payment_not_verified"; readonly why: string; readonly retryable: boolean }
  /** This order is somebody else's purchase, and this payment is not its own. */
  | { readonly step: "not_this_purchase" };

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
  readonly integration: Integration;
}

/** What an agent is told of a product that went off sale as its order was made. */
const NOT_ON_SALE = "this product is not on sale at the moment, so no new order is taken";

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
   * Which order each open price question belongs to, and whose it is. A price
   * identifier is not a secret — it travels on a stream and lands in a receipt
   * — so the answer is checked against the merchant too, or anyone holding one
   * from a log could set the price of somebody else's purchase.
   */
  readonly #questions = new Map<string, { orderId: string; merchantId: string }>();
  /**
   * The polls held open right now, by merchant, with the key each came in on,
   * so revoking a key ends its waiting at once. Otherwise a held poll draws
   * whatever arrives in its window, and code the merchant had just cut off
   * would take the next order.
   */
  readonly #held = new Map<string, Set<HeldPoll>>();

  constructor(runtime: Runtime) {
    this.runtime = runtime;
    this.runner = new OrderRunner(runtime);
  }

  /**
   * Starts the queue and points its reminders at the order machine; each
   * reminder becomes one event and nothing more.
   */
  async start(): Promise<void> {
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

    // What the orders are still owed is swept the same way. Two gateways can
    // run it at once, because pg-boss re-offers a job that outlives its
    // fifteen-minute expiry, so the sweep itself runs under a named lock; a
    // queue policy would not do, as pg-boss writes queue settings only when the
    // queue is first created. A lock wedged for good shows only as the sweep's
    // "did nothing" log line, every day.
    await this.runtime.queue.everyDay(SWEEP_EFFECTS, () => this.runner.sweep());
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
    // that has been paid for, and the money is owed back.
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
   */
  async publishCard(
    merchantId: string,
    body: unknown,
    integration: Integration = "api",
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
    const missing = missingFrom(merchant, this.runtime.config);

    // A parcel's card asks one more thing of its merchant: the site of their
    // shop, where a buyer takes a parcel that did not arrive. It is checked on
    // the card as sent, so a card refused for something else still names it.
    const parcelWithoutSite =
      typeof body === "object" &&
      body !== null &&
      (body as { readonly fulfillment?: unknown }).fulfillment === "ship" &&
      merchant.sellerSite === null
        ? [MERCHANT_FINDINGS.NO_SELLER_SITE]
        : [];
    if (!parsed.success) {
      return cardRejected([...missing, ...parcelWithoutSite], findingsOf(parsed.error.issues));
    }
    // Asked of the parsed card, so a price written as one string meets the same
    // rule in the same words as one written as two fields.
    const unsellable = [
      ...priceProblemsOf(parsed.data.price),
      ...notOnThisChannel(parsed.data, this.runtime.config.environment),
    ];
    const lacking = [...missing, ...parcelWithoutSite];
    if (lacking.length > 0 || unsellable.length > 0) {
      return cardRejected(lacking, unsellable);
    }

    const stored = await this.runtime.store.publishCard(
      merchantId,
      parsed.data,
      this.runtime.clock(),
      integration,
    );
    if (stored.integration !== integration) {
      return cardRejected([], [heldByTheOther(integration, parsed.data.merchant_item_id)]);
    }
    return { ok: true, id: stored.id };
  }

  /**
   * The catalog an agent reads: the cards that are actually for sale. A paused
   * card is left out rather than listed and then refused, because an agent
   * budgets against what it lists and would only find out at the till.
   */
  async catalog(): Promise<{ readonly items: ProjectedCard[] }> {
    const entries = await this.runtime.store.catalogEntries();
    return {
      items: entries
        .filter(
          (entry) =>
            sellingFor(
              entry.merchant,
              entry.card,
              sellableBy(entry, this.runtime.config),
              entry.integration,
            ) === "open",
        )
        .map((entry) =>
          publicCardOf(cardAsHeld(entry.card.card, this.runtime.config), {
            id: entry.card.id,
            as_of: asTimestamp(entry.card.asOf),
            seller: { name: entry.serviceName, site: entry.sellerSite },
          }),
        ),
    };
  }

  /**
   * One product as a thing that can be paid for, or null where there is no
   * such card. The selling word is the one the order machine is given, so a
   * card reported as anything but open is one whose purchase would be refused
   * and must not be offered a challenge. Unscoped, like every read on the
   * buying surface: an agent has no key.
   */
  async paidResource(itemId: string): Promise<PaidResource | null> {
    const stored = await this.runtime.store.cardById(itemId);
    if (stored === null) {
      return null;
    }
    const merchant = await this.runtime.store.merchantById(stored.merchantId);
    return {
      stored,
      // The database refuses a card with no owner; if one were ever found, the
      // safe reading is that it is not for sale.
      selling:
        merchant === null
          ? "paused"
          : sellingFor(
              merchant.selling,
              stored,
              sellableBy(merchant, this.runtime.config),
              merchant.integration,
            ),
      serviceName: merchant?.serviceName ?? null,
      // A pending wallet change is the address once its moment has come, and
      // not before.
      payoutWallet:
        merchant === null
          ? null
          : payoutWalletAt(merchant.payoutWallet, this.runtime.clock()).address,
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
      cards: cards.map((stored) => merchantCardOf(stored, theirs)),
    };
  }

  /**
   * The merchant's selling word, the integration they sell through, and
   * whether a sale of theirs could be made at all (a payout wallet and a name).
   * Every key and every card names a merchant that exists, so a missing one is
   * a defect and this throws rather than answer "open" for somebody nobody can
   * find.
   */
  async #howTheySell(merchantId: string): Promise<HowTheySell> {
    const merchant = await this.runtime.store.merchantById(merchantId);
    if (merchant === null) {
      throw new Error(`there is no merchant ${merchantId}, so there is no word for their selling`);
    }
    return {
      selling: merchant.selling,
      sellable: sellableBy(merchant, this.runtime.config),
      integration: merchant.integration,
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
  ): Promise<MerchantCard | null> {
    const stored = await this.runtime.store.setCardPaused(merchantId, itemId, paused);
    if (stored === null) {
      // No such card, or not this merchant's: the same answer on purpose, so a
      // pause call cannot probe what somebody else sells.
      return null;
    }
    return merchantCardOf(stored, await this.#howTheySell(merchantId));
  }

  /**
   * Stops all selling for this merchant, or starts it again. Resuming leaves
   * the cards paused in their own right paused, and the answer carries the
   * whole catalog so which cards came back is stated rather than inferred.
   */
  async setSelling(merchantId: string, selling: MerchantSelling): Promise<SellingChange> {
    const now = await this.runtime.store.selling(merchantId);
    if (now === "departed") {
      // A departure is not a heavier pause and this switch does not undo one:
      // leaving closed the open orders and left refunds owed, and reopening
      // would put the merchant back in the catalog with none of that unwound.
      return { ok: false, why: "this merchant has left, and selling is not resumed by a switch" };
    }
    await this.runtime.store.setSelling(merchantId, selling);
    return { ok: true, cards: await this.merchantCards(merchantId) };
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
   * told what it is.
   */
  async sellThrough(merchantId: string, to: Integration): Promise<IntegrationSwitch> {
    const switched = await this.runtime.store.switchIntegration(merchantId, to);
    if (switched.switched) {
      this.#letGo(merchantId, () => true);
    }
    return switched;
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
  async setSellerName(merchantId: string, asked: SellerNameRequest): Promise<SellerName> {
    // Only the fields the request names are written; one left out stays as it
    // was. The route already checked both, so a throw from either is a caller
    // that skipped it.
    const at = this.runtime.clock();
    let merchant = await this.runtime.store.merchantById(merchantId);
    if (asked.seller_name !== undefined) {
      merchant = await setServiceName(this.runtime.store, merchantId, asked.seller_name, at);
    }
    if (asked.seller_site !== undefined) {
      merchant = await setSellerSite(this.runtime.store, merchantId, asked.seller_site, at);
    }
    if (merchant === null) {
      throw new Error(`this call was made as ${merchantId}, and there is no such merchant`);
    }
    return { seller_name: merchant.serviceName, seller_site: merchant.sellerSite };
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
   * once and announced afterwards. No lock is held across the announcement:
   * the write is conditional on the row still holding what was read, so a
   * change recorded in between turns this one away as `raced`. The answer is
   * read off the written row, never echoed.
   */
  async setPayoutWallet(
    merchantId: string,
    wallet: string,
    askedBy: Extract<Caller, { readonly kind: "signed_in" }>,
  ): Promise<PayoutWallet | WalletChangeRefusal> {
    const askedWith: AskedInTheDashboard = { kind: "signed_in", email: askedBy.email };
    // The dashboard holds the same rule on the way in, so a throw from here is
    // a caller that skipped it.
    const address = payoutWalletFrom(wallet);
    const merchant = await this.runtime.store.merchantById(merchantId);
    if (merchant === null) {
      throw new Error(`this call was made as ${merchantId}, and there is no such merchant`);
    }
    const read = merchant.payoutWallet;
    const now = payoutWalletAt(read, this.runtime.clock());

    if (!this.#announces()) {
      return await this.#recordWallet(merchantId, read, { address, pending: null });
    }

    if (now.address === null) {
      // The first address replaces nothing, so it waits on nothing and a
      // message that cannot be sent refuses nothing; the message is how the
      // owner hears of a session that is not theirs setting it.
      const set = await this.#recordWallet(merchantId, read, { address, pending: null });
      if (typeof set !== "string") {
        this.#announceAfterwards({
          kind: "wallet_set",
          merchant_id: merchantId,
          to: address,
          asked_with: askedWith,
        });
      }
      return set;
    }

    if (address === now.address) {
      if (now.pending === null) {
        return payoutWalletAnswer(now);
      }
      const cancelled = now.pending.address;
      const written = await this.#recordWallet(merchantId, read, { address, pending: null });
      if (typeof written !== "string") {
        this.#announceAfterwards({
          kind: "wallet_change_cancelled",
          merchant_id: merchantId,
          kept: address,
          cancelled,
          asked_with: askedWith,
        });
      }
      return written;
    }

    if (now.pending?.address === address) {
      return payoutWalletAnswer(now);
    }

    const told = await this.#announce({
      kind: "wallet_change",
      merchant_id: merchantId,
      from: now.address,
      to: address,
      not_before: asTimestamp(this.runtime.clock() + WALLET_CHANGE_WAITS_MS),
      asked_with: askedWith,
    });
    if (told !== "handed_over") {
      console.warn(`[gateway] a payout wallet change for ${merchantId} was refused: ${told}`);
      return told === "not_handed_over" ? "not_announced" : told;
    }
    // Counted from now, after every message was handed over, so the change
    // takes effect no earlier than the moment any message named.
    const recorded = await this.#recordWallet(merchantId, read, {
      address: now.address,
      pending: { address, takesEffectAt: this.runtime.clock() + WALLET_CHANGE_WAITS_MS },
    });
    return recorded === "raced" ? "raced_after_announcing" : recorded;
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
    read: StoredPayoutWallet,
    next: StoredPayoutWallet & { readonly address: string },
  ): Promise<PayoutWallet | "raced"> {
    const written = await this.runtime.store.setPayoutWallet(
      merchantId,
      read,
      next,
      this.runtime.clock(),
    );
    if (written === null) {
      throw new Error(`this call was made as ${merchantId}, and there is no such merchant`);
    }
    if (written !== "moved") {
      return payoutWalletAnswer(payoutWalletAt(written.payoutWallet, this.runtime.clock()));
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

  /**
   * Who a call came from, as a message names it: the account a dashboard
   * session is signed in as, or a key of the merchant's own code, named the way
   * their list of keys names it.
   */
  async #named(merchantId: string, askedBy: Caller): Promise<AskedWith> {
    if (askedBy.kind === "signed_in") {
      return { kind: "signed_in", email: askedBy.email };
    }
    const key = (await this.runtime.store.keysOf(merchantId)).find(
      (one) => one.id === askedBy.keyId,
    );
    if (key === undefined) {
      throw new Error(
        `the call was made with ${askedBy.keyId}, and ${merchantId} has no such key to name`,
      );
    }
    return { kind: "merchant_code", id: key.id, label: announcedLabel(key.label) };
  }

  /**
   * This merchant's keys, revoked ones included. Which key opened a call over
   * the API is the route's to add, since only such a call has one.
   */
  async merchantKeys(merchantId: string): Promise<MerchantKeyList["keys"]> {
    return (await this.runtime.store.keysOf(merchantId)).map(merchantKeyOf);
  }

  /**
   * Issues another key for this merchant's own code and returns its secret
   * once. On the live deployment the merchant is told afterwards and the key
   * never waits on the message: a key cannot move money or set the wallet, and
   * mail being down must not keep a merchant from a key.
   */
  async issueMerchantKey(merchantId: string, label: string, askedBy: Caller): Promise<IssuedKey> {
    const issued = await issueKey(
      this.runtime.store,
      this.runtime.ids,
      merchantId,
      label,
      this.runtime.clock(),
      this.runtime.config.environment,
    );
    if (this.#announces()) {
      this.#announceAfterwards({
        kind: "key_issued",
        merchant_id: merchantId,
        key: { id: issued.key.id, label: announcedLabel(issued.key.label) },
        asked_with: await this.#named(merchantId, askedBy),
      });
    }
    return { key: merchantKeyOf(issued.key), secret: issued.secret };
  }

  /**
   * Stops one of this merchant's keys working. `locked_out` is the key this
   * very call was made with, refused before anything is read; a dashboard
   * session holds no key and never meets it. `null` is a key that does not
   * exist or is somebody else's, told apart nowhere, so a refusal cannot count
   * another merchant's keys.
   *
   * Two calls at once, each with a key naming the other, leave the merchant
   * with no working key. That is not refused: refusing a merchant their own
   * last key is an open product question, and the dashboard, signed in to by
   * a mailed link, can always issue another.
   */
  async disableMerchantKey(
    merchantId: string,
    keyId: string,
    caller: Caller,
  ): Promise<DisabledKey | "locked_out" | null> {
    if (caller.kind === "key" && keyId === caller.keyId) {
      return "locked_out";
    }
    const disabled = await this.runtime.store.disableKeyOf(merchantId, keyId, this.runtime.clock());
    if (disabled === null) {
      return null;
    }
    this.#letGo(merchantId, (held) => held.keyId === keyId);
    return { key: merchantKeyOf(disabled) };
  }

  // --- buying ---------------------------------------------------------------

  /**
   * The first half of a purchase: an order is opened, the merchant is asked
   * what the goods cost if his card says to ask, and the agent is told what to
   * pay — or told the purchase is already over, which is what a card that is
   * out of stock comes to.
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
    const created = createOrder({
      id: this.runtime.ids("ord"),
      at,
      mode: modeForCard(stored.card),
      policy: policyFor(stored.card, this.runtime.config),
      priceCheck: priceCheckOf(stored.card),
      cardPrice: {
        amount: stored.card.price.amount,
        currency: stored.card.price.currency,
        asOf: stored.asOf,
      },
      // Whether the money that pays for this is real, which only the chain's
      // environment decides. The receipt copies it from the order, so this is
      // the one place it is set.
      test: this.runtime.config.environment === "test",
      // The merchant's switch, the card's own pause, whether the card's
      // integration is the one the merchant sells through, and whether the
      // merchant could make a sale at all (a payout wallet, a name), folded
      // into one word the machine refuses on before an order exists.
      selling: sellingFor(theirs.selling, stored, theirs.sellable, theirs.integration),
    });

    if (!created.ok) {
      return { step: "not_selling", message: created.rejection.message };
    }

    // The price question is named before the order is written, because a
    // parcel's order keeps the name: the question carries where the parcel
    // goes, and it leaves the queue with the rest of the address.
    const asksThePrice = created.effects.some((effect) => effect.kind === "request_quote");
    const priceQuestion = asksThePrice ? this.runtime.ids("prc") : null;

    const record: StoredOrder = {
      order: created.order,
      // Settled here and never again: this puts the order on the card's
      // merchant's stream, and every later read of it is checked against it.
      merchantId: stored.merchantId,
      itemId: stored.id,
      merchantItemId: stored.card.merchant_item_id,
      // What the agent was promised, kept with the order so a card republished
      // since cannot change what this sale is held to. A parcel's card declares
      // none: its order is held to a shipment.
      ...(stored.card.result === undefined ? {} : { result: stored.card.result }),
      params: { ...params },
      ...(shipTo === undefined ? {} : { shipTo }),
      ...(shipTo === undefined || priceQuestion === null ? {} : { priceQuestion }),
      priceId: null,
      delivery: null,
      payment: null,
      // Set when a payment is verified and not before: the merchant may still
      // move their wallet between now and the moment an agent pays.
      payTo: null,
      paidBy: null,
      settlement: null,
      paymentWords: [],
      paymentWordsDropped: 0,
      openDeliveryId: null,
    };
    // Written only while the merchant still sells through the card's
    // integration: a switch landing between the word above and this write
    // would otherwise leave an order nothing will draw.
    const written = await this.runner.create(record, created.effects, at, stored.integration);
    if (written === null) {
      return { step: "not_selling", message: NOT_ON_SALE };
    }

    if (priceQuestion !== null) {
      await this.#askThePrice(record, stored, priceQuestion);
    }

    return this.#wherePurchaseStands(record.order.id);
  }

  /**
   * The second half: the agent has paid. What follows is the machine's, and
   * how long the agent waits for it depends on the mode — a synchronous
   * purchase is answered with the goods, so the agent stays on the call until
   * the order has an answer or the promised ceiling runs out.
   */
  async payPurchase(
    orderId: string,
    payment: string,
    fingerprint: string,
    shipTo?: ShipTo,
  ): Promise<PurchaseAttempt> {
    const before = await this.runtime.store.orderById(orderId);
    if (before === null) {
      return { step: "no_such_item" };
    }

    // An order that is over with no money taken and no goods held takes no
    // payment: verifying one could only, if refused, tell the agent to pay
    // again for a price that is gone.
    if (
      NOTHING_TO_PAY_FOR.includes(before.order.state) ||
      (before.order.state === "expired" && !before.order.heldFulfillment)
    ) {
      return this.#wherePurchaseStands(orderId);
    }

    // The timer that closes an order whose price lapsed can fire late, so a
    // payment arriving after the lapse closes the order as the timer would
    // have, before anything is verified or claimed. A payment that arrives in
    // time and is still being checked when the price runs out is not covered:
    // the timer can close that order first.
    const arrivedAt = this.runtime.clock();
    const lapsed = deadlines(before.order).find(
      (deadline) =>
        (deadline.kind === "quote_expiry" || deadline.kind === "payment_after_confirmation") &&
        deadline.at <= arrivedAt,
    );
    if (lapsed !== undefined) {
      await this.runner.apply(orderId, {
        kind: "deadline_expired",
        at: lapsed.at,
        deadline: lapsed.kind,
      });
      return this.#wherePurchaseStands(orderId);
    }

    // A payment is for the address its order was priced for, checked before
    // anything is verified: one naming another address is a different
    // purchase, and one naming none pays for the priced one. Once Agentify's
    // copy is erased there is nothing left to compare with.
    if (shipTo !== undefined) {
      const held = before.shipTo;
      if (held === undefined) {
        return {
          step: "ship_to_rejected",
          message: "this product is not shipped, so a payment for it carries no ship_to",
        };
      }
      if (!("erasedAt" in held) && !sameAddress(held, shipTo)) {
        return { step: "ship_to_changed" };
      }
    }

    const price = before.order.price;
    if (price === null) {
      // Challenges are issued only for priced orders, so this payment is for
      // the wrong order or was built without a challenge.
      return {
        step: "payment_not_verified",
        why: "this order has no price for a payment to be checked against",
        retryable: false,
      };
    }

    // The payment is verified before any lock is taken, because verifying is a
    // network round trip. A payment that does not verify closes and claims
    // nothing, so a stranger's junk cannot spend the life of somebody else's
    // order; the order stays open until its own deadline.
    //
    // The payee is this order's merchant's address, read once here at the
    // instant of verification, and the same string is kept on the order for
    // the charge, so the money goes where the payer signed for it to go rather
    // than wherever the merchant's wallet has moved by then.
    const payingMerchant = await this.runtime.store.merchantById(before.merchantId);
    const payTo =
      payingMerchant === null
        ? null
        : payoutWalletAt(payingMerchant.payoutWallet, this.runtime.clock()).address;

    const verified = await this.runtime.facilitator.verify({
      orderId,
      amount: price.amount,
      currency: price.currency,
      payment,
      payTo,
    });

    if (verified.verified !== true) {
      // A refusal says what to do next, since that depends on why the payment
      // failed and nothing else tells the agent, and it says nothing was
      // charged.
      const why =
        verified.verified === false
          ? `nothing was charged: ${NEXT_STEP_AFTER[verified.reason]}; the payment layer said: ${briefly(verified.message)}`
          : verified.message;
      // The layer's words go to the agent and not the log: they can quote the
      // payment presented, and a mismatch is described with what the payer's
      // client put in it, newlines included.
      console.warn(
        `[gateway] a payment for ${orderId} did not verify: ${
          verified.verified === false
            ? `refused as ${verified.reason}`
            : "the payment layer could not be asked, or did not answer"
        }`,
      );
      return {
        step: "payment_not_verified",
        why,
        // "unknown" means nobody said no — the layer did not answer or could
        // not be asked — so trying again may work; "false" means the same
        // payment will not pass, though a corrected one still may.
        retryable: verified.verified === "unknown",
      };
    }

    // Every clock the goods run on counts from this instant, and the park
    // below waits `syncBudgetMs` from it, the longest the machine may still be
    // deciding. Counted from when the order opened or when this call arrived,
    // the park would give up while the answer is still on its way, and the
    // agent is charged and told "in progress" while holding nothing.
    // `presentVerifiedPayment` stamps `paidAt` a little later; the park may
    // outlast the machine's window but must not fall short of it, so this
    // earlier reading is the one used.
    const checkedOutAt = this.runtime.clock();

    // The owner is who the payment layer says paid, never the address the
    // payment declares of itself. Where the layer names no payer, the
    // payment's fingerprint stands in; it is derived from what was signed, so
    // it is no more forgeable.
    const owner = walletThatPaid(verified.payer) ?? fingerprint;

    // One authorisation buys one order, which ownership by payer cannot ensure
    // since the same wallet would own both. It is claimed after verification,
    // so a payment that never checked out never burns a claim.
    const claim = await this.runtime.store.claimPayment(fingerprint, orderId);
    if (!claim.claimed) {
      const holder = await this.runtime.store.orderById(claim.heldBy);
      return {
        step: "payment_already_spent",
        heldBy: claim.heldBy,
        // Whether that order is still open, and so worth going back to
        // whatever its status reads: an open order whose charge went quiet may
        // hold goods and moved money, and an agent told it was over would pay
        // a second time.
        collectable: holder !== null && isOpen(holder.order.state),
      };
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
    );

    // These two turned the payment away before it spent anything, so the claim
    // is released; held, it would tell the buyer who lost the race that their
    // next attempt was already spent on somebody else's order. `refused` keeps
    // its claim, because some of its causes have moved money.
    if (taken.kind === "no_such_order") {
      this.runner.purchases.giveUp(key);
      await this.runtime.store.releaseClaim(fingerprint, orderId);
      return { step: "no_such_item" };
    }
    if (taken.kind === "not_owner") {
      this.runner.purchases.giveUp(key);
      await this.runtime.store.releaseClaim(fingerprint, orderId);
      return { step: "not_this_purchase" };
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

    return this.#wherePurchaseStands(orderId);
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

  /** One of this merchant's orders. Another merchant's is not found. */
  async merchantOrder(merchantId: string, orderId: string): Promise<StoredOrder | null> {
    return this.runtime.store.merchantOrder(merchantId, orderId);
  }

  /**
   * Which key a request presented, or null. The lookup is by digest, so no
   * secret is compared and the timing says nothing about how much of a key was
   * right; a key never issued and a disabled one look the same. The whole row
   * comes back because a merchant may not disable the key they are calling
   * with, and this is the one place a key's last use is marked.
   */
  async keyBehind(presented: string): Promise<StoredKey | null> {
    const key = await this.runtime.store.workingKey(keyDigest(presented));
    if (key !== null) {
      await this.#noteKeyUse(key);
    }
    return key;
  }

  /**
   * Marks this key as used, unless it was marked within the window. Awaited
   * rather than left running, because an unheld rejection takes the process
   * down and a late write can land on a pool being closed. A failure is only
   * logged: no sale may be refused because this column could not be updated.
   */
  async #noteKeyUse(key: StoredKey): Promise<void> {
    const at = this.runtime.clock();
    if (key.lastUsedAt !== null && at - key.lastUsedAt < KEY_USE_WRITTEN_EVERY_MS) {
      return;
    }
    try {
      await this.runtime.store.noteKeyUse(key.id, at);
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
   * A poll held open ends with nothing once the key it came in on is revoked
   * (`#held`), and a merchant selling through an integration other than
   * `drawing.through` is handed nothing.
   */
  async poll(
    merchantId: string,
    waitMs: number,
    drawing: PollDrawing = {},
  ): Promise<WorkerPollResponse> {
    const { gone, keyId = null, through = "api" } = drawing;
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
      if (keyId !== null && !(await this.#keyStillWorks(merchantId, keyId))) {
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
      return await this.#drawFor(merchantId, waitMs, signal);
    } finally {
      holding.delete(held);
      if (holding.size === 0 && this.#held.get(merchantId) === holding) {
        this.#held.delete(merchantId);
      }
    }
  }

  async #keyStillWorks(merchantId: string, keyId: string): Promise<boolean> {
    const keys = await this.runtime.store.keysOf(merchantId);
    return keys.some((key) => key.id === keyId && key.disabledAt === null);
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
      const handing = await this.#handOut(merchantId, drawn);
      if (handing.length > 0) {
        return { contract_version: CONTRACT_VERSION, envelopes: handing };
      }
      if (passed >= PASSED_AT_MOST || (window > 0 && performance.now() >= until)) {
        return nothing;
      }
    }
  }

  /** Records the hand-over of what was drawn, and returns what may go to the worker. */
  async #handOut(
    merchantId: string,
    drawn: readonly DrawnEnvelope[],
  ): Promise<WorkerPollResponse["envelopes"]> {
    const { config, queue, clock } = this.runtime;
    const handing: WorkerPollResponse["envelopes"] = [];
    const finished: string[] = [];

    for (const delivery of drawn) {
      if (delivery.envelope.kind !== "order") {
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
          { merchantId },
        );
      } catch (thrown) {
        // Recording the hand-over failed. The envelope goes back on the
        // stream rather than being lost with a failed response, and the poll
        // draws past it to whatever is next.
        console.error(
          `[gateway] could not record the hand-over of ${orderId}: ${failureNamed(thrown)}`,
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

      if (applied.outcome !== "moved") {
        if (applied.outcome === "no_such_order") {
          // Orders are never deleted, so this means the scope refused an order
          // that is not this merchant's. That cannot happen while envelopes
          // reach only their own merchant's stream, so it is logged loudly.
          console.error(
            `[gateway] ${merchantId} drew an envelope for ${orderId}, which is not their order`,
          );
        }
        // The machine refused the hand-over, so nobody is given the order:
        // passing it on would ask a merchant to work on a purchase that is
        // over, or hand them a parcel whose buyer's address is already erased.
        // An ordinary order that owes a refund is not refused, because late
        // goods still close the debt.
        finished.push(delivery.handle);
        continue;
      }

      await this.#remindMeIfNobodyAnswers(applied.order, handOver, at);
      handing.push(delivery.envelope);
      finished.push(delivery.handle);
    }

    // The queue is told last, once the hand-over has been recorded. Told
    // first, a throw part way through would leave an envelope finished that
    // nobody was ever handed.
    for (const handle of finished) {
      await queue.finish(merchantId, handle);
    }

    return handing;
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
   * The price and availability for a question that came off the stream. The
   * acknowledgement is the merchant's cue to release stock he set aside, so
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
    const applied = await this.runner.apply(
      asked.orderId,
      response.available
        ? {
            kind: "quote_answered",
            at,
            available: true,
            price: {
              amount: response.price.amount,
              currency: response.price.currency,
              asOf: Date.parse(response.as_of),
            },
          }
        : { kind: "quote_answered", at, available: false },
      { priceId },
      { merchantId },
    );

    // Finished either way: a second answer could only be told the same, and
    // whoever is parked on the purchase now has a price or nothing left to
    // wait for.
    this.#questions.delete(priceId);
    this.quotes.answer(priceId, response);

    return { used: applied.outcome === "moved" };
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
  ): Promise<OrderCallResponse | null> {
    if ("delivered" in answer) {
      return this.deliverOrder(merchantId, orderId, answer.delivered, "handler");
    }
    if ("refused" in answer) {
      return this.refuseOrder(merchantId, orderId, answer.refused, "handler");
    }

    return this.#takeOrderOn(merchantId, orderId, answer.accepted);
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
      { merchantId },
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
      !sameShipment(applied.order.delivery, delivery)
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
  ): Promise<OrderCallResponse | null> {
    const at = this.runtime.clock();
    const applied = await this.runner.apply(
      orderId,
      from === "handler"
        ? { kind: "handler_refused", at, code: refusal.code, message: refusal.message }
        : { kind: "refuse_called", at, code: refusal.code, message: refusal.message },
      { openDeliveryId: null },
      { merchantId },
    );
    return this.#answerFor(applied, "refused");
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
  ): Promise<OrderAcceptResponse | null> {
    const taken = await this.#takeOrderOn(merchantId, orderId, acceptance);
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
  ): Promise<OrderCallResponse | null> {
    // The acceptance carries no field, since `AcceptanceSchema` is empty: the
    // merchant is held to the card's delivery deadline and to nothing they say
    // here.
    const at = this.runtime.clock();
    const applied = await this.runner.apply(
      orderId,
      { kind: "handler_accepted", at },
      { openDeliveryId: null },
      { merchantId },
    );

    return this.#answerFor(applied, "accepted");
  }

  /**
   * This merchant's orders, or with `open` only the ones a restarted worker
   * should walk. That list is narrower than the store's open flag: an unpaid
   * quote is not work the merchant owes, and listing it would have a restart
   * deliver goods for a purchase that never happened.
   */
  async orders(merchantId: string, open: boolean | undefined): Promise<readonly StoredOrder[]> {
    const records = await this.runtime.store.orders(
      merchantId,
      open === undefined ? undefined : { open },
    );
    if (open !== true) {
      return records;
    }
    return records.filter((record) => onTheMerchantsOpenList(record.order));
  }

  // --- the parts the flows above lean on ------------------------------------

  /**
   * Puts the price question to the merchant and waits out our own patience for
   * it; whatever comes back, silence included, reaches the machine as an event.
   */
  async #askThePrice(record: StoredOrder, stored: StoredCard, priceId: string): Promise<void> {
    const { queue, ids, clock, config } = this.runtime;
    const orderId = record.order.id;
    const askedAt = clock();

    // Registered and parked before the question goes out: a worker on a poll
    // is woken by the publish, and a fast answer would otherwise find nobody
    // listening and be thrown away.
    this.#questions.set(priceId, { orderId, merchantId: record.merchantId });
    const parked = this.quotes.wait(priceId, config.deadlines.quoteResponseMs);

    const question: WorkerEnvelope = {
      kind: "quote_request",
      id: ids("env"),
      sent_at: asTimestamp(askedAt),
      payload: {
        merchant_item_id: stored.card.merchant_item_id,
        params: { ...record.params },
        // Where a parcel goes, as a place and nothing about who: this question
        // reaches the merchant for purchases that are never made, and a
        // shipping rate needs the place alone.
        ...(record.shipTo === undefined || "erasedAt" in record.shipTo
          ? {}
          : { ship_to: localityOf(record.shipTo) }),
        price_id: priceId,
        purpose: "purchase",
        // Until when the named price will be honoured, which is what the
        // merchant holds stock against, not how long we wait for the answer.
        // The price's life starts when the answer lands, so this is an upper
        // bound: a later answer is refused, and erring long only holds stock a
        // little longer, while erring short oversells.
        expires_at: asTimestamp(
          askedAt + config.deadlines.quoteResponseMs + config.deadlines.quoteTtlMs,
        ),
      },
    };

    if (record.shipTo === undefined) {
      await queue.publish(record.merchantId, question);
    } else {
      // A parcel's question carries its place, so it is written under the hold
      // on the order: a slow stream could otherwise land it after the order
      // ended and its address was erased.
      await this.runner.sendWhileTheAddressIsHeld(orderId, () => question);
    }

    const answered = await parked;
    this.#questions.delete(priceId);

    if (answered === null) {
      // Nobody named a price; the machine decides by mode whether the card's
      // own price sells.
      await this.runner.apply(orderId, { kind: "quote_silent", at: clock() });
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
   * Leaves a reminder that this delivery has gone unanswered, but never one
   * that would land after the order's own deadline has closed it.
   */
  async #remindMeIfNobodyAnswers(record: StoredOrder, handOver: string, at: number): Promise<void> {
    const { config, queue } = this.runtime;
    const deadline = fulfillmentDeadline(record.order)[0];
    const untilDeadline = deadline === undefined ? Number.POSITIVE_INFINITY : deadline.at - at;
    const wait = Math.min(config.deadlines.handlerAnswerMs, untilDeadline);

    if (wait <= 0) {
      return;
    }
    await queue.remind({ kind: "delivery_unanswered", orderId: record.order.id, handOver }, wait);
  }

  async #wherePurchaseStands(orderId: string): Promise<PurchaseAttempt> {
    const record = await this.runtime.store.orderById(orderId);
    if (record === null) {
      return { step: "no_such_item" };
    }

    if (outcomeFor(record.order) !== "in_progress") {
      return { step: "settled", order: record, delivery: record.delivery };
    }

    // Priced and unpaid is the agent's move; everything else in progress is
    // ours or the merchant's to finish.
    const waitingToBePaid = record.order.price !== null && record.order.payment === "none";
    return waitingToBePaid ? { step: "pay", order: record } : { step: "under_way", order: record };
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

/** What an agent whose payment was refused does next, by why it was refused. */
const NEXT_STEP_AFTER: Readonly<Record<PaymentVerificationFailure, string>> = {
  price_stale:
    "the offer it was made against no longer stands — the price moved, or the seller changed where they are paid — so start a new purchase for a fresh price and pay against that",
  insufficient_funds: "fund the paying wallet and pay this order again while its price holds",
  signature: "sign a new payment for this order and present it while its price holds",
};

/**
 * The endings in which nothing was taken and nothing is held, so a payment
 * has nothing left to buy. `expired` is one only without held goods, and is
 * asked separately.
 */
const NOTHING_TO_PAY_FOR: readonly OrderState[] = ["failed", "rejected", "declined", "cancelled"];

/**
 * Why the machine would not take a merchant's call. Only a closed order gets
 * `order_already_closed`, because merchants branch on that code; every other
 * refusal carries the machine's own code, which the contract's open set of
 * codes allows, together with the state the order was in.
 */
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
 * One stored card as its own merchant reads it. `selling` is what a purchase
 * would meet, the same word the order machine is given; `paused` is the card's
 * own flag, so the merchant still sees which cards they paused themselves
 * while all selling is stopped.
 */
function merchantCardOf(stored: StoredCard, theirs: HowTheySell): MerchantCard {
  return {
    id: stored.id,
    as_of: asTimestamp(stored.asOf),
    card: stored.card,
    selling: sellingFor(theirs.selling, stored, theirs.sellable, theirs.integration),
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
 * Whether two addresses are the same address: the same fields with the same
 * words, whatever order they were written in.
 */
function sameAddress(one: ShipTo, other: ShipTo): boolean {
  return canonical(one) === canonical(other);
}

/**
 * Whether a shipment sent now is the one already recorded: what the merchant
 * said, field for field, whatever order it was written in, and setting aside
 * the instant the gateway stamped on the recorded one.
 */
function sameShipment(recorded: Delivery, sent: Delivery): boolean {
  const { shipped_at: _stamped, ...said } = recorded;
  const { shipped_at: _echoed, ...saying } = sent;
  return canonical(said) === canonical(saying);
}

/** A document as one string, its keys sorted at every depth, so order says nothing. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );
}

/**
 * A card in a mode this channel does not sell yet, refused as a finding at
 * publication rather than discovered by the first buyer. A parcel sells only
 * on the test channel: on the live one a lost parcel would take real money
 * with no way yet to record its refund.
 */
function notOnThisChannel(card: Card, environment: Environment): Problem[] {
  return card.fulfillment === "ship" && environment === "live"
    ? [
        {
          path: ["fulfillment"],
          code: "not_sold_yet",
          message:
            'a parcel\'s card, fulfillment "ship", is not sold on the live channel yet: the refund of a lost parcel cannot be recorded anywhere yet, so publish it on the test channel, where the money is not real',
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
  no_seller_site: "no site for their shop, which a parcel's card needs",
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
      "this merchant has not set the site of their shop, and a parcel's card is published only" +
      " with one: a parcel that does not arrive is a question its buyer takes to the seller, and" +
      " the site is where this system sends them; set it with POST /v0/seller-name and publish" +
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

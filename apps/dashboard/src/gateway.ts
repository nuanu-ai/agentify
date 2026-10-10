/**
 * How the dashboard reaches the money path: by calling the gateway's
 * application inside the process the two share, as the merchant on the
 * signed-in account's row (ADR-0030).
 *
 * The port below is what the screens, the registration and the WooCommerce
 * worker are written against, and its answers are the contract's documents. A
 * refusal comes back as the sentence and the status the route at the door
 * answers the same refusal with, worded once in the gateway's
 * `merchant-answers.ts`, so a merchant reads on a page what their engineer
 * reads from the API. A body the request schema refuses is one exception in
 * wording: same code and status, and the schema's own problems as the
 * sentence, where the door's sentence points at a list a page does not show.
 * A wallet change is the other: no route at the door makes one, so its
 * refusals are worded here, for the one screen that asks.
 *
 * What goes in is held to the request schema the contract's route table names
 * for the same call, and what comes back to the response schema, before
 * anything is drawn. Two calls have no route at the door: registering, which
 * answers a merchant's identifier and nothing to hold, and setting the wallet,
 * whose address is held to the contract's address rule and whose answer to the
 * document the wallet is read in. The door holds both on the API, and a page drawn from a
 * document the contract would not recognise is a page that cannot be trusted;
 * failing here is how that is found rather than as a blank cell in front of a
 * merchant. So the dashboard still proves that the application and the
 * contract's documents are enough to draw every screen. That the HTTP API is
 * enough is proven by what a merchant's engineer uses: the SDK's tests, the
 * purchase through the real gateway in `packages/slice`, and the gateway's own
 * test of every route.
 */

import type { Caller, Gateway, WalletChangeRefusal } from "@agentify/gateway";
import {
  bodyRefused,
  CONFLICT,
  hold,
  merchantDeparted,
  merchantOrderAnswer,
  merchantOrderList,
  NO_SUCH_ITEM,
  NO_SUCH_KEY,
  NO_SUCH_ORDER,
  type Refused,
} from "@agentify/gateway";
import {
  API_ROUTES,
  type CardInput,
  type Delivery,
  EvmAddressSchema,
  type HandlerAnswer,
  type IssuedKey,
  type MerchantCard,
  type MerchantCardList,
  type MerchantKey,
  MerchantKeySchema,
  type OrderCallResponse,
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
import { z } from "zod";

/** What a call came to, in the two shapes a page has to draw differently. */
export type Answer<T> =
  | { readonly ok: true; readonly document: T }
  /**
   * The call did not produce a document. `status` is the one the route at the
   * door answers the same refusal with, or 0 where nothing answered within the
   * deadline — which is a different thing from a refusal, and a page that
   * folded the two would tell a merchant their catalog is empty when the truth
   * is that nothing answered.
   */
  | {
      readonly ok: false;
      readonly status: number;
      readonly why: string;
      /**
       * The code of the refusal, where there was one. Read for the refusals a
       * screen words for itself; everything else shows `why`.
       */
      readonly code?: string;
    };

export interface GatewayClient {
  cards(): Promise<Answer<MerchantCardList>>;
  pauseCard(itemId: string, paused: boolean): Promise<Answer<MerchantCard>>;
  setSelling(selling: boolean): Promise<Answer<MerchantCardList>>;
  orders(open: boolean): Promise<Answer<OrderList>>;
  receipts(): Promise<Answer<ReceiptList>>;
  /**
   * The keys the merchant issued for their own code. Every one can be
   * disabled from here: a session holds no key, so none of them is the one
   * this call was made with.
   */
  keys(): Promise<Answer<readonly MerchantKey[]>>;
  issueKey(label: string): Promise<Answer<IssuedKey>>;
  disableKey(keyId: string): Promise<Answer<MerchantKey>>;
  /** The name buyers read beside this merchant's products, or null for none. */
  sellerName(): Promise<Answer<string | null>>;
  /** Whether the operator has approved this merchant for live sales. */
  liveApproval(): Promise<Answer<boolean>>;
  setSellerName(name: string): Promise<Answer<string | null>>;
  /**
   * The name and the shop's site together, as one read, for the screen that
   * draws both (ADR-0034). Either is null where none was given.
   */
  seller(): Promise<Answer<{ readonly name: string | null; readonly site: string | null }>>;
  /** Gives or changes the shop's site, leaving the name as it was. */
  setSellerSite(site: string): Promise<Answer<string | null>>;
  /** Where this merchant's money arrives now, and any change of it that waits. */
  payoutWallet(): Promise<Answer<PayoutWallet>>;
  /**
   * Sets the address, or asks for a change of it to wait (ADR-0019), as the
   * signed-in account. The one way a wallet is set: no route at the door does.
   */
  setPayoutWallet(address: string): Promise<Answer<PayoutWallet>>;
  /**
   * Publishes one card, and hands back what was said about it — including its
   * refusal, which is the answer the caller most needs.
   *
   * It is the one call here whose failure is a document rather than a
   * sentence. A refused publish carries a list of findings, one per thing
   * standing between this card and the catalogue, and that list is what a
   * merchant importing a catalogue reads. Folded into a sentence it would be
   * one line saying a card was refused, with the reasons in a log nobody can
   * see.
   */
  publishCard(card: CardInput): Promise<Answer<PublishResult>>;
  /**
   * Draws what is next on this merchant's stream: one envelope, or none when
   * the wait ran out.
   *
   * The dashboard is not ordinarily a worker, and this exists for the one thing
   * that makes it one: a merchant whose catalogue came from a WooCommerce shop
   * has no code of their own to fill orders with, so their orders are filled
   * here, from the shop. Every other screen in the dashboard draws and does not
   * wait.
   */
  pollWorker(waitSeconds: number): Promise<Answer<WorkerPollResponse>>;
  /** What the handler returned for one order: the goods, or a refusal. */
  answerOrder(orderId: string, answer: HandlerAnswer): Promise<Answer<OrderCallResponse>>;
  /** Reads one exact order before an operator closes its delivery debt. */
  getOrder(orderId: string): Promise<Answer<OrderWithStatus>>;
  /** Idempotently supplies late goods for one exact asynchronous order. */
  deliverOrder(orderId: string, delivery: Delivery): Promise<Answer<OrderCallResponse>>;
  /** Answers one live Woo price and availability question. */
  answerQuote(priceId: string, answer: QuoteResponse): Promise<Answer<QuoteAnswerAck>>;
}

/**
 * How a merchant is made, which is the one call the dashboard makes for
 * somebody who is not a merchant yet.
 *
 * Separate from the client above rather than a method on it, because every
 * other call is made as some merchant, and a `register` on a client bound to
 * one would be a method whose merchant is ignored.
 */
export interface Registrar {
  /** The new merchant's identifier, which the account is then written onto. */
  register(): Promise<Answer<string>>;
}

/**
 * The account a client acts for: the merchant on its row, and its address,
 * which is what the gateway names when a session of this account changes the
 * wallet or issues a key (ADR-0019). The WooCommerce worker acts for the
 * account that connected the shop, and makes neither call.
 */
export interface Acting {
  readonly merchantId: string;
  readonly email: string;
}

/**
 * How long a page waits on one call before giving up on it.
 *
 * A number here rather than in the configuration on purpose: this is not the
 * kind of waiting the order machine takes from an environment, where the value
 * is policy somebody decides. It is a guard on a page, and its only job is to
 * be shorter than a person's patience with a page that has stopped. The work
 * behind a call that runs out is not cancelled — a database that answers late
 * still writes — which is why the page says it may have been done.
 *
 * It is an argument with this as its default so that the promise can be tested
 * against a call that never finishes without the suite waiting ten seconds to
 * find out. Nothing in the dashboard passes it.
 */
const ANSWER_WITHIN_MS = 10_000;

/**
 * What a call that ran out of time comes to. The work behind it goes on, so
 * the sentence says it may have been done.
 */
const lateAnswer = (answerWithinMs: number): Answer<never> => {
  const seconds = Math.max(1, Math.round(answerWithinMs / 1_000));
  return {
    ok: false,
    status: 0,
    why:
      `Agentify did not answer within ${seconds === 1 ? "a second" : `${seconds} seconds`}, so` +
      " what was asked may or may not have been done; reload the page to see where it stands",
  };
};

/** A refusal worded in the gateway, as a page draws it. */
const refusedAs = (refused: Refused): Answer<never> => ({
  ok: false,
  status: refused.status,
  why: refused.message,
  code: refused.code,
});

const done = <T>(document: T): Answer<T> => ({ ok: true, document });

/**
 * The status a wallet change is refused under when the telling behind it did
 * not do its part: a dependency of the call rather than the call itself, and
 * nothing was recorded.
 */
const UNAVAILABLE = 503;

/**
 * What a wallet change the gateway would not record comes to, on the one screen
 * that asks for one.
 *
 * In every case nothing was written: the address paid now and whatever change
 * was already waiting are as they were (ADR-0019). The four ask different
 * things of whoever reads them. A message that could not be confirmed as sent
 * to every account may still have reached some, whether the provider refused
 * one, the telling failed part of the way or it did not finish in time, and the
 * words say so without naming a cause the gateway cannot know. The race comes
 * in two wordings, because the words say what may have reached a mailbox: a
 * change raced after its message went out has a message in an inbox, where one
 * raced before anything was announced has none. A merchant who has read a
 * message about a change must not be told nothing was sent, and one who has
 * none must not be sent looking for it.
 *
 * The statuses are the ones a page tells a refusal from a call nobody answered
 * by; there is no code, because no screen reads one and nothing outside this
 * process meets these.
 */
const walletRefusedAs = (why: WalletChangeRefusal): Answer<never> => {
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
        why: "the message about this change could not be confirmed as sent to every account that names this merchant, so nothing was recorded and sales are paid where they were; an account may still have received it, and it says the change takes effect only if the dashboard's wallet screen shows it, which it does not",
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
        why: "another change of this merchant's payout wallet was recorded while this one was being announced, so this one was not recorded; its message went out and says the change takes effect only if the dashboard's wallet screen shows it, which it does not. Read the wallet and ask again if this is still the address wanted",
      };
    default: {
      const unanswered: never = why;
      throw new Error(`there are no words for the wallet refusal ${String(unanswered)}`);
    }
  }
};

/**
 * One call, within the deadline.
 *
 * A throw is not turned into an answer. It is our own code failing — a
 * database that did not answer, or a document the contract would not
 * recognise — and it may have failed after what was asked was done, so a page
 * must not say that nothing was. It goes on to the page's own handler, which
 * says something in the dashboard is broken and writes the rest to the log.
 * One that comes after the page stopped waiting has nobody to go to, and is
 * written to the log here.
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
 * What a call sends, held to the request schema its route names: the value
 * the schema reads, or the refusal the door gives a body that is not the
 * document the call takes, worded by the schema's own problems.
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

/** What came back, held to the response schema its route names. */
const answered = <T>(route: RouteDefinition, document: T): Answer<T> =>
  done(route.response.document.parse(document) as T);

/**
 * An order call's answer: the document where the machine honoured it, and its
 * error, in the words and the status the route gives it, where it did not.
 */
const orderCallAnswer = (
  route: RouteDefinition,
  response: OrderCallResponse | null,
): Answer<OrderCallResponse> => {
  if (response === null) {
    return refusedAs(NO_SUCH_ORDER);
  }
  const held = route.response.document.parse(response) as OrderCallResponse;
  return held.ok
    ? done(held)
    : { ok: false, status: CONFLICT, why: held.error.message, code: held.error.code };
};

const KeysSchema = z.array(MerchantKeySchema);

/**
 * The client of one account, built per request from the signed-in person, so
 * two people signed into one dashboard are two merchants.
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
          merchantOrderList(await application.orders(merchantId, open ? true : undefined)),
        ),
      ),
    receipts: () =>
      call("reading the receipts", async () =>
        answered(API_ROUTES.list_receipts, await application.receipts(merchantId)),
      ),
    keys: () =>
      call("reading the keys", async () =>
        done(KeysSchema.parse(await application.merchantKeys(merchantId))),
      ),
    issueKey: (label) =>
      call("issuing a key", async () => {
        const asked = sent(API_ROUTES.issue_key, { label });
        if (!asked.ok) return asked.refused;
        return answered(
          API_ROUTES.issue_key,
          await application.issueMerchantKey(merchantId, asked.value.label, caller),
        );
      }),
    disableKey: (keyId) =>
      call("disabling a key", async () => {
        const disabled = await application.disableMerchantKey(merchantId, keyId, caller);
        if (disabled === "locked_out") {
          throw new Error("a session holds no key, and disabling was refused as its own");
        }
        if (disabled === null) return refusedAs(NO_SUCH_KEY);
        // Unwrapped here rather than at the screen. The contract wraps the key
        // so that the answer can grow a field beside it without changing shape
        // under every reader; what the one screen that draws it needs is the
        // key.
        const held = answered(API_ROUTES.disable_key, disabled);
        return held.ok ? done(held.document.key) : held;
      }),
    // Unwrapped for the same reason: a screen that reaches through the wrapper
    // is a screen to edit the day it grows. Null is a real answer and not an
    // absence — it is the merchant who has not chosen a name yet, which is the
    // whole state these screens exist to get somebody out of.
    liveApproval: () =>
      call("reading the live approval", async () =>
        done(await application.liveApproved(merchantId)),
      ),
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
    // The whole document rather than the address alone: the screen that draws
    // the address has to draw a change waiting beside it (ADR-0019) — a
    // merchant shown only the address paid now, after asking for another,
    // would take a waiting change for one that did not happen.
    payoutWallet: () =>
      call("reading the payout wallet", async () =>
        answered(API_ROUTES.get_payout_wallet, await application.payoutWallet(merchantId)),
      ),
    // What goes in is held to the address rule the contract publishes, and
    // what comes back to the document the wallet is read in.
    setPayoutWallet: (address) =>
      call("setting the payout wallet", async () => {
        const asked = hold(EvmAddressSchema, address);
        if (!asked.ok) return refusedAs(bodyRefused(asked.problems));
        const set = await application.setPayoutWallet(merchantId, asked.value as string, session);
        return typeof set === "string"
          ? walletRefusedAs(set)
          : answered(API_ROUTES.get_payout_wallet, set);
      }),
    // A refused card is the answer and not the absence of one: the flow
    // checks the card itself and answers with its findings, as it does at the
    // door, so there is no request schema to hold it to first.
    publishCard: (card) =>
      call("publishing a card", async () =>
        answered(API_ROUTES.publish_card, await application.publishCard(merchantId, card)),
      ),
    pollWorker: (waitSeconds) =>
      call("drawing the stream", async () => {
        const asked = sent(API_ROUTES.poll_worker, { wait_seconds: waitSeconds });
        if (!asked.ok) return asked.refused;
        return answered(
          API_ROUTES.poll_worker,
          await application.poll(merchantId, (asked.value.wait_seconds ?? waitSeconds) * 1_000),
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

/**
 * Registration, inside the process: a merchant for a signed-in person who
 * pressed for one (ADR-0026 §4), answered with its identifier.
 */
export const registrarFor = (
  application: Gateway,
  answerWithinMs: number = ANSWER_WITHIN_MS,
): Registrar => ({
  register: () =>
    within("registering a merchant", answerWithinMs, async () =>
      done(await application.registerMerchant()),
    ),
});

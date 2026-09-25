/**
 * How the cabinet talks to the gateway: over the public API, with a merchant's
 * key, holding no database of its own (ADR-0005 §3).
 *
 * Every address and every document comes out of the contract's route table
 * rather than being written here. That is the same rule the gateway and the
 * SDK already follow, and the cabinet is the third reader of that table — a
 * third transcription of the surface is a third chance for the addresses to
 * come apart. It is also the dogfooding the decision asks for: a screen the
 * cabinet cannot draw is API the merchant does not have either.
 *
 * Answers are held to the schema the table names before anything is rendered.
 * A gateway that sent a document the contract would not recognise is a gateway
 * we cannot draw a truthful page from, and failing here is how that is found
 * rather than as a blank cell in front of a merchant.
 */

import {
  API_ROUTES,
  CabinetKeySchema,
  type CardInput,
  type Delivery,
  DisabledKeySchema,
  expandPath,
  type ForgottenCabinetKey,
  ForgottenCabinetKeySchema,
  type HandlerAnswer,
  type IssuedKey,
  IssuedKeySchema,
  MERCHANT_KEY_HEADER,
  type MerchantCard,
  type MerchantCardList,
  MerchantCardListSchema,
  MerchantCardSchema,
  type MerchantKey,
  type MerchantKeyList,
  MerchantKeyListSchema,
  merchantKeyHeaderValue,
  type OrderCallResponse,
  OrderCallResponseSchema,
  type OrderList,
  OrderListSchema,
  type OrderWithStatus,
  OrderWithStatusSchema,
  type PayoutWallet,
  PayoutWalletSchema,
  type PublishResult,
  PublishResultSchema,
  type QuoteAnswerAck,
  QuoteAnswerAckSchema,
  type QuoteResponse,
  type ReceiptList,
  ReceiptListSchema,
  type RegisteredMerchant,
  RegisteredMerchantSchema,
  SellerNameSchema,
  type WorkerPollResponse,
  WorkerPollResponseSchema,
} from "@nuanu-ai/agentify-contracts";
/** What a call came to, in the two shapes a page has to draw differently. */
export type Answer<T> =
  | { readonly ok: true; readonly document: T }
  /**
   * The call did not produce a document. `status` is the gateway's, or 0 where
   * the gateway could not be reached at all — which is a different thing from
   * a gateway that answered, and a page that folded the two would tell a
   * merchant their catalog is empty when the truth is that nothing answered.
   */
  | { readonly ok: false; readonly status: number; readonly why: string };

export interface GatewayClient {
  cards(): Promise<Answer<MerchantCardList>>;
  pauseCard(itemId: string, paused: boolean): Promise<Answer<MerchantCard>>;
  setSelling(selling: boolean): Promise<Answer<MerchantCardList>>;
  orders(open: boolean): Promise<Answer<OrderList>>;
  receipts(): Promise<Answer<ReceiptList>>;
  keys(): Promise<Answer<MerchantKeyList>>;
  issueKey(label: string): Promise<Answer<IssuedKey>>;
  disableKey(keyId: string): Promise<Answer<MerchantKey>>;
  /**
   * Another key of the kind this cabinet signs in with, readable once.
   *
   * Made with the key already on the account row, because the gateway answers
   * this to no other kind — and the pair of it below is what makes a stolen
   * copy of this cabinet's database a set of keys that stops working.
   */
  issueCabinetKey(): Promise<Answer<string>>;
  /**
   * Puts the key this client is holding beyond use, and nothing else.
   *
   * The route takes no parameters and reaches no other key, so which key goes
   * is decided by which key the call is made with — and a client is built per
   * key. What that buys is that this cannot take away a credential somebody
   * else wrote down after this client was built. It is made once a key has
   * stopped being the one an account signs in with, never before: a row left
   * naming a key this removed is somebody locked out.
   */
  forgetCabinetKey(): Promise<Answer<ForgottenCabinetKey>>;
  /** The name buyers read beside this merchant's products, or null for none. */
  sellerName(): Promise<Answer<string | null>>;
  setSellerName(name: string): Promise<Answer<string | null>>;
  /** Where this merchant's money arrives now, and any change of it that waits. */
  payoutWallet(): Promise<Answer<PayoutWallet>>;
  setPayoutWallet(address: string): Promise<Answer<PayoutWallet>>;
  /**
   * Publishes one card, and hands back what the door said about it — including
   * its refusal, which is the answer the caller most needs.
   *
   * It is the one call on this client whose failure is a document rather than a
   * status, and it has its own shape for that reason. Every other call here
   * turns a refusal into a sentence for a page; a refused publish carries a list
   * of findings, one per thing standing between this card and the catalogue, and
   * that list is what a merchant importing a catalogue reads. Folded into a
   * sentence it would be one line saying a card was refused, with the reasons in
   * a log nobody can see.
   */
  publishCard(card: CardInput): Promise<Answer<PublishResult>>;
  /**
   * Draws the next batch off this merchant's stream.
   *
   * The cabinet is not ordinarily a worker, and this exists for the one thing
   * that makes it one: a merchant whose catalogue came from a WooCommerce shop
   * has no code of their own to fill orders with, so their orders are filled
   * here, from the shop. Every other screen in the cabinet draws and does not
   * wait.
   */
  pollWorker(waitSeconds: number, max: number): Promise<Answer<WorkerPollResponse>>;
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
 * The one call the cabinet makes with no key at all.
 *
 * Separate from the client above rather than a method on it, because it is a
 * different thing: every other call is made as some merchant, and this one is
 * made by somebody who is not a merchant yet. A `register` sitting on a client
 * bound to a key would be a method whose key is ignored, which is the kind of
 * shape somebody later reads as an accident.
 */
export interface Registrar {
  register(invitation: string): Promise<Answer<RegisteredMerchant>>;
}

/**
 * How long the cabinet waits for the gateway before giving up on one call.
 *
 * A number here rather than in the configuration on purpose: this is not the
 * kind of waiting the order machine takes from an environment, where the value
 * is policy somebody decides. It is a guard on a client, and its only job is to
 * be shorter than a person's patience with a page that has stopped.
 *
 * It is an argument with this as its default so that the promise can be tested
 * against a server that never answers without the suite waiting ten seconds to
 * find out. Nothing in the cabinet passes it.
 */
const ANSWER_WITHIN_MS = 10_000;

/** What one call needs beyond its route and the shape of its answer. */
interface Sending {
  /** The values for a path that names parameters, such as `:key_id`. */
  readonly values?: Readonly<Record<string, string>>;
  readonly query?: string;
  /** A document to send, for the routes that take one. */
  readonly body?: unknown;
}

/**
 * One caller, bound to a key or to nothing at all.
 *
 * A null key means no key header on the request, which is registration and
 * nothing else. It is spelled as an absence rather than as an empty string
 * because the gateway would read an empty bearer token as a key it does not
 * know, and a 401 is a worse answer than the one a keyless route gives.
 */
const caller =
  (baseUrl: string, key: string | null, answerWithinMs: number) =>
  async <T>(
    route: { readonly method: string; readonly path: string },
    schema: { parse: (value: unknown) => T },
    sending: Sending = {},
  ): Promise<Answer<T>> => {
    const url = `${baseUrl}${expandPath(route.path, sending.values ?? {})}${sending.query ?? ""}`;

    let answered: Response;
    try {
      answered = await fetch(url, {
        method: route.method,
        headers: {
          ...(key === null ? {} : { [MERCHANT_KEY_HEADER]: merchantKeyHeaderValue(key) }),
          ...(sending.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(sending.body === undefined ? {} : { body: JSON.stringify(sending.body) }),
        signal: AbortSignal.timeout(answerWithinMs),
      });
    } catch (thrown) {
      // Nothing answered. Said as its own thing, because "the gateway is not
      // there" and "the gateway says you have nothing" are different news and
      // only one of them means the merchant should do something.
      //
      // And a third: a connection that was accepted and then went quiet. It
      // reaches here only because of the deadline above — without one this call
      // never returns, and the page a merchant is holding is sometimes the one
      // that stops their selling.
      const late = thrown instanceof Error && thrown.name === "TimeoutError";
      const why = late ? "the gateway did not answer in time" : "the gateway could not be reached";
      console.error(`[cabinet] ${why}`, thrown);
      return { ok: false, status: 0, why };
    }

    if (!answered.ok) {
      return { ok: false, status: answered.status, why: await reasonIn(answered) };
    }

    const document = schema.parse(await answered.json());
    return { ok: true, document };
  };

/**
 * A client bound to one merchant's key.
 *
 * The key is a parameter rather than something this module reads, and the
 * cabinet builds one of these per request from the key on the row of whoever is
 * signed in (ADR-0014 §2). Two people signed into one cabinet are therefore two
 * merchants, which is what a client held for the life of the process could
 * never be.
 */
export const gatewayFor = (
  baseUrl: string,
  key: string,
  answerWithinMs: number = ANSWER_WITHIN_MS,
): GatewayClient => {
  const call = caller(baseUrl, key, answerWithinMs);

  return {
    cards: () => call(API_ROUTES.list_merchant_cards, MerchantCardListSchema),
    pauseCard: (itemId, paused) =>
      call(paused ? API_ROUTES.pause_card : API_ROUTES.resume_card, MerchantCardSchema, {
        values: { item_id: itemId },
      }),
    setSelling: (selling) =>
      call(selling ? API_ROUTES.resume_selling : API_ROUTES.pause_selling, MerchantCardListSchema),
    orders: (open) =>
      call(API_ROUTES.list_orders, OrderListSchema, { query: open ? "?open=true" : "" }),
    receipts: () => call(API_ROUTES.list_receipts, ReceiptListSchema),
    keys: () => call(API_ROUTES.list_keys, MerchantKeyListSchema),
    issueKey: (label) => call(API_ROUTES.issue_key, IssuedKeySchema, { body: { label } }),
    disableKey: async (keyId) => {
      // Unwrapped here rather than at the screen. The contract wraps the key in
      // an object so that the answer can grow a field beside it without
      // changing shape under every reader; what the one screen that draws it
      // needs is the key, and a page reaching through a wrapper is a page that
      // has to be edited the day the wrapper grows.
      const answered = await call(API_ROUTES.disable_key, DisabledKeySchema, {
        values: { key_id: keyId },
      });
      return answered.ok ? { ok: true, document: answered.document.key } : answered;
    },
    // Unwrapped like the key above, and for a second reason as well: what the
    // caller does with this is write it onto a row, and a row written from
    // `document.secret` is a row to edit the day the answer grows a field.
    issueCabinetKey: async () => {
      const answered = await call(API_ROUTES.issue_cabinet_key, CabinetKeySchema);
      return answered.ok ? { ok: true, document: answered.document.secret } : answered;
    },
    // Not unwrapped, unlike the answers above: the document says the one thing
    // this call has to say, and there is no field under it a screen wants.
    forgetCabinetKey: () => call(API_ROUTES.forget_cabinet_key, ForgottenCabinetKeySchema),
    // Unwrapped here for the same reason the key above is: the contract carries
    // the name inside an object so the answer can grow a field beside it, and a
    // screen that reaches through the wrapper is a screen to edit the day it
    // grows. Null is a real answer and not an absence — it is the merchant who
    // has not chosen a name yet, which is the whole state these screens exist
    // to get somebody out of.
    sellerName: async () => {
      const answered = await call(API_ROUTES.get_seller_name, SellerNameSchema);
      return answered.ok ? { ok: true, document: answered.document.seller_name } : answered;
    },
    setSellerName: async (name) => {
      const answered = await call(API_ROUTES.set_seller_name, SellerNameSchema, {
        body: { seller_name: name },
      });
      return answered.ok ? { ok: true, document: answered.document.seller_name } : answered;
    },
    // The whole document rather than the address alone, unlike the name above:
    // the answer grew the field it was wrapped for, and the screen that draws
    // the address has to draw a change waiting beside it (ADR-0019) — a
    // merchant shown only the address paid now, after asking for another,
    // would take a waiting change for one that did not happen.
    payoutWallet: () => call(API_ROUTES.get_payout_wallet, PayoutWalletSchema),
    setPayoutWallet: (address) =>
      call(API_ROUTES.set_payout_wallet, PayoutWalletSchema, {
        body: { payout_wallet: address },
      }),
    publishCard: (card) =>
      // A refused card is the answer and not the absence of one, so this is the
      // one route read through `answering` rather than through `call`.
      answering(baseUrl, key, answerWithinMs, API_ROUTES.publish_card, PublishResultSchema, card),
    pollWorker: (waitSeconds, max) =>
      call(API_ROUTES.poll_worker, WorkerPollResponseSchema, {
        body: { wait_seconds: waitSeconds, max },
      }),
    answerOrder: (orderId, answer) =>
      call(API_ROUTES.answer_order, OrderCallResponseSchema, {
        values: { order_id: orderId },
        body: answer,
      }),
    getOrder: (orderId) =>
      call(API_ROUTES.get_order, OrderWithStatusSchema, {
        values: { order_id: orderId },
      }),
    deliverOrder: (orderId, delivery) =>
      call(API_ROUTES.deliver_order, OrderCallResponseSchema, {
        values: { order_id: orderId },
        body: delivery,
      }),
    answerQuote: (priceId, answer) =>
      call(API_ROUTES.answer_quote, QuoteAnswerAckSchema, {
        values: { price_id: priceId },
        body: answer,
      }),
  };
};

/**
 * One call whose refusal is a document of its own.
 *
 * The publish is the only one. Its answer says `ok: false` and carries the
 * findings, and the gateway sends it under a status that says the document was
 * not accepted — so a caller that read the status first and stopped would throw
 * away the only thing the merchant can act on. What is still a failure here is a
 * gateway that did not answer, or one that answered something this schema does
 * not recognise, and those come back as they do everywhere else.
 */
const answering = async <T>(
  baseUrl: string,
  key: string,
  answerWithinMs: number,
  route: { readonly method: string; readonly path: string },
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  body: unknown,
): Promise<Answer<T>> => {
  let answered: Response;
  try {
    answered = await fetch(`${baseUrl}${route.path}`, {
      method: route.method,
      headers: {
        [MERCHANT_KEY_HEADER]: merchantKeyHeaderValue(key),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(answerWithinMs),
    });
  } catch (thrown) {
    const late = thrown instanceof Error && thrown.name === "TimeoutError";
    const why = late ? "the gateway did not answer in time" : "the gateway could not be reached";
    console.error(`[cabinet] ${why}`, thrown);
    return { ok: false, status: 0, why };
  }

  let document: unknown;
  try {
    document = await answered.json();
  } catch {
    return { ok: false, status: answered.status, why: `the gateway answered ${answered.status}` };
  }

  const read = schema.safeParse(document);
  if (!read.success || read.data === undefined) {
    // Not this route's own answer. A proxy's page, a 401 from the door, a
    // gateway speaking a dialect this cabinet does not: all of them arrive here,
    // and none of them is a refused card.
    return { ok: false, status: answered.status, why: reasonWritten(document, answered.status) };
  }
  return { ok: true, document: read.data };
};

/**
 * A caller with no key, which can do exactly one thing.
 *
 * The invitation is the existing process secret shared with the gateway. It is
 * read from cabinet configuration and never accepted from a person. The
 * gateway remains the only component that decides whether the exact value is
 * accepted.
 */
export const registrarFor = (
  baseUrl: string,
  answerWithinMs: number = ANSWER_WITHIN_MS,
): Registrar => {
  const call = caller(baseUrl, null, answerWithinMs);
  return {
    register: (invitation) =>
      call(API_ROUTES.register_merchant, RegisteredMerchantSchema, { body: { invitation } }),
  };
};

/**
 * What the gateway said went wrong, where it said anything we can read.
 *
 * The shape is the contract's — every call on that surface refuses in one
 * envelope with a code and a sentence — and this still reads it by hand rather
 * than through the schema. What sits between this and the gateway is a proxy,
 * a load balancer or nothing at all, and any of them can answer with a page of
 * their own; a parse held to the envelope would turn that into no sentence,
 * where reaching for the field and finding none turns it into the status. The
 * fallback is the point: an error text is a claim like any other, and where
 * there is none to read this says the status instead of inventing one.
 */
const reasonIn = async (answered: Response): Promise<string> => {
  try {
    return reasonWritten(await answered.json(), answered.status);
  } catch {
    return `the gateway answered ${answered.status}`;
  }
};

/** The same, for a body somebody has already read off the response. */
const reasonWritten = (document: unknown, status: number): string => {
  const message = (document as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message !== "" ? message : `the gateway answered ${status}`;
};

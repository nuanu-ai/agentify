/**
 * Filling the orders of a merchant whose catalogue came from a WooCommerce
 * shop.
 *
 * A merchant who connected a shop wrote no code. Their products are on sale,
 * agents buy them, and something has to turn a paid order here into an order
 * there — so the cabinet stands in as their handler, drawing their own stream
 * with their own key and answering on the routes any merchant's worker would
 * use. Nothing about that is a private arrangement with the gateway: it is the
 * public merchant API, called the way ADR-0004 says a worker calls it, which is
 * the dogfooding ADR-0005 §3 asks for taken one step further than a screen.
 *
 * The hand-over itself is the gateway's queue-shaped effect and it is not
 * reimplemented here. An order reaches this because the envelope carrying it
 * was written into the same transaction as the state that implies it
 * (ADR-0013), and an order this leaves unanswered is handed over again by the
 * order machine, which is the one thing that knows how many attempts are left.
 * So the two answers below are the whole vocabulary: a delivery, a refusal, or
 * nothing at all — and nothing at all is the one that means "ask me again".
 *
 * The rule that shapes everything else in this file: **a merchant's shop is not
 * ours to write to twice.** A delivery is at least once, so the same sale can
 * arrive here more than once, and a second order in somebody's shop is a second
 * thing they pick, pack and post for one payment. The ledger in `woo-shops.ts`
 * is claimed before the shop is called and completed after, and the case it
 * exists for is the one in the middle: an attempt that reached the point of
 * calling and never learned the outcome. That one is refused rather than
 * retried, in words that say it is not knowable from here — which is the
 * difference between "there is no order" and "I do not know whether there is
 * one".
 */

import { createHash } from "node:crypto";
import type {
  HandlerAnswer,
  Order,
  QuoteRequest,
  QuoteResponse,
} from "@nuanu-ai/agentify-contracts";
import type { GatewayClient } from "./gateway.js";
import type { Identity } from "./identity.js";
import {
  createTheOrderInTheShop,
  inspectProductInTheShop,
  type OrderMade,
  type ShopKeys,
  type SoldItem,
} from "./woo-shop.js";
import type { WooConnection, WooShops } from "./woo-shops.js";

/** What filling one order needs beyond the order and the connection. */
export interface Filling {
  readonly shops: WooShops;
  readonly now: () => Date;
  /**
   * How the shop is reached, with the real call as the default.
   *
   * A parameter so that the decisions in this file can be read off a test
   * without a WooCommerce anywhere near it. A deployment passes nothing.
   */
  readonly placeOrder?: (keys: ShopKeys, sold: SoldItem) => Promise<OrderMade>;
  /** The one currently supported downloadable file, after authoritative checks. */
  readonly eligibleProduct?: (
    connection: WooConnection,
    merchantItemId: string,
  ) => Promise<{
    readonly productId: string;
    readonly downloadId: string;
    readonly fileName: string;
    readonly price?: { readonly amount: string; readonly currency: string };
  } | null>;
}

/**
 * What this merchant's handler answers for one order, or null for no answer at
 * all.
 *
 * Null is not a failure to decide. It is the answer that means the sale is
 * still live and the order should come round again — the shop did not answer,
 * so nothing about this sale has been settled and a refusal would close for
 * good something that a minute from now would go through.
 */
export const fillFromTheShop = async (
  order: Order,
  connection: WooConnection,
  orderEmail: string,
  parts: Filling,
): Promise<HandlerAnswer | null> => {
  const place = parts.placeOrder ?? createTheOrderInTheShop;
  const known = await parts.shops.knownOrder(order.id);
  if (known?.kind === "placed") return { delivered: known.result };
  if (known?.kind === "precreate_refused") {
    return {
      refused: {
        code: "cannot_fulfill",
        message:
          "This paid order was already refused before WooCommerce order creation. Reconnecting the shop does not create it again automatically.",
      },
    };
  }
  if (known?.kind === "unknown") {
    return unknownCreation(order.id, connection.shopUrl, known.attemptedAt);
  }
  const inspected =
    parts.eligibleProduct === undefined
      ? await inspectProductInTheShop(connection, order.merchant_item_id)
      : null;
  const eligible =
    inspected === null
      ? (await parts.eligibleProduct?.(connection, order.merchant_item_id)) ?? null
      : inspected.ok
        ? inspected.product
        : null;
  if (eligible === null) {
    await parts.shops.recordPrecreateRefusal(connection.accountId, order.id, parts.now());
    return {
      refused: {
        code: "cannot_fulfill",
        message:
          "This shop product is no longer a supported single-file download, so no WooCommerce order was created.",
      },
    };
  }
  if (eligible.price !== undefined &&
      (eligible.price.amount !== order.price.amount || eligible.price.currency !== order.price.currency)) {
    await parts.shops.recordPrecreateRefusal(connection.accountId, order.id, parts.now());
    return {
      refused: {
        code: "cannot_fulfill",
        message: "The shop's product or price changed after this purchase was quoted, so no WooCommerce order was created.",
      },
    };
  }

  if (connection.permissions !== "read_write") {
    // The shop granted less than we asked for, so every sale on this connection
    // ends here. The merchant is told which it is, in their own log and on
    // their own connection screen; the agent is told the fact and no more,
    // because who granted what to whom is the merchant's business and nothing
    // an agent could act on.
    console.error(
      `[cabinet] the shop at ${connection.shopUrl} granted ${JSON.stringify(connection.permissions)}` +
        " access, which cannot create an order, so every sale on it is refused",
    );
    await parts.shops.recordPrecreateRefusal(connection.accountId, order.id, parts.now());
    return {
      refused: {
        code: "cannot_fulfill",
        message:
          "The shop this product is sold from cannot take an order from us, so nothing was" +
          " delivered and the sale did not go through.",
      },
    };
  }

  const claim = await parts.shops.claimOrder(connection.accountId, order.id, parts.now());

  if (claim.kind === "placed") {
    // The same sale, handed over a second time. The shop already has the order
    // and the buyer gets the same number they would have got the first time.
    return { delivered: claim.result };
  }

  if (claim.kind === "precreate_refused") {
    return {
      refused: {
        code: "cannot_fulfill",
        message: "This paid order was already refused before WooCommerce order creation.",
      },
    };
  }

  if (claim.kind === "unknown") {
    return unknownCreation(order.id, connection.shopUrl, claim.attemptedAt);
  }

  const made = await place(connection, {
    orderId: order.id,
    productId: eligible.productId,
    // Not the buyer's, which is why the parameter is not called that. Creating
    // an order makes WooCommerce send mail to whatever is on it and nothing in
    // the request can stop that, so whose address belongs here is a product
    // question nobody has answered; until somebody does it is the merchant's
    // own, and ADR-0023 says so rather than this pretending it is settled.
    email: orderEmail,
    price: { amount: order.price.amount, currency: order.price.currency },
    download: { id: eligible.downloadId, name: eligible.fileName },
  });

  if (made.ok) {
    const result = {
      download_url: downloadUrlFor(connection.shopUrl, eligible.productId, made, orderEmail),
      file_name: eligible.fileName,
      order_number: made.number,
    };
    await parts.shops.recordOrder(
      order.id,
      { id: made.id, number: made.number, result },
      parts.now(),
    );
    return { delivered: result };
  }

  if (made.again) {
    // Nothing is answered and the claim stays: the request may have reached the
    // shop, so the next attempt has to meet "we do not know" rather than a
    // clean slate.
    console.error(`[cabinet] ${order.id} could not be placed in the shop: ${made.why}`);
    return null;
  }

  // The shop answered and said no, before anything of ours was written into it.
  // The claim goes, so the same sale tomorrow is a sale this merchant can make.
  await parts.shops.releaseOrder(order.id);
  // What the shop actually said goes to the merchant, in their own cabinet's
  // log, and not to the agent. A WordPress refusal carries whatever the plugin
  // that raised it chose to say, which on a shop with debugging on is a file
  // path — and the reader of the refusal below is a stranger's agent, which
  // can do nothing with a merchant's internals but forward them. What the
  // agent is told is the one thing it can act on: this merchant's shop refused
  // the sale, so try somewhere else.
  console.error(`[cabinet] the shop refused ${order.id}: ${made.why}`);
  return {
    refused: {
      code: "cannot_fulfill",
      message:
        "The shop this product is sold from would not accept the order, so nothing was" +
        " delivered and the sale did not go through.",
    },
  };
};

const unknownCreation = (orderId: string, shopUrl: string, attemptedAt: Date): HandlerAnswer => {
  console.error(
    `[cabinet] ${orderId} was already being placed in the shop at ${shopUrl} at` +
      ` ${attemptedAt.toISOString()} and that attempt never reported back. It is refused` +
      " rather than placed again; look for an order carrying this identifier as its" +
      " transaction id before deciding nothing happened.",
  );
  return {
    refused: {
      code: "cannot_fulfill",
      message:
        `An earlier attempt to place ${orderId} in the shop was interrupted and never reported` +
        " back, so whether the shop holds an order for it is not something this can find out." +
        " It is refused rather than ordered a second time, because a second order is a second" +
        " thing the shop has to fulfil.",
    },
  };
};

const downloadUrlFor = (
  shopUrl: string,
  productId: string,
  order: Extract<OrderMade, { ok: true }>,
  email: string,
): string => {
  const address = new URL(shopUrl);
  address.pathname = "/";
  address.search = new URLSearchParams({
    download_file: productId,
    order: order.orderKey,
    uid: createHash("sha256").update(email).digest("hex"),
    key: order.downloadId,
  }).toString();
  return address.toString();
};

/** What the loop needs to fill one connected shop's orders. */
export interface WorkingParts extends Filling {
  /** How the account behind a connection is read: its address and its key. */
  readonly identity: Pick<Identity, "byId">;
  readonly clientFor: (key: string) => GatewayClient;
  /** How long one poll holds the stream open. */
  readonly waitSeconds?: number;
  /** At most this many orders drawn in one turn. */
  readonly max?: number;
  /** Fresh price/availability from Woo; supplied by production in the next boundary. */
  readonly quote?: (
    connection: WooConnection,
    question: QuoteRequest,
    at: Date,
  ) => Promise<QuoteResponse>;
}

/**
 * How long one poll waits.
 *
 * Short enough that a merchant stopping the cabinet does not wait on it, and
 * long enough that a synchronous order is picked up the moment it is written
 * rather than on the next turn — which matters, because a synchronous purchase
 * is an agent holding a request open while this happens.
 */
const WAIT_SECONDS = 5;

/** At most this many orders in one turn. */
const AT_MOST = 10;

/**
 * One turn for one connected shop: draw the stream, fill what came, answer.
 *
 * It answers with how many envelopes were drawn, which is what the loop reads
 * to decide whether to come straight back.
 */
export const turnOnce = async (connection: WooConnection, parts: WorkingParts): Promise<number> => {
  const person = await parts.identity.byId(connection.accountId);
  if (person === null || person.merchant === null) {
    // The account behind this connection is gone, or has no merchant on it.
    // Nothing can be drawn as somebody who does not exist.
    console.error(
      `[cabinet] the WooCommerce connection for ${connection.accountId} names an account with no` +
        " merchant on it, so its orders cannot be drawn",
    );
    return 0;
  }

  const gateway = parts.clientFor(person.merchant.key);
  const drawn = await gateway.pollWorker(parts.waitSeconds ?? WAIT_SECONDS, parts.max ?? AT_MOST);
  if (!drawn.ok) {
    console.error(`[cabinet] the WooCommerce worker could not draw its stream: ${drawn.why}`);
    return 0;
  }

  let filled = 0;
  for (const envelope of drawn.document.envelopes) {
    if (envelope.kind === "quote_request") {
      filled += 1;
      const answer =
        parts.quote === undefined
          ? await quoteFromTheShop(connection, envelope.payload, parts.now())
          : await parts.quote(connection, envelope.payload, parts.now());
      const said = await gateway.answerQuote(envelope.payload.price_id, answer);
      if (!said.ok) {
        console.error(
          `[cabinet] the price answer for ${envelope.payload.price_id} was not accepted: ${said.why}`,
        );
      }
      continue;
    }
    // Events have no reply. Reading one here would be pretending to answer it.
    if (envelope.kind !== "order") {
      continue;
    }
    filled += 1;
    const answer = await fillFromTheShop(envelope.payload, connection, person.email, parts);
    if (answer === null) {
      continue;
    }
    const said = await gateway.answerOrder(envelope.payload.id, answer);
    if (!said.ok) {
      console.error(
        `[cabinet] the answer for ${envelope.payload.id} was not accepted: ${said.why}`,
      );
    }
  }
  return filled;
};

const quoteFromTheShop = async (
  connection: WooConnection,
  question: QuoteRequest,
  at: Date,
): Promise<QuoteResponse> => {
  const read = await inspectProductInTheShop(connection, question.merchant_item_id);
  return read.ok
    ? { available: true, price: read.product.price, as_of: at.toISOString() }
    : { available: false, as_of: at.toISOString() };
};

/** A worker turning, until it is stopped. */
export interface WooWorker {
  stop(): Promise<void>;
}

/** How long the loop waits before looking for connections again. */
const BETWEEN_TURNS_MS = 1_000;

/**
 * Keeps every connected shop's orders being filled, for as long as the cabinet
 * is running.
 *
 * One loop per connected shop rather than one loop walking them all, because
 * the walk is what turns a second merchant into a wait: a poll holds its
 * request open, and a synchronous purchase is answered inside a budget that is
 * the same for every product on the platform. A merchant whose orders were
 * behind somebody else's poll would sell less the more shops we connected.
 *
 * The list of connections is read again every second, so a shop connected while
 * this is running starts being served without a restart and one disconnected
 * stops. Nothing here is a schedule anything depends on: an order nobody draws
 * is handed over again by the order machine, so a cabinet that was down comes
 * back to work that is still waiting.
 */
export const startWooWorker = (
  parts: WorkingParts & { readonly betweenTurnsMs?: number },
): WooWorker => {
  const turning = new Map<string, { stop: () => void; done: Promise<void> }>();
  let running = true;

  const loopFor = (accountId: string) => {
    let alive = true;
    const done = (async () => {
      while (alive && running) {
        try {
          const connection = await parts.shops.connectionOf(accountId);
          if (connection === null) {
            // Waited out rather than returned from, which is not tidiness. The
            // watcher below starts a loop for an account that has none, and it
            // decides that by asking whether this map holds one — so a loop
            // that ended on its own would leave an entry nothing is running
            // behind, and a merchant who disconnected and connected again
            // inside one pass would have their orders filled by nobody until
            // the cabinet was restarted. Ending a loop is the watcher's, and
            // it is the only thing that takes the entry away with it.
            await new Promise((resolve) =>
              setTimeout(resolve, parts.betweenTurnsMs ?? BETWEEN_TURNS_MS),
            );
            continue;
          }
          const filled = await turnOnce(connection, parts);
          if (filled === 0) {
            // A turn that drew nothing waits before the next one. The poll
            // ordinarily holds its own request open for seconds, so this is
            // usually zero extra waiting — but a gateway that answers a poll
            // at once, because it refused it or because the wait was asked for
            // as nothing, would otherwise be asked again as fast as this
            // process can ask, which is a cabinet hammering a gateway that is
            // already having a bad afternoon. A turn that did fill something
            // comes straight back, because there may be more waiting.
            await new Promise((resolve) =>
              setTimeout(resolve, parts.betweenTurnsMs ?? BETWEEN_TURNS_MS),
            );
          }
        } catch (thrown) {
          // A turn that threw must not take the loop with it: what is on the
          // other end is somebody else's shop and somebody else's network.
          console.error(`[cabinet] a WooCommerce turn failed for ${accountId}`, thrown);
          await new Promise((resolve) =>
            setTimeout(resolve, parts.betweenTurnsMs ?? BETWEEN_TURNS_MS),
          );
        }
      }
    })();
    return {
      stop: () => {
        alive = false;
      },
      done,
    };
  };

  const watching = (async () => {
    while (running) {
      try {
        const connections = await parts.shops.connections();
        const wanted = new Set(connections.map((one) => one.accountId));
        for (const accountId of wanted) {
          if (!turning.has(accountId)) {
            turning.set(accountId, loopFor(accountId));
          }
        }
        for (const [accountId, loop] of turning) {
          if (!wanted.has(accountId)) {
            loop.stop();
            turning.delete(accountId);
          }
        }
      } catch (thrown) {
        console.error("[cabinet] the WooCommerce worker could not read its connections", thrown);
      }
      await new Promise((resolve) => setTimeout(resolve, parts.betweenTurnsMs ?? BETWEEN_TURNS_MS));
    }
  })();

  return {
    async stop() {
      running = false;
      for (const loop of turning.values()) {
        loop.stop();
      }
      await watching;
      await Promise.all([...turning.values()].map((loop) => loop.done));
      turning.clear();
    },
  };
};

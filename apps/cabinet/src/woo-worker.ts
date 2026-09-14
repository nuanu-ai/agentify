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

import type { HandlerAnswer, Order } from "@nuanu-ai/coinslot-contracts";
import type { GatewayClient } from "./gateway.js";
import type { Identity } from "./identity.js";
import {
  createTheOrderInTheShop,
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
  buyerEmail: string,
  parts: Filling,
): Promise<HandlerAnswer | null> => {
  const place = parts.placeOrder ?? createTheOrderInTheShop;

  if (connection.permissions !== "read_write") {
    // The shop granted less than we asked for. Every sale on this connection
    // ends here, and saying so in the refusal is the only way the merchant ever
    // finds out why — the alternative is the shop's own 401, which talks about
    // listing resources and names no cause.
    return {
      refused: {
        code: "cannot_fulfill",
        message:
          `The shop at ${connection.shopUrl} granted us ${JSON.stringify(connection.permissions)}` +
          " access, which cannot create an order. Connect the shop again and approve read and" +
          " write access.",
      },
    };
  }

  const claim = await parts.shops.claimOrder(connection.accountId, order.id, parts.now());

  if (claim.kind === "placed") {
    // The same sale, handed over a second time. The shop already has the order
    // and the buyer gets the same number they would have got the first time.
    return { delivered: { order_number: claim.number } };
  }

  if (claim.kind === "unknown") {
    console.error(
      `[cabinet] ${order.id} was already being placed in the shop at ${connection.shopUrl} at` +
        ` ${claim.attemptedAt.toISOString()} and that attempt never reported back. It is refused` +
        " rather than placed again; look for an order carrying this identifier as its" +
        " transaction id before deciding nothing happened.",
    );
    return {
      refused: {
        code: "cannot_fulfill",
        message:
          `An earlier attempt to place ${order.id} in the shop was interrupted and never reported` +
          " back, so whether the shop holds an order for it is not something this can find out." +
          " It is refused rather than ordered a second time, because a second order is a second" +
          " thing the shop has to fulfil.",
      },
    };
  }

  const made = await place(connection, {
    orderId: order.id,
    productId: order.merchant_item_id,
    // The merchant's own address, because creating an order makes WooCommerce
    // send mail to whatever is on it and nothing in the request can stop that.
    // Whose address belongs here is a product question nobody has answered; the
    // decision record says so rather than this pretending it is settled.
    email: buyerEmail,
    price: { amount: order.price.amount, currency: order.price.currency },
  });

  if (made.ok) {
    await parts.shops.recordOrder(order.id, { id: made.id, number: made.number }, parts.now());
    return { delivered: { order_number: made.number } };
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
  return {
    refused: {
      code: "cannot_fulfill",
      message: `The shop would not take this order. ${made.why}`,
    },
  };
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
    // Orders and nothing else. A price question belongs to a card with a price
    // check, which an imported card never has, and an event has no reply of any
    // kind — reading one here would be pretending to answer it.
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
            return;
          }
          await turnOnce(connection, parts);
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

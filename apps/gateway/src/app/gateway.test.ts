import { outcomeFor } from "@agentify/core";
import type { Card } from "@nuanu-ai/agentify-contracts";
import {
  CARD_REJECTED,
  CatalogPageSchema,
  PublishResultSchema,
  ReceiptSchema,
  WorkerPollResponseSchema,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asTimestamp } from "../ports/clock.js";
import {
  authorisation,
  drawEverything,
  type Harness,
  harness,
  paymentNamingNoPayer,
  workOnce,
  workUntilStopped,
} from "../testing/harness.js";
import { agentOrderStatusOf, orderDocumentOf } from "./runner.js";

/** Two wallets, for the tests that turn on which of them signed. */
const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/** Alice's own address as another client would write it. One wallet, not two. */
const ALICE_SHOUTED = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const syncCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  params: { nights: { type: "integer", required: true } },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

const asyncCard: Card = {
  merchant_item_id: "esim-7d",
  title: "A seven day eSIM",
  description: "Seven days of data",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
};

const livePriced = (card: Card): Card => ({ ...card, price_check: "handler" });

/**
 * Prices a merchant may write that no payment here can be taken at: the price,
 * the half of it that is wrong, and what that half said.
 */
const UNSELLABLE_PRICES: readonly [price: unknown, field: string, found: string][] = [
  [{ amount: "0", currency: "USD" }, "amount", "0"],
  [{ amount: "0.00", currency: "USD" }, "amount", "0.00"],
  [{ amount: "0.000000", currency: "USD" }, "amount", "0.000000"],
  ["0.00 USD", "amount", "0.00"],
  [{ amount: "500", currency: "USD" }, "amount", "500"],
  [{ amount: "5", currency: "USD" }, "amount", "5"],
  [{ amount: "5.0", currency: "USD" }, "amount", "5.0"],
  ["5 USD", "amount", "5"],
  [{ amount: "0.0000001", currency: "USD" }, "amount", "0.0000001"],
  ["19.9999999 USDC", "amount", "19.9999999"],
  [{ amount: "5.00", currency: "EUR" }, "currency", "EUR"],
];

/** Prices the same door takes, written each way a merchant writes them. */
const SELLABLE_PRICES: readonly unknown[] = [
  { amount: "0.01", currency: "USD" },
  { amount: "5.00", currency: "USD" },
  { amount: "0.001", currency: "USD" },
  { amount: "19.999", currency: "USD" },
  { amount: "0.000001", currency: "USD" },
  { amount: "5.00", currency: "USDC" },
  "5.00 USD",
];

let open: Harness | null = null;
const started = async (overrides: Record<string, string> = {}) => {
  open = await harness(overrides);
  return open;
};

afterEach(async () => {
  await open?.stop();
  open = null;
});

const published = async (harnessed: Harness, card: Card): Promise<string> => {
  const result = await harnessed.gateway.publishCard(harnessed.merchant.id, card);
  expect(PublishResultSchema.safeParse(result).success).toBe(true);
  if (!result.ok) throw new Error(`publishing failed: ${JSON.stringify(result.error.problems)}`);
  return result.id;
};

describe("the catalog", () => {
  it("reports a missing merchant as an internal invariant failure", async () => {
    const harnessed = await started();

    await expect(harnessed.gateway.publishCard("mch_missing", syncCard)).rejects.toThrow(
      "publishing resolved to mch_missing, and there is no such merchant",
    );
  });

  it("answers a card that will not do with everything wrong with it at once", async () => {
    // A merchant fixing one field per round trip is the experience the list of
    // findings exists to prevent.
    const harnessed = await started();

    const result = await harnessed.gateway.publishCard(harnessed.merchant.id, {
      merchant_item_id: "",
      title: "",
    });

    expect(PublishResultSchema.safeParse(result).success).toBe(true);
    if (result.ok) throw new Error("a broken card was published");
    expect(result.error.code).toBe(CARD_REJECTED);
    expect(result.error.retryable).toBe(false);
    expect(result.error.problems.length).toBeGreaterThan(1);
    // The sentence names the first finding and counts the rest, for a person
    // reading one line of a log.
    expect(result.error.message).toContain(String(result.error.problems.length));
  });

  it("refuses a price it cannot sell at, and names what it found", async () => {
    // A payment of nothing is not a sale, a currency other than the dollar has
    // no rate to be charged at, and an amount written without its cents is how
    // "500" meant as five dollars becomes a five-hundred-dollar card. An amount
    // finer than the token a buyer pays in has no exact charge. The short
    // spelling meets the same rule in the same words.
    const harnessed = await started();

    for (const [price, field, found] of UNSELLABLE_PRICES) {
      const result = await harnessed.gateway.publishCard(harnessed.merchant.id, {
        ...syncCard,
        price,
      });

      expect(PublishResultSchema.safeParse(result).success).toBe(true);
      if (result.ok) throw new Error(`${JSON.stringify(price)} was published`);
      // One finding for each half of the price, so that "0" is told about zero
      // and not also sent to write "0.00", which would only be refused again.
      const findings = result.error.problems.filter(
        (problem) => problem.path.join(".") === `price.${field}`,
      );
      expect(findings, JSON.stringify(price)).toHaveLength(1);
      expect(findings[0]?.message, JSON.stringify(price)).toContain(JSON.stringify(found));
    }
    expect((await harnessed.gateway.catalog()).items).toHaveLength(0);
  });

  it("publishes every price a payment can be taken at", async () => {
    // So the rule cannot grow past its purpose: a price below a cent is
    // ordinary for a call priced per use, and a card priced in USDC is charged
    // in USDC as it stands.
    const harnessed = await started();

    for (const [index, price] of SELLABLE_PRICES.entries()) {
      const result = await harnessed.gateway.publishCard(harnessed.merchant.id, {
        ...syncCard,
        merchant_item_id: `room-${index}`,
        price,
      });
      expect(result.ok, JSON.stringify(price)).toBe(true);
    }
    expect((await harnessed.gateway.catalog()).items).toHaveLength(SELLABLE_PRICES.length);
  });

  it("shows an agent the card as a card, and never the merchant's own key", async () => {
    // The projection is the whole reason a public card exists: our catalog
    // identifier travels, the merchant's internal key does not.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);

    const page = await harnessed.gateway.catalog();

    expect(CatalogPageSchema.safeParse(page).success).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(itemId);
    expect(JSON.stringify(page)).not.toContain("room-101");
  });
});

describe("a synchronous purchase", () => {
  it("goes from the catalog to the goods, with the charge last", async () => {
    // The whole promise of the synchronous mode: the agent is answered with the
    // goods themselves, and the buyer's money moves only after the merchant has
    // actually produced them.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    expect(offered.step).toBe("pay");
    if (offered.step !== "pay") throw new Error("no price was offered");
    expect(offered.order.order.price?.amount).toBe("80.00");
    expect(harnessed.facilitator.settles).toHaveLength(0);

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const bought = await harnessed.gateway.payPurchase(
      offered.order.order.id,
      "PAYMENT",
      "PAYMENT",
    );
    await worker.stop();

    expect(bought.step).toBe("settled");
    if (bought.step !== "settled") throw new Error("the purchase did not settle");
    expect(bought.order.order.state).toBe("delivered");
    expect(bought.delivery).toStrictEqual({ access_code: "SESAME" });

    // Verified before the merchant saw it, executed after he answered.
    expect(harnessed.facilitator.verifies).toHaveLength(1);
    expect(harnessed.facilitator.settles).toHaveLength(1);

    const receipt = await harnessed.store.receiptForOrder(offered.order.order.id);
    expect(receipt?.outcome).toBe("delivered");
    expect(receipt?.price.amount).toBe("80.00");
  });

  it("answers with the goods when the agent took its time deciding to pay", async () => {
    // Every clock of the synchronous mode counts from the paid call, not from
    // the unpaid one that opened the order. Twenty seconds of thinking is longer
    // than the ceiling itself, so a budget counted from the wrong end would be
    // empty rather than merely short.
    //
    // The handler takes twenty milliseconds on purpose. A real handler is
    // another process and cannot answer in the same turn of the event loop, and
    // an instantaneous one would win even against a budget of zero.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");

    harnessed.advance(20_000);

    const worker = workUntilStopped(harnessed, {
      onOrder: async () => {
        await new Promise((wake) => setTimeout(wake, 20));
        return { delivered: { access_code: "SESAME" } };
      },
    });
    const bought = await harnessed.gateway.payPurchase(
      offered.order.order.id,
      "PAYMENT",
      "PAYMENT",
    );
    await worker.stop();

    expect(bought.step).toBe("settled");
    if (bought.step !== "settled") throw new Error(`the purchase came back ${bought.step}`);
    expect(bought.delivery).toStrictEqual({ access_code: "SESAME" });
    expect(bought.order.order.state).toBe("delivered");
  });

  it("waits out the whole ceiling, with the payment check on top of it", async () => {
    // Both clocks the goods run on start when the payment checks out: the
    // merchant's answer has `sync_response` from there and the charge has its
    // own `settle_response` after that. So the park has to wait out the check
    // and then the whole ceiling; counting the ceiling from the call's arrival
    // gives up one round trip to the facilitator early.
    //
    // The merchant answers inside his 800, the charge inside its 200, and the
    // two together inside the 1000. The check takes half the ceiling because
    // its length is exactly the width of the hole, and half keeps the two
    // outcomes further apart than any scheduling noise. The gateway measures
    // the budget against the harness clock while the park's timer is real, so
    // the check's cost is a jump of the clock and the merchant's is a real
    // wait the park has to sit through.
    const harnessed = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "800",
      SETTLE_RESPONSE_MS: "200",
      SYNC_BUDGET_MS: "1000",
    });
    const itemId = await published(harnessed, syncCard);

    const layer = harnessed.facilitator;
    const vouchesFor = layer.verify.bind(layer);
    const executes = layer.settle.bind(layer);
    layer.verify = async (charge) => {
      harnessed.advance(500);
      return vouchesFor(charge);
    };
    layer.settle = async (charge) => {
      harnessed.advance(150);
      return executes(charge);
    };

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");

    const worker = workUntilStopped(harnessed, {
      onOrder: async () => {
        await new Promise((wake) => setTimeout(wake, 700));
        harnessed.advance(600);
        return { delivered: { access_code: "SESAME" } };
      },
    });
    const bought = await harnessed.gateway.payPurchase(
      offered.order.order.id,
      "PAYMENT",
      "PAYMENT",
    );
    await worker.stop();

    expect(bought.step).toBe("settled");
    if (bought.step !== "settled") throw new Error(`the purchase came back ${bought.step}`);
    expect(bought.delivery).toStrictEqual({ access_code: "SESAME" });
    expect(bought.order.order.state).toBe("delivered");
    // The money moved, which is the half of this an agent cannot see from the
    // goods alone: the ceiling has to cover the charge as well as the answer.
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });

  it("charges nothing when the merchant refuses", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ refused: { code: "out_of_stock", message: "the room is taken" } }),
    });
    const bought = await harnessed.gateway.payPurchase(
      offered.order.order.id,
      "PAYMENT",
      "PAYMENT",
    );
    await worker.stop();

    if (bought.step !== "settled") throw new Error("the purchase did not settle");
    expect(bought.order.order.state).toBe("failed");
    expect(harnessed.facilitator.settles).toHaveLength(0);
    expect(await harnessed.store.receiptForOrder(offered.order.order.id)).toBeNull();
  });

  it("takes nothing, and leaves the order open, when a payment does not check out", async () => {
    // A stranger's junk must not spend the life of an order somebody else was
    // issued a challenge for, so it closes and claims nothing, and the buyer
    // may still present a corrected payment while the quote stands.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    harnessed.facilitator.willRefuseVerification("insufficient_funds", "the wallet is empty");

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const bought = await harnessed.gateway.payPurchase(
      offered.order.order.id,
      "PAYMENT",
      "PAYMENT",
    );

    expect(bought.step).toBe("payment_not_verified");
    if (bought.step !== "payment_not_verified") throw new Error("a bad payment was taken");
    expect(bought.why).toContain("the wallet is empty");
    expect(bought.retryable).toBe(false);

    const stillOpen = await harnessed.store.orderById(offered.order.order.id);
    expect(stillOpen?.order.state).toBe("quoted");
    expect(stillOpen?.paidBy).toBeNull();
    expect(harnessed.facilitator.settles).toHaveLength(0);
    // The junk payment never even claimed its fingerprint against the order.
    expect(harnessed.facilitator.verifies).toHaveLength(1);
  });

  it("leaves the goods with the merchant and the money with the buyer when the charge fails last", async () => {
    // The goods exist and the charge did not go through. The buyer is not told
    // he bought nothing, and the merchant is told he holds goods nobody paid
    // for.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    harnessed.facilitator.willSettle({ settled: false, reason: "the transfer reverted" });

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const bought = await harnessed.gateway.payPurchase(
      offered.order.order.id,
      "PAYMENT",
      "PAYMENT",
    );
    await worker.stop();

    if (bought.step !== "settled") throw new Error("the purchase did not settle");
    expect(bought.order.order.state).toBe("delivered_unpaid");

    const told = await harnessed.gateway.poll(harnessed.merchant.id, 0);
    expect(told.envelopes.map((e) => e.kind === "order_event" && e.payload.type)).toContain(
      "order.payment_failed_after_delivery",
    );
  });

  it("says nobody knows when the charge goes quiet, rather than saying it failed", async () => {
    // An agent told his purchase did not happen goes and buys the same thing
    // elsewhere without looking at his wallet.
    // The budget is far wider than the deadlines on purpose: it is a real wait
    // racing a real timer, and a narrow margin makes the test flaky.
    const harnessed = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "200",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "2000",
    });
    const itemId = await published(harnessed, syncCard);
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "the facilitator timed out" });

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
    await worker.stop();

    // The charge's deadline declared the silence in the word that keeps "nobody
    // knows" apart from "it did not go through". The goods exist, so the order
    // is unclosed rather than refused.
    const parked = await harnessed.store.orderById(offered.order.order.id);
    expect(parked?.order.state).toBe("delivered_unpaid");
    expect(parked?.order.payment).toBe("outcome_unknown");
    if (parked === null) throw new Error("the order went missing");
    // Not `in_progress`: nothing is asking the payment network again, and that
    // word is what a restarted worker treats as an order still waiting on him.
    expect(
      agentOrderStatusOf(parked, { name: null, site: null }, harnessed.runtime.config).status,
    ).toBe("payment_unresolved");
    // And no second charge went out on top of the one nobody has heard from.
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });

  it("still writes the receipt when the facilitator answers after the silence was declared", async () => {
    // The facilitator's client waits far longer than the settle deadline, so a
    // silence is usually declared while the call is still out. The answer that
    // lands afterwards names a transaction the payment layer executed, and the
    // receipt is what a merchant reconciles a wallet against.
    const harnessed = await started({
      SYNC_RESPONSE_MS: "200",
      SETTLE_RESPONSE_MS: "50",
      SYNC_BUDGET_MS: "2000",
    });
    const itemId = await published(harnessed, syncCard);
    const release = harnessed.facilitator.holdSettle();
    harnessed.facilitator.willSettle({ settled: true, transaction: "0xreal" });
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const buying = harnessed.gateway.payPurchase(orderId, "PAYMENT", "fp_late");
    await vi.waitFor(
      async () => {
        expect((await harnessed.store.orderById(orderId))?.order.payment).toBe("outcome_unknown");
      },
      { timeout: 2_000 },
    );

    release();
    await buying;
    await worker.stop();

    const closed = await harnessed.store.orderById(orderId);
    expect(closed?.order.state).toBe("delivered");
    expect(closed?.order.payment).toBe("settled");
    expect(closed?.settlement).toStrictEqual({ transaction: "0xreal" });
    expect(await harnessed.store.receiptForOrder(orderId)).not.toBeNull();
    expect((await harnessed.store.receiptForOrder(orderId))?.outcome).toBe("delivered");
  });

  it("sends an agent back to a quiet order as one still open, not one that is over", async () => {
    // An agent that presents a spent authorisation is told which order holds
    // it and whether there is anything to collect there. An order whose charge
    // went quiet is still open: the goods are made and the money may have
    // moved, and an agent told it was over pays a second time.
    const harnessed = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "200",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "2000",
    });
    const itemId = await published(harnessed, syncCard);
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "the facilitator timed out" });
    const quiet = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    const again = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (quiet.step !== "pay" || again.step !== "pay") throw new Error("no price was offered");
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await harnessed.gateway.payPurchase(quiet.order.order.id, "SIGNED", "SIGNED");
    await worker.stop();
    const held = await harnessed.store.orderById(quiet.order.order.id);
    expect(held?.order.state).toBe("delivered_unpaid");
    expect(held?.order.payment).toBe("outcome_unknown");

    const replayed = await harnessed.gateway.payPurchase(again.order.order.id, "SIGNED", "SIGNED");

    expect(replayed.step).toBe("payment_already_spent");
    if (replayed.step !== "payment_already_spent") throw new Error("the replay was taken");
    expect(replayed.heldBy).toBe(quiet.order.order.id);
    expect(replayed.collectable).toBe(true);

    // On an order that really is over, refused with nothing charged or made,
    // there is nothing to collect.
    const doomed = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    const afterwards = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (doomed.step !== "pay" || afterwards.step !== "pay") throw new Error("no price was offered");
    const refusing = workUntilStopped(harnessed, {
      onOrder: () => ({ refused: { code: "out_of_stock", message: "the room is taken" } }),
    });
    await harnessed.gateway.payPurchase(doomed.order.order.id, "OTHER", "OTHER");
    await refusing.stop();
    expect((await harnessed.store.orderById(doomed.order.order.id))?.order.state).toBe("failed");

    const dead = await harnessed.gateway.payPurchase(afterwards.order.order.id, "OTHER", "OTHER");

    expect(dead.step).toBe("payment_already_spent");
    if (dead.step !== "payment_already_spent") throw new Error("the replay was taken");
    expect(dead.collectable).toBe(false);
  });
});

describe("an asynchronous purchase", () => {
  it("takes the money first and answers with an order and a receipt", async () => {
    // The other half of the model: the merchant is not asked before the charge,
    // so the agent is answered with an order rather than with goods.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);

    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");

    const bought = await harnessed.gateway.payPurchase(
      offered.order.order.id,
      "PAYMENT",
      "PAYMENT",
    );

    expect(bought.step).toBe("under_way");
    if (bought.step !== "under_way") throw new Error("the agent was made to wait");
    expect(bought.order.order.state).toBe("paid");
    expect(bought.order.order.payment).toBe("settled");
    expect(await harnessed.store.receiptForOrder(offered.order.order.id)).toBeNull();

    const worked = await workOnce(harnessed, {
      onOrder: () => ({ accepted: {} }),
    });
    expect(worked).toBe(1);

    const answered = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {
        activation_code: "LPA:1$X",
      },
    );
    expect(answered).toStrictEqual({ ok: true, result: "delivered" });

    const closed = await harnessed.store.orderById(offered.order.order.id);
    expect(closed?.order.state).toBe("delivered");
    expect((await harnessed.store.receiptForOrder(offered.order.order.id))?.outcome).toBe(
      "delivered",
    );
  });

  it("stamps the receipt with the moment the money moved, not the moment it was written", async () => {
    // The charge goes through at the purchase and the goods come hours later;
    // a receipt stamped at the delivery would put the charge at a moment when
    // nothing had happened, and reconciling against it would be off by that gap.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    const whenTheMoneyMoved = harnessed.now();

    harnessed.advance(6 * 60 * 60 * 1_000);
    await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, { activation_code: "A" });

    const receipt = await harnessed.store.receiptForOrder(orderId);
    expect(receipt?.paid_at).toBe(new Date(whenTheMoneyMoved).toISOString());
  });

  it("will not let one payment buy two orders", async () => {
    // A signed payment says how much, to whom and on which chain, and nothing
    // about which purchase it is for. Two orders at the same price would
    // otherwise both verify, both go to a merchant and both be delivered, and
    // only the second charge would fail — leaving a merchant who handed over
    // goods for nothing.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const first = await harnessed.gateway.beginPurchase(itemId, {});
    const second = await harnessed.gateway.beginPurchase(itemId, {});
    if (first.step !== "pay" || second.step !== "pay") throw new Error("no price was offered");

    const bought = await harnessed.gateway.payPurchase(first.order.order.id, "SIGNED", "SIGNED");
    expect(bought.step).toBe("under_way");

    const replayed = await harnessed.gateway.payPurchase(second.order.order.id, "SIGNED", "SIGNED");

    expect(replayed.step).toBe("payment_already_spent");
    if (replayed.step !== "payment_already_spent") throw new Error("the replay was taken");
    expect(replayed.heldBy).toBe(first.order.order.id);
    // The replay is checked with the payment layer — the claim guard comes after
    // verification, so a payment that fails to check out never burns a claim —
    // but the claim stops it before it can own a second order or be charged.
    expect(harnessed.facilitator.settles).toHaveLength(1);
    expect((await harnessed.store.orderById(second.order.order.id))?.order.state).toBe("quoted");
    expect((await harnessed.store.orderById(second.order.order.id))?.paidBy).toBeNull();
  });

  it("lets the same order present the same payment again", async () => {
    // A dropped connection and a retry is the ordinary case, and the order that
    // owns a payment still owns it on the second try.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    await harnessed.gateway.payPurchase(orderId, "SIGNED", "SIGNED");
    const again = await harnessed.gateway.payPurchase(orderId, "SIGNED", "SIGNED");

    // Where the purchase has got to, and not merely something other than a
    // refusal: an answer that turned the owner away as a stranger would not be
    // "payment already spent" either.
    expect(again.step).toBe("under_way");
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });

  it("closes a purchase whose charge failed after delivery when the agent pays again", async () => {
    // The goods the merchant already made are not thrown away, and a repeat
    // carries the payment through against them without asking him to produce
    // anything a second time.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    harnessed.facilitator.willSettle(
      { settled: false, reason: "the transfer reverted" },
      { settled: true, transaction: "0xsecond" },
    );

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    // Both payments come from one wallet, each with its own authorisation and
    // fingerprint. The second spells the address in capitals, as some clients
    // do; the chain does not care, so the ownership check must not either.
    const first = authorisation(harnessed, ALICE, "0x01");
    const second = authorisation(harnessed, ALICE_SHOUTED, "0x02");
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await harnessed.gateway.payPurchase(orderId, first.payment, first.fingerprint);
    await worker.stop();
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("delivered_unpaid");

    const repeated = await harnessed.gateway.payPurchase(
      orderId,
      second.payment,
      second.fingerprint,
    );

    expect(repeated.step).toBe("settled");
    if (repeated.step !== "settled") throw new Error("the repeat did not settle");
    expect(repeated.order.order.state).toBe("delivered");
    expect(repeated.delivery).toStrictEqual({ access_code: "SESAME" });
    // The merchant was asked for nothing the second time round.
    expect(harnessed.facilitator.settles).toHaveLength(2);
    // The charge that closed it was the payment the agent actually presented:
    // charging the failed first authorisation again would take nothing while
    // the one the agent sent was thrown away.
    expect(harnessed.facilitator.settles.map((charge) => charge.payment)).toStrictEqual([
      first.payment,
      second.payment,
    ]);
    expect(harnessed.facilitator.verifies.at(-1)?.payment).toBe(second.payment);
  });

  it("keeps the last few things the payment layer said, and counts what it dropped", async () => {
    // They are what an operator reconciles a silent charge from, and they
    // arrive on a route that takes no key, so the list is bounded and counts
    // what fell off. A synchronous purchase says two things, the verification
    // and the charge; with room for one, the charge is kept.
    const harnessed = await started({ PAYMENT_WORDS_KEPT: "1" });
    const itemId = await published(harnessed, syncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "X" } }),
    });
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await worker.stop();

    const record = await harnessed.store.orderById(orderId);
    expect(record?.paymentWords).toHaveLength(1);
    expect(record?.paymentWords[0]?.about).toBe("settle");
    expect(record?.paymentWordsDropped).toBe(1);
  });

  it("does not take a second payment on an order whose first charge went quiet", async () => {
    // A second charge would spend the buyer's money on a guess about the
    // first. The refusal must also leave the record alone: which authorisation
    // is unaccounted for is the only thing that order can be reconciled from.
    // The budget is far wider than the deadlines on purpose: it is a real wait
    // racing a real timer, and a narrow margin makes the test flaky.
    const harnessed = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "200",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "2000",
    });
    const itemId = await published(harnessed, syncCard);
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "the facilitator timed out" });

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    // The purchase comes back when the promised ceiling runs out. Both payments
    // are signed from the same wallet, so the second reaches the repeat the
    // machine refuses rather than being turned away as a stranger's.
    const first = authorisation(harnessed, ALICE, "0x01");
    const second = authorisation(harnessed, ALICE, "0x02");
    await harnessed.gateway.payPurchase(orderId, first.payment, first.fingerprint);
    await worker.stop();

    const stuck = await harnessed.store.orderById(orderId);
    expect(stuck?.order.payment).toBe("outcome_unknown");

    const refused = await harnessed.gateway.payPurchase(
      orderId,
      second.payment,
      second.fingerprint,
    );

    expect(refused.step).toBe("payment_not_taken");
    if (refused.step !== "payment_not_taken") throw new Error("the second payment was taken");
    expect(refused.retryable).toBe(true);

    // Nothing was charged, and the record of the charge that went quiet is
    // exactly as it was.
    const after = await harnessed.store.orderById(orderId);
    expect(after?.payment).toBe(first.payment);
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });

  it("answers a second delivery the same way as the first", async () => {
    // Called again after a dropped connection, deliver delivers nothing twice
    // and charges nothing twice.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    const first = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {
        activation_code: "A",
      },
    );
    const again = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {
        activation_code: "A",
      },
    );

    expect(first).toStrictEqual({ ok: true, result: "delivered" });
    expect(again).toStrictEqual({ ok: true, result: "already_delivered" });
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });

  it("owes a refund when the merchant refuses after the money moved", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
    await workOnce(harnessed, { onOrder: () => ({ accepted: {} }) });

    const answered = await harnessed.gateway.refuseOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {
        code: "out_of_stock",
        message: "the supplier has none",
      },
    );

    expect(answered).toStrictEqual({ ok: true, result: "refused" });
    const owing = await harnessed.store.orderById(offered.order.order.id);
    expect(owing?.order.state).toBe("refund_due");

    // No receipt, and that is a known gap: the receipt vocabulary has a word
    // for an order that owes money back, but receipts are written only when
    // goods are released, so this order has none to carry it.
    expect(await harnessed.store.receiptForOrder(offered.order.order.id)).toBeNull();

    const told = await harnessed.gateway.poll(harnessed.merchant.id, 0);
    const events = told.envelopes.flatMap((e) => (e.kind === "order_event" ? [e.payload] : []));
    expect(events.map((e) => e.type)).toContain("order.refund_due");
  });

  it("refuses a delivery once a refund is recorded", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.refuseOrder(harnessed.merchant.id, orderId, {
      code: "out_of_stock",
      message: "none",
    });
    await harnessed.gateway.runner.apply(orderId, {
      kind: "refund_settled",
      at: harnessed.now(),
    });

    const late = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "A",
    });

    expect(late).toStrictEqual({
      ok: false,
      error: {
        code: "refund_already_settled",
        message: expect.any(String),
        retryable: false,
      },
    });
  });

  it("closes the debt when late goods arrive before a refund is recorded", async () => {
    // To a buyer, late goods are better than a refund — as long as no refund
    // has been recorded.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.refuseOrder(harnessed.merchant.id, orderId, {
      code: "cannot_fulfill",
      message: "late",
    });

    const late = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "A",
    });

    expect(late).toStrictEqual({ ok: true, result: "debt_closed_by_delivery" });
    const closed = await harnessed.store.orderById(orderId);
    expect(closed?.order.state).toBe("delivered");
    expect(closed?.order.closure).toBeNull();
    expect((await harnessed.store.receiptForOrder(orderId))?.outcome).toBe("delivered");
  });
});

describe("the goods against the card that sold them", () => {
  // Assertions here read the order back out of the store rather than trusting
  // the call's answer: an order marked delivered with nothing behind it, and
  // goods quietly replaced by a later call, both answer exactly as a correct
  // gateway would.

  /** An order paid for under the card as it stands, its identifier returned. */
  const paidOrder = async (harnessed: Harness, itemId: string, payment: string) => {
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, payment, payment);
    return offered.order.order.id;
  };

  it("holds the goods to what the order was sold with, whatever the card says since", async () => {
    // The agent paid for an activation code. The merchant then republished the
    // product to deliver a licence key instead. The order already sold is
    // still owed what it was sold with, and the new shape is not that.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const soldBefore = await paidOrder(harnessed, itemId, "ONE");
    const alsoSoldBefore = await paidOrder(harnessed, itemId, "TWO");
    await published(harnessed, { ...asyncCard, result: { license_key: { type: "string" } } });

    const promised = await harnessed.gateway.deliverOrder(harnessed.merchant.id, soldBefore, {
      activation_code: "A",
    });
    const reshaped = await harnessed.gateway.deliverOrder(harnessed.merchant.id, alsoSoldBefore, {
      license_key: "K",
    });

    expect(promised?.ok).toBe(true);
    expect((await harnessed.store.orderById(soldBefore))?.order.state).toBe("delivered");
    if (reshaped?.ok !== false) throw new Error("goods the order was not sold with closed it");
    expect(reshaped.error.code).toBe("delivery_does_not_match_card");
    expect(reshaped.error.problems?.map((problem) => problem.path.join("."))).toContain(
      "activation_code",
    );
    expect((await harnessed.store.orderById(alsoSoldBefore))?.delivery).toBeNull();
  });

  it("tells a synchronous answer past its deadline that the sale is over, timer or no timer", async () => {
    // The timer that closes an overdue synchronous order can fire late. Goods
    // that fit find the purchase closed by the instant of the answer; goods
    // that do not fit must hear the same ending, and not be told to fix the
    // handler and deliver again to a sale that is already over.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    const buying = harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    expect((await harnessed.gateway.poll(harnessed.merchant.id, 200)).envelopes).toHaveLength(1);
    harnessed.advance(harnessed.runtime.config.deadlines.syncResponseMs);

    const answered = await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: {},
    });

    if (answered?.ok !== false) throw new Error("an empty handler answer closed the purchase");
    expect(answered.error.code).toBe("delivery_does_not_match_card");
    expect(answered.error.retryable).toBe(false);
    expect(answered.error.message).toContain("expired");
    expect(harnessed.facilitator.settles).toHaveLength(0);
    harnessed.advance(harnessed.runtime.config.deadlines.syncBudgetMs);
    await buying;
  });

  it("does not let a card loosened after the sale excuse goods the order was promised", async () => {
    const harnessed = await started();
    const twoFields: Card = {
      ...asyncCard,
      result: { activation_code: { type: "string" }, iccid: { type: "string" } },
    };
    const itemId = await published(harnessed, twoFields);
    const orderId = await paidOrder(harnessed, itemId, "ONE");
    await published(harnessed, asyncCard);

    const short = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "A",
    });

    if (short?.ok !== false) throw new Error("goods short of the promise closed the order");
    expect(short.error.problems?.map((problem) => problem.path.join("."))).toStrictEqual(["iccid"]);
    expect((await harnessed.store.orderById(orderId))?.delivery).toBeNull();
  });

  it("holds an order written before it kept its own promise to the card as it stands", async () => {
    // An order stored without a promise of its own is held to the card as it
    // stands, so a delivery to the current card closes it.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const { result: _kept, ...older } = offered.order;
    const oldId = "ord_written_before_the_promise";
    await harnessed.store.addOrder({ ...older, order: { ...older.order, id: oldId } });
    await harnessed.gateway.payPurchase(oldId, "OLD", "OLD");
    await published(harnessed, { ...asyncCard, result: { license_key: { type: "string" } } });

    const current = await harnessed.gateway.deliverOrder(harnessed.merchant.id, oldId, {
      license_key: "K",
    });

    expect(current?.ok).toBe(true);
    expect((await harnessed.store.orderById(oldId))?.order.state).toBe("delivered");
  });

  it("does not close an order on goods the card never promised", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const answered = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {});

    if (answered?.ok !== false) throw new Error("an empty delivery closed the order");
    expect(answered.error.code).toBe("delivery_does_not_match_card");
    expect(answered.error.message).toContain("activation_code");
    // The sentence is for a person reading a log; the findings name the field
    // for the handler that has to be fixed.
    expect(answered.error.problems?.map((problem) => problem.path.join("."))).toStrictEqual([
      "activation_code",
    ]);
    // He can fix his handler and call again; the order is still his to finish.
    expect(answered.error.retryable).toBe(true);

    // And the order itself is untouched: no goods written, no receipt, and the
    // buyer's purchase still under way rather than closed against nothing.
    const record = await harnessed.store.orderById(orderId);
    expect(record?.delivery).toBeNull();
    expect(record?.order.state).not.toBe("delivered");
    expect(await harnessed.store.receiptForOrder(orderId)).toBeNull();
  });

  it("names the first few misfits and counts the rest, rather than writing a paragraph", async () => {
    // A card may declare a dozen fields and a broken handler can miss all of
    // them. The answer has one line for the reason, so the ones it does not
    // name have to be counted: a merchant reading a log needs to tell "these
    // are the problems" from "these are some of them".
    const harnessed = await started();
    const wide: Card = {
      ...asyncCard,
      merchant_item_id: "esim-wide",
      result: Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`field_${index}`, { type: "string" }] as const),
      ),
    };
    const itemId = await published(harnessed, wide);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    const answered = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {},
    );

    if (answered?.ok !== false) throw new Error("an empty delivery closed the order");
    const named = Array.from({ length: 9 }, (_, index) => `field_${index}`).filter((field) =>
      answered.error.message.includes(field),
    );
    expect(named).toHaveLength(5);
    expect(answered.error.message).toContain("and 4 more");
  });

  it("stays a line a person can read however much the merchant sends", async () => {
    // Counting the findings is not enough: every undeclared field arrives in
    // one finding whose text lists them all, so a cap on the number of findings
    // never fires and the length is set by what the merchant sent.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    const flooded: Record<string, unknown> = { activation_code: "LPA:1$OK" };
    for (let index = 0; index < 300; index += 1) {
      flooded[`undeclared_field_number_${index}`] = "x";
    }
    const answered = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      flooded,
    );

    if (answered?.ok !== false) throw new Error("three hundred undeclared fields were delivered");
    // The guaranteed bound is about twelve hundred characters (five findings
    // of 160, a bounded card name and the fixed prose), asserted below with
    // every long thing at once. One enormous finding lands far inside it.
    expect(answered.error.message.length).toBeLessThan(400);
    // Cut short, and saying so — a reader must not mistake what is left for
    // the whole of the complaint.
    expect(answered.error.message).toContain("cut short");
    // And still useful: the first of the offending names is in there.
    expect(answered.error.message).toContain("undeclared_field_number_0");
  });

  it("does not carry a card's own identifier into the answer at whatever length it is", async () => {
    // The message names the card, and the contract puts no maximum on what a
    // merchant may call his own product.
    const harnessed = await started();
    const itemId = await published(harnessed, {
      ...asyncCard,
      merchant_item_id: `esim-${"7".repeat(5_000)}`,
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    const answered = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {},
    );

    if (answered?.ok !== false) throw new Error("an empty delivery closed the order");
    expect(answered.error.message.length).toBeLessThan(400);
    expect(answered.error.message).toContain("activation_code");
  });

  it("stays inside its bound with every long thing at once", async () => {
    // Everything a refusal quotes that has no length of its own, at its worst
    // in one message. This is the bound to read as the promise.
    const harnessed = await started();
    const itemId = await published(harnessed, {
      ...asyncCard,
      merchant_item_id: `esim-${"7".repeat(5_000)}`,
      result: Object.fromEntries(
        Array.from(
          { length: 9 },
          (_, index) => [`declared_field_with_a_long_name_${index}`, { type: "string" }] as const,
        ),
      ),
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    const everything: Record<string, unknown> = {};
    for (let index = 0; index < 300; index += 1) {
      everything[`undeclared_field_with_a_long_name_${index}`] = "x";
    }
    const answered = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      everything,
    );

    if (answered?.ok !== false) throw new Error("the worst delivery was taken");
    expect(answered.error.message.length).toBeLessThan(1_400);
    expect(answered.error.message).toContain("declared_field_with_a_long_name_0");
  });

  it("refuses a declared field of the wrong type, and a field the card never declared", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);

    const wrongType = await harnessed.gateway.beginPurchase(itemId, {});
    if (wrongType.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(wrongType.order.order.id, "ONE", "ONE");
    const numeric = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      wrongType.order.order.id,
      { activation_code: 7 },
    );
    if (numeric?.ok !== false) throw new Error("a number passed for a declared string");
    expect(numeric.error.code).toBe("delivery_does_not_match_card");
    expect(numeric.error.message).toContain("activation_code");
    expect((await harnessed.store.orderById(wrongType.order.order.id))?.delivery).toBeNull();

    // An undeclared field is refused too. The agent read this card before it
    // paid, and a delivery carrying something the card never described is a
    // delivery it cannot have been expecting.
    const extra = await harnessed.gateway.beginPurchase(itemId, {});
    if (extra.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(extra.order.order.id, "TWO", "TWO");
    const surprised = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      extra.order.order.id,
      { activation_code: "A", puk: "9999" },
    );
    if (surprised?.ok !== false) throw new Error("an undeclared field was delivered");
    expect(surprised.error.code).toBe("delivery_does_not_match_card");
    expect(surprised.error.message).toContain("puk");
    expect((await harnessed.store.orderById(extra.order.order.id))?.delivery).toBeNull();
  });

  it("holds a synchronous handler's own answer to the same card", async () => {
    // In this mode the handler's return is the delivery, so the same check has
    // to stand on this path too.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const buying = harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    expect((await harnessed.gateway.poll(harnessed.merchant.id, 200)).envelopes).toHaveLength(1);

    const answered = await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: {},
    });

    if (answered?.ok !== false) throw new Error("an empty handler answer closed the purchase");
    expect(answered.error.code).toBe("delivery_does_not_match_card");
    expect(answered.error.message).toContain("access_code");

    // Nothing was written and nothing was charged. The goods can still arrive.
    expect((await harnessed.store.orderById(orderId))?.delivery).toBeNull();
    expect(harnessed.facilitator.settles).toHaveLength(0);

    await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: { access_code: "X" },
    });
    const bought = await buying;
    expect(bought.step).toBe("settled");
    expect((await harnessed.store.orderById(orderId))?.delivery).toStrictEqual({
      access_code: "X",
    });

    // And what the buyer was handed is the same thing — measured at his own
    // door rather than in the record, because that is where it matters.
    if (bought.step !== "settled") throw new Error("the purchase did not settle");
    expect(bought.delivery).toStrictEqual({ access_code: "X" });

    // A later answer to the same order, carrying something else, leaves what he
    // holds exactly as it is.
    const again = await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: { access_code: "SOMETHING ELSE" },
    });
    expect(again).toStrictEqual({ ok: true, result: "already_delivered" });
    expect((await harnessed.store.orderById(orderId))?.delivery).toStrictEqual({
      access_code: "X",
    });
  });

  it("keeps the goods the buyer was first given, whatever a later call carries", async () => {
    // Delivery is at least once: a restarted worker, a redelivery and a
    // merchant's own retry all land the same order twice. The repeat must
    // change nothing, and its answer cannot show whether it did.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const first = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "LPA:1$FIRST",
    });
    const again = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "LPA:1$SECOND",
    });

    expect(first).toStrictEqual({ ok: true, result: "delivered" });
    expect(again).toStrictEqual({ ok: true, result: "already_delivered" });

    const kept = await harnessed.store.orderById(orderId);
    expect(kept?.delivery).toStrictEqual({ activation_code: "LPA:1$FIRST" });
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });

  it("answers a repeat as a repeat even when what it carries is nothing like the card", async () => {
    // This call could not have written anything whatever it carried, and that
    // is what the merchant is told. A refusal would be marked worth retrying on
    // an order that can never take another delivery.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "LPA:1$FIRST",
    });

    const junk = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      nothing_the_card_declared: true,
    });

    expect(junk).toStrictEqual({ ok: true, result: "already_delivered" });
    expect((await harnessed.store.orderById(orderId))?.delivery).toStrictEqual({
      activation_code: "LPA:1$FIRST",
    });
  });

  it("tells a merchant about his goods before it tells him the order is over", async () => {
    // The order is closed and the goods do not fit the card either. He is told
    // about the card, the fault in his code, and the order's state on his next
    // call; asking the machine first would mean keeping a copy of its table of
    // what a delivery does in each state.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.refuseOrder(harnessed.merchant.id, orderId, {
      code: "out_of_stock",
      message: "none",
    });
    await harnessed.gateway.runner.apply(orderId, { kind: "refund_settled", at: harnessed.now() });

    const wrongGoods = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {});
    if (wrongGoods?.ok !== false) throw new Error("an empty delivery was taken");
    expect(wrongGoods.error.code).toBe("delivery_does_not_match_card");
    // The order has ended, so there is nothing to send again — and what he sent
    // is still his to know, in the same shape as on an order that still stands.
    expect(wrongGoods.error.retryable).toBe(false);
    expect(wrongGoods.error.problems?.map((problem) => problem.path.join("."))).toStrictEqual([
      "activation_code",
    ]);

    // And once his handler is fixed, the order's own answer reaches him.
    const rightGoods = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "LPA:1$LATE",
    });
    if (rightGoods?.ok !== false) throw new Error("a settled refund took a delivery");
    expect(rightGoods.error.code).toBe("refund_already_settled");
    expect(rightGoods.error.retryable).toBe(false);
    expect((await harnessed.store.orderById(orderId))?.delivery).toBeNull();
  });

  it("leaves a delivered order alone when the repeat is the merchant's handler", async () => {
    // The other road into the same order: the worker takes it on again after
    // it closed, and its handler produces goods a second time.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "LPA:1$FIRST",
    });
    const delivered = await harnessed.store.orderById(orderId);
    const receipt = await harnessed.store.receiptForOrder(orderId);

    const again = await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: { activation_code: "LPA:1$SECOND" },
    });

    expect(again).toStrictEqual({ ok: true, result: "already_delivered" });
    const kept = await harnessed.store.orderById(orderId);
    expect(kept?.delivery).toStrictEqual({ activation_code: "LPA:1$FIRST" });
    // Nothing else moved either — not the state, not the instants on it, and
    // not the receipt the buyer already holds.
    expect(kept?.order).toStrictEqual(delivered?.order);
    expect(await harnessed.store.receiptForOrder(orderId)).toStrictEqual(receipt);
  });
});

describe("a payment the payment layer would not vouch for", () => {
  // The agent's next step differs by why the payment failed, and the refusal
  // is the only place it learns which: a payment against a stale offer — a
  // price that moved, a seller who changed where they are paid — needs a new
  // purchase, an empty wallet needs funding, a bad signature needs signing
  // again. Each refusal says nothing was charged and which of these to do.
  const cases = [
    ["price_stale", "the payment was made out to a different address", "start a new purchase"],
    ["insufficient_funds", "the wallet is empty", "fund the paying wallet"],
    ["signature", "the signature does not check out", "sign a new payment"],
  ] as const;

  for (const [reason, said, next] of cases) {
    it(`tells the agent what to do next when the reason is ${reason}`, async () => {
      const harnessed = await started();
      const itemId = await published(harnessed, asyncCard);
      harnessed.facilitator.willRefuseVerification(reason, said);
      const offered = await harnessed.gateway.beginPurchase(itemId, {});
      if (offered.step !== "pay") throw new Error("no price was offered");

      const bought = await harnessed.gateway.payPurchase(offered.order.order.id, "P", "P");

      if (bought.step !== "payment_not_verified") throw new Error("a bad payment was taken");
      expect(bought.why).toContain(said);
      expect(bought.why).toContain("nothing was charged");
      expect(bought.why).toContain(next);
    });
  }
});

describe("a refused payment's words, when the payment layer says a great deal", () => {
  it("leads with what was charged and what to do, and says the rest was shortened", async () => {
    // A facilitator's refusal can carry a contract call's whole diagnostic:
    // the function, its arguments, the authorisation's fields. Put first, it
    // buries the two things the agent needs, and those come first instead.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const diagnostic = `ContractFunctionExecutionError: transfer amount exceeds balance\n${"  args: 0x00\n".repeat(80)}`;
    harnessed.facilitator.willRefuseVerification("insufficient_funds", diagnostic);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");

    const bought = await harnessed.gateway.payPurchase(offered.order.order.id, "P", "P");

    if (bought.step !== "payment_not_verified") throw new Error("a bad payment was taken");
    expect(bought.why.indexOf("nothing was charged")).toBe(0);
    expect(bought.why.indexOf("fund the paying wallet")).toBeLessThan(80);
    expect(bought.why).toContain("transfer amount exceeds balance");
    expect(bought.why.length).toBeLessThan(400);
    expect(bought.why).toMatch(/shortened/);
  });
});

describe("a price's life", () => {
  // A price holds for a fixed time, and the timer that closes an order whose
  // price has lapsed can fire late. A payment that arrives after the price's
  // life pays for a price that no longer holds, timer or no timer: nothing is
  // verified, nothing is claimed and nothing is charged.
  it("refuses a payment that arrives once the price has lapsed, before its timer fires", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    harnessed.advance(harnessed.runtime.config.deadlines.quoteTtlMs);

    const paid = await harnessed.gateway.payPurchase(orderId, "LATE", "LATE");

    expect(paid.step).toBe("settled");
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("expired");
    expect(harnessed.facilitator.verifies).toHaveLength(0);
    expect(harnessed.facilitator.settles).toHaveLength(0);
  });

  it("checks nothing for a payment on an order its lapsed price already closed", async () => {
    // Once the order is closed — by its timer, or as here by an earlier late
    // payment — a payment for it is not checked: the check would spend the
    // payment layer's round trip and, failing, tell the agent to pay again for
    // a price that is gone.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    harnessed.advance(harnessed.runtime.config.deadlines.quoteTtlMs);
    await harnessed.gateway.payPurchase(orderId, "LATE", "LATE");
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("expired");

    const again = await harnessed.gateway.payPurchase(orderId, "LATER", "LATER");

    expect(again.step).toBe("settled");
    expect(harnessed.facilitator.verifies).toHaveLength(0);
  });

  it("checks nothing for a payment on an order that ended with nothing taken", async () => {
    // Here the merchant left while the price still held: the order is over,
    // nothing was taken and nothing is held, so a payment has nothing to buy.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.runner.apply(orderId, {
      kind: "merchant_departed",
      at: harnessed.now(),
    });
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("cancelled");

    const paid = await harnessed.gateway.payPurchase(orderId, "AFTER", "AFTER");

    expect(paid.step).toBe("settled");
    expect(harnessed.facilitator.verifies).toHaveLength(0);
  });

  it("takes a payment that arrives a moment before the price lapses", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    harnessed.advance(harnessed.runtime.config.deadlines.quoteTtlMs - 1);

    await harnessed.gateway.payPurchase(orderId, "IN-TIME", "IN-TIME");

    expect(harnessed.facilitator.settles).toHaveLength(1);
  });
});

describe("two payments racing one order", () => {
  it("gives a losing buyer their authorisation back, so it can buy something else", async () => {
    // Two agents reaching for the last unit is ordinary, and the one that
    // arrives second has done nothing wrong. The claim is taken before the
    // ownership check because it has to be in place before anything is
    // dispatched; but a presentation refused for ownership spent nothing, and
    // keeping its claim would bind a live authorisation to an order it can
    // never pay for.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);

    const first = await harnessed.gateway.beginPurchase(itemId, {});
    if (first.step !== "pay") throw new Error("the first purchase did not reach a payment");
    const firstOrder = first.order.order.id;

    const hers = authorisation(harnessed, ALICE, "0x01");
    const won = await harnessed.gateway.payPurchase(firstOrder, hers.payment, hers.fingerprint);
    expect(won.step).toBe("under_way");

    const his = authorisation(harnessed, BOB, "0x01");
    const lost = await harnessed.gateway.payPurchase(firstOrder, his.payment, his.fingerprint);
    expect(lost.step).toBe("not_this_purchase");

    // The same signature, on an order of his own, buys. Without the release it
    // is answered "already spent" and pointed at Alice's order.
    const second = await harnessed.gateway.beginPurchase(itemId, {});
    if (second.step !== "pay") throw new Error("the second purchase did not reach a payment");
    const again = await harnessed.gateway.payPurchase(
      second.order.order.id,
      his.payment,
      his.fingerprint,
    );

    expect(again.step).toBe("under_way");
  });

  it("lets exactly one own it, charges exactly one, and hands the goods to the winner alone", async () => {
    // Two verified payments for one order reach the ownership check at once.
    // If each read a stale "nobody owns it yet", both would take it, and one
    // charge would fail on a merchant who handed over goods for nothing. The
    // check reads the order under the store's lock.
    // The budget is far wider than the deadlines on purpose: it is a real wait
    // racing a real timer, and a narrow margin makes the test flaky.
    const harnessed = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "300",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "2000",
    });
    const itemId = await published(harnessed, syncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });

    // Held and released together, so what decides between the two is the
    // in-lock guard and not the order they happened to verify in.
    const hers = authorisation(harnessed, ALICE, "0x01");
    const his = authorisation(harnessed, BOB, "0x01");
    const release = harnessed.facilitator.holdVerification();
    const race = Promise.all([
      harnessed.gateway.payPurchase(orderId, hers.payment, hers.fingerprint),
      harnessed.gateway.payPurchase(orderId, his.payment, his.fingerprint),
    ]);
    for (let i = 0; i < 2_000 && harnessed.facilitator.verifies.length < 2; i += 1) {
      await Promise.resolve();
    }
    expect(harnessed.facilitator.verifies).toHaveLength(2);
    release();

    const [a, b] = await race;
    await worker.stop();

    // Without the in-lock guard both are treated as the owner and both come
    // away with the goods.
    const winners = [a, b].filter((result) => result.step === "settled");
    const refused = [a, b].filter((result) => result.step === "not_this_purchase");
    expect(winners).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const winner = winners[0];
    if (winner?.step !== "settled") throw new Error("nobody won the race");
    expect(winner.delivery).toStrictEqual({ access_code: "SESAME" });

    // One owner, one charge, and the charge was the owner's payment. The owner
    // is a wallet — the address the winning authorisation was signed from — and
    // the charge carries that authorisation itself.
    const owned = await harnessed.store.orderById(orderId);
    expect(owned?.order.state).toBe("delivered");
    expect([ALICE, BOB]).toContain(owned?.paidBy);
    expect(harnessed.facilitator.settles).toHaveLength(1);
    expect(harnessed.facilitator.settles[0]?.payment).toBe(
      owned?.paidBy === ALICE ? hers.payment : his.payment,
    );
  });

  it("does not let a stranger's failed payment stop the buyer who was issued the challenge", async () => {
    // An anonymous first payment that does not check out closes and claims
    // nothing, so a stranger cannot spend the order's life by getting there
    // first with junk.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    harnessed.facilitator.willVerify(
      { verified: false, reason: "signature", message: "not a signature at all" },
      { verified: true, payer: "buyer", validUntil: null },
    );

    const junk = await harnessed.gateway.payPurchase(orderId, "stranger", "stranger-auth");
    expect(junk.step).toBe("payment_not_verified");
    // Untouched: still open, still nobody's, and the junk claimed no fingerprint.
    const afterJunk = await harnessed.store.orderById(orderId);
    expect(afterJunk?.order.state).toBe("quoted");
    expect(afterJunk?.paidBy).toBeNull();

    const bought = await harnessed.gateway.payPurchase(orderId, "buyer", "buyer-auth");
    expect(bought.step).toBe("under_way");
    expect((await harnessed.store.orderById(orderId))?.paidBy).toBe("buyer");
    // The stranger was never charged; the buyer was, once.
    expect(harnessed.facilitator.settles).toHaveLength(1);
    expect(harnessed.facilitator.settles[0]?.payment).toBe("buyer");
  });

  it("does not make two payments that name no payer into one buyer", async () => {
    // A payment can decode perfectly and name no payer: a scheme that does not
    // sign an EIP-3009 authorisation sends only a signature, and that passes
    // the route's decode. The fingerprint then has to tell buyers apart on its
    // own; a stand-in payer would be the same every time, and the second
    // sender would be handed the first one's purchase.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const mine = paymentNamingNoPayer(harnessed);
    const theirs = paymentNamingNoPayer(harnessed);

    const bought = await harnessed.gateway.payPurchase(orderId, mine.payment, mine.fingerprint);
    expect(bought.step).toBe("under_way");

    // Somebody else's payment, equally anonymous, is not this order's.
    const meddling = await harnessed.gateway.payPurchase(
      orderId,
      theirs.payment,
      theirs.fingerprint,
    );
    expect(meddling.step).toBe("not_this_purchase");
    expect((await harnessed.store.orderById(orderId))?.paidBy).toBe(mine.fingerprint);

    // And the other half, or the rule above would be a way of locking a buyer
    // out of their own order: the same anonymous payment presented again is the
    // same buyer, because it fingerprints the same.
    const again = await harnessed.gateway.payPurchase(orderId, mine.payment, mine.fingerprint);
    expect(again.step).not.toBe("not_this_purchase");
  });

  it("does not make two payments naming a blank signer into one buyer", async () => {
    // Here the payer arrives as `""` rather than as nothing, an identity every
    // such payment would share. `walletThatPaid` turns it into nobody so the
    // fingerprint stands in, which `??` alone would not do.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const nameless = authorisation(harnessed, "", "0x01");
    const alsoNameless = authorisation(harnessed, "", "0x02");

    const took = await harnessed.gateway.payPurchase(
      orderId,
      nameless.payment,
      nameless.fingerprint,
    );
    expect(took.step).toBe("under_way");

    const meddling = await harnessed.gateway.payPurchase(
      orderId,
      alsoNameless.payment,
      alsoNameless.fingerprint,
    );
    expect(meddling.step).toBe("not_this_purchase");
  });
});

describe("the price question", () => {
  it("sells at the price the merchant names, not at the one on the card", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, livePriced(syncCard));

    const worker = workUntilStopped(harnessed, {
      onQuote: () => ({
        available: true,
        price: { amount: "95.00", currency: "USD" },
        as_of: "2026-08-26T12:00:00.000Z",
      }),
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    await worker.stop();

    if (offered.step !== "pay") throw new Error("no price was offered");
    expect(offered.order.order.price?.amount).toBe("95.00");
    expect(offered.order.order.quoteSource).toBe("merchant_answer");
  });

  it("stamps the sale price when the price was struck, not when the money moved", async () => {
    // `at` is the moment the price was fixed for this sale, here when the
    // merchant's answer came back, and not the moment of payment: the agent may
    // think for as long as it likes in between. When the money moved is on the
    // receipt under its own name.
    const harnessed = await started({ QUOTE_TTL_MS: "600000" });
    const itemId = await published(harnessed, livePriced(asyncCard));

    const worker = workUntilStopped(harnessed, {
      onQuote: () => ({
        available: true,
        price: { amount: "14.00", currency: "USD" },
        // The merchant answers out of a list published an hour before he was
        // asked, which is what keeps `as_of` a third moment rather than a copy.
        as_of: "2026-08-26T11:00:00.000Z",
      }),
    });
    const struck = harnessed.now();
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    await worker.stop();
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    harnessed.advance(90_000);
    const paid = harnessed.now();
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const record = await harnessed.store.orderById(orderId);
    if (record === null) throw new Error("the order went missing");
    const document = orderDocumentOf(record);
    expect(document.price.amount).toBe("14.00");
    expect(document.price.at).toBe(asTimestamp(struck));
    expect(document.price.as_of).toBe("2026-08-26T11:00:00.000Z");

    await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "A",
    });
    const receipt = await harnessed.store.receiptForOrder(orderId);
    expect(receipt?.price.at).toBe(asTimestamp(struck));
    expect(receipt?.paid_at).toBe(asTimestamp(paid));
  });

  it("does not price a sale off an answer it could not charge", async () => {
    // The price check keeps the card's rule: an answer of nothing is refused,
    // and the sale goes on as though nobody had answered, here at the
    // synchronous card's own published price.
    const harnessed = await started({ QUOTE_RESPONSE_MS: "50" });
    const itemId = await published(harnessed, livePriced(syncCard));

    const worker = workUntilStopped(harnessed, {
      onQuote: () => ({
        available: true,
        price: { amount: "0.00", currency: "USD" },
        as_of: "2026-08-26T12:00:00.000Z",
      }),
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    await worker.stop();

    if (offered.step !== "pay") throw new Error("no price was offered");
    expect(offered.order.order.price?.amount).toBe("80.00");
    expect(offered.order.order.quoteSource).toBe("card_snapshot");
  });

  it("still prices the sale off a corrected answer that follows a refused one", async () => {
    // A refused answer moves nothing, so the question is still open and an
    // answer the door takes, sent while we are still waiting, prices the sale.
    const harnessed = await started();
    const itemId = await published(harnessed, livePriced(syncCard));

    let refused: unknown = null;
    const worker = workUntilStopped(harnessed, {
      onQuote: async (question) => {
        refused = await harnessed.gateway.answerQuote(harnessed.merchant.id, question.price_id, {
          available: true,
          price: { amount: "95", currency: "USD" },
          as_of: "2026-08-26T12:00:00.000Z",
        });
        return {
          available: true,
          price: { amount: "95.00", currency: "USD" },
          as_of: "2026-08-26T12:00:00.000Z",
        };
      },
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    await worker.stop();

    expect(refused).toMatchObject({ refused: [{ path: ["price", "amount"] }] });
    if (offered.step !== "pay") throw new Error("no price was offered");
    expect(offered.order.order.price?.amount).toBe("95.00");
    expect(offered.order.order.quoteSource).toBe("merchant_answer");
  });

  it("does not sell what the merchant says is gone", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, livePriced(syncCard));

    const worker = workUntilStopped(harnessed, {
      onQuote: () => ({ available: false, as_of: "2026-08-26T12:00:00.000Z" }),
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    await worker.stop();

    expect(offered.step).toBe("settled");
    if (offered.step !== "settled") throw new Error("the order was not closed");
    expect(offered.order.order.state).toBe("rejected");
    expect(offered.order.order.closure).toStrictEqual({ cause: "unavailable" });
  });

  it("tells the agent why, where the merchant's price check said there is none", async () => {
    // A bare "rejected" is a product that is gone, a price check that went
    // unanswered and a charge that failed, and the agent's next step differs
    // between them. Where the ending was ours to name, the status names it,
    // in a code to branch on and a sentence that says what to do next.
    const harnessed = await started();
    const itemId = await published(harnessed, livePriced(syncCard));
    const worker = workUntilStopped(harnessed, {
      onQuote: () => ({ available: false, as_of: "2026-08-26T12:00:00.000Z" }),
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    await worker.stop();
    if (offered.step !== "settled") throw new Error("the order was not closed");

    const status = agentOrderStatusOf(
      offered.order,
      { name: null, site: null },
      harnessed.runtime.config,
    );

    expect(status.status).toBe("rejected");
    expect(status.reason?.code).toBe("unavailable");
    expect(status.reason?.message).toMatch(/\S/);
    expect(status.refusal).toBeUndefined();
  });

  it("gives a merchant's own refusal no reason of ours beside it", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ refused: { code: "out_of_stock", message: "No rooms left" } }),
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const paid = await harnessed.gateway.payPurchase(offered.order.order.id, "P", "P");
    await worker.stop();
    if (paid.step !== "settled") throw new Error("the purchase did not end");

    const status = agentOrderStatusOf(
      paid.order,
      { name: null, site: null },
      harnessed.runtime.config,
    );

    expect(status.refusal).toStrictEqual({ code: "out_of_stock", message: "No rooms left" });
    expect(status.reason).toBeUndefined();
  });

  it("sells a silent synchronous card off its own snapshot", async () => {
    // On a synchronous card the merchant's own answer still stands between the
    // price and the charge, so his silence on the price is an open failure and
    // the card's own number sells. Nobody answers here, and our patience for it
    // is one millisecond.
    const harnessed = await started({ QUOTE_RESPONSE_MS: "1" });
    const itemId = await published(harnessed, livePriced(syncCard));

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });

    if (offered.step !== "pay") throw new Error("the silent card did not sell");
    expect(offered.order.order.price?.amount).toBe("80.00");
    expect(offered.order.order.quoteSource).toBe("card_snapshot");
  });

  it("will not start an asynchronous purchase the merchant went silent on", async () => {
    // On an asynchronous card the money moves at the purchase, so selling at an
    // unknown stock level manufactures debts to buyers, and a lost sale is
    // cheaper than a debt.
    const harnessed = await started({ QUOTE_RESPONSE_MS: "1" });
    const itemId = await published(harnessed, livePriced(asyncCard));

    const offered = await harnessed.gateway.beginPurchase(itemId, {});

    expect(offered.step).toBe("settled");
    if (offered.step !== "settled") throw new Error("the order was not closed");
    expect(offered.order.order.state).toBe("rejected");
    expect(offered.order.order.closure).toStrictEqual({ cause: "quote_silent" });
  });

  it("tells a merchant whether his answer arrived in time to price the purchase", async () => {
    // A merchant who set stock aside against the question needs to know whether
    // to release it.
    const harnessed = await started();
    const itemId = await published(harnessed, livePriced(syncCard));

    let asked: string | null = null;
    const worker = workUntilStopped(harnessed, {
      onQuote: (question) => {
        asked = question.price_id;
        return {
          available: true,
          price: { amount: "95.00", currency: "USD" },
          as_of: "2026-08-26T12:00:00.000Z",
        };
      },
    });
    await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    await worker.stop();

    if (asked === null) throw new Error("nobody was asked the price");
    const late = await harnessed.gateway.answerQuote(harnessed.merchant.id, asked, {
      available: true,
      price: { amount: "10.00", currency: "USD" },
      as_of: "2026-08-26T12:00:00.000Z",
    });
    expect(late).toStrictEqual({ used: false });
  });

  it("reports the silence itself when there is no reminder to fall back on", async () => {
    // Two things notice that a price never came: the wait inside the purchase,
    // and the clock the machine armed when the order was created. They carry
    // the same fact and normally race, so this test takes the second one away
    // — the queue is told to forget its reminders — and holds the first one to
    // the same answer on its own.
    const harnessed = await started({ QUOTE_RESPONSE_MS: "10" });
    harnessed.queue.remind = async () => undefined;
    const itemId = await published(harnessed, livePriced(asyncCard));

    const offered = await harnessed.gateway.beginPurchase(itemId, {});

    expect(offered.step).toBe("settled");
    if (offered.step !== "settled") throw new Error("the order was not closed");
    expect(offered.order.order.closure).toStrictEqual({ cause: "quote_silent" });
  });

  it("tells a merchant his answer priced nothing when the order had already moved on", async () => {
    // The acknowledgement is his cue to release stock he set aside, so it says
    // whether his answer priced the sale, not whether somebody was still
    // listening: our patience can close the question a moment before his answer
    // lands, and the sale goes through at another price.
    const harnessed = await started({ QUOTE_RESPONSE_MS: "10" });
    const itemId = await published(harnessed, livePriced(syncCard));

    // Nobody answers in time, so the card's own number sells.
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("the silent card did not sell");
    expect(offered.order.order.quoteSource).toBe("card_snapshot");

    // The question is still on the stream. The merchant draws it and answers,
    // too late to have priced anything.
    const drawn = await harnessed.gateway.poll(harnessed.merchant.id, 0);
    const question = drawn.envelopes.find((envelope) => envelope.kind === "quote_request");
    if (question?.kind !== "quote_request") throw new Error("nobody was asked the price");

    const acknowledged = await harnessed.gateway.answerQuote(
      harnessed.merchant.id,
      question.payload.price_id,
      {
        available: true,
        price: { amount: "95.00", currency: "USD" },
        as_of: "2026-08-26T12:00:00.000Z",
      },
    );

    expect(acknowledged).toStrictEqual({ used: false });
    // And the sale really did go through at the other price.
    expect((await harnessed.store.orderById(offered.order.order.id))?.order.price?.amount).toBe(
      "80.00",
    );
  });

  it("tells a merchant how long his price will be honoured, not how long we will wait", async () => {
    // `expires_at` on a price question is how long the named price will be
    // honoured, not our patience for an answer: the price's life begins when
    // the answer lands. Told the shorter number, a merchant who set a unit
    // aside releases it while we are still selling against it.
    const harnessed = await started({ QUOTE_RESPONSE_MS: "500", QUOTE_TTL_MS: "60000" });
    const itemId = await published(harnessed, livePriced(asyncCard));

    const buying = harnessed.gateway.beginPurchase(itemId, {});
    const drawn = await harnessed.gateway.poll(harnessed.merchant.id, 200);
    const question = drawn.envelopes.find((envelope) => envelope.kind === "quote_request");
    if (question?.kind !== "quote_request") throw new Error("nobody was asked the price");

    const askedAt = Date.parse(question.sent_at);
    const promised = Date.parse(question.payload.expires_at) - askedAt;

    // An answer later than our patience is refused, so the latest a price can
    // still be alive is that patience plus the price's own life.
    expect(promised).toBe(500 + 60_000);

    await harnessed.gateway.answerQuote(harnessed.merchant.id, question.payload.price_id, {
      available: true,
      price: { amount: "95.00", currency: "USD" },
      as_of: new Date(askedAt).toISOString(),
    });
    await buying;
  });

  it("tells a merchant his answer priced nothing when the machine would not take it", async () => {
    // Somebody is still parked on the question, so an acknowledgement built
    // out of "was anybody listening" would say yes, while the order closed a
    // moment earlier and his price bought nothing.
    const harnessed = await started({ QUOTE_RESPONSE_MS: "500" });
    const itemId = await published(harnessed, livePriced(asyncCard));

    const buying = harnessed.gateway.beginPurchase(itemId, {});
    const drawn = await harnessed.gateway.poll(harnessed.merchant.id, 200);
    const question = drawn.envelopes.find((envelope) => envelope.kind === "quote_request");
    if (question?.kind !== "quote_request") throw new Error("nobody was asked the price");

    // The clock on our own patience gets there first and closes the order.
    const orders = await harnessed.store.orders(harnessed.merchant.id);
    const orderId = orders[0]?.order.id ?? "";
    await harnessed.gateway.runner.apply(orderId, {
      kind: "quote_silent",
      at: harnessed.now(),
    });

    const acknowledged = await harnessed.gateway.answerQuote(
      harnessed.merchant.id,
      question.payload.price_id,
      {
        available: true,
        price: { amount: "9.00", currency: "USD" },
        as_of: "2026-08-26T12:00:00.000Z",
      },
    );

    expect(acknowledged).toStrictEqual({ used: false });
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("rejected");
    await buying;
  });

  it("carries the merchant's own `as_of` into the sale price, not the gateway's clock", async () => {
    // `as_of` is the moment the price behind the sale was true, and on a
    // live-priced card that moment is the merchant's to state. Stamping the
    // gateway's clock there would claim the price was fresh at the sale. `at`,
    // the moment of purchase, is the gateway's clock.
    const merchantPricedAt = "2026-08-26T10:15:00.000Z";

    const harnessed = await started();
    const itemId = await published(harnessed, livePriced(syncCard));

    const worker = workUntilStopped(harnessed, {
      onQuote: () => ({
        available: true,
        price: { amount: "95.00", currency: "USD" },
        as_of: merchantPricedAt,
      }),
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const bought = await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await worker.stop();
    if (bought.step !== "settled") throw new Error("the purchase did not settle");

    // The purchase happened at the gateway's clock; the price behind it did not.
    const purchasedAt = asTimestamp(harnessed.now());
    expect(purchasedAt).not.toBe(merchantPricedAt);

    const document = orderDocumentOf(bought.order);
    expect(document.price.as_of).toBe(merchantPricedAt);
    expect(document.price.at).toBe(purchasedAt);

    const receipt = await harnessed.store.receiptForOrder(orderId);
    expect(receipt?.price.as_of).toBe(merchantPricedAt);
    expect(receipt?.price.at).toBe(purchasedAt);

    expect(receipt?.price.at).not.toBe(receipt?.price.as_of);
  });

  it("stamps a snapshot sale with the price's publish time, not the purchase clock", async () => {
    // A card sold from its own price carries `as_of` as the moment that price
    // was last published. That is a fact about the price, not this purchase,
    // so it stays pinned to the publish while the clock moves on to the sale.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    const publishedAt = asTimestamp(harnessed.now());

    harnessed.advance(90 * 60_000);
    const purchasedAt = asTimestamp(harnessed.now());
    expect(purchasedAt).not.toBe(publishedAt);

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    expect(offered.order.order.quoteSource).toBe("card_snapshot");

    const bought = await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await worker.stop();
    if (bought.step !== "settled") throw new Error("the purchase did not settle");

    const document = orderDocumentOf(bought.order);
    expect(document.price.as_of).toBe(publishedAt);
    expect(document.price.at).toBe(purchasedAt);

    const receipt = await harnessed.store.receiptForOrder(orderId);
    expect(receipt?.price.as_of).toBe(publishedAt);
    expect(receipt?.price.at).toBe(purchasedAt);

    expect(receipt?.price.at).not.toBe(receipt?.price.as_of);
  });
});

describe("the purchase parameters", () => {
  it("refuses what does not fit this card, and says what did not fit", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);

    const refused = await harnessed.gateway.beginPurchase(itemId, { nights: "one" });

    expect(refused.step).toBe("params_rejected");
    if (refused.step !== "params_rejected") throw new Error("bad parameters were accepted");
    expect(refused.problems[0]?.path).toStrictEqual(["nights"]);
  });

  it("has nothing to sell under an identifier nobody published", async () => {
    const harnessed = await started();
    expect((await harnessed.gateway.beginPurchase("item_nope", {})).step).toBe("no_such_item");
  });
});

describe("the worker's stream", () => {
  it("answers a poll in the shape the contract publishes, and names the dialect", async () => {
    // The version rides on the call every worker makes first and then forever,
    // which is the difference between failing at startup and failing on
    // somebody's first order.
    const harnessed = await started();
    const answered = await harnessed.gateway.poll(harnessed.merchant.id, 0);

    expect(WorkerPollResponseSchema.safeParse(answered).success).toBe(true);
    expect(answered.envelopes).toStrictEqual([]);
  });

  it("hands an order over and records that it went out", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    const drawn = await harnessed.gateway.poll(harnessed.merchant.id, 0);

    expect(drawn.envelopes).toHaveLength(1);
    const record = await harnessed.store.orderById(offered.order.order.id);
    expect(record?.order.state).toBe("dispatched");
    expect(record?.order.dispatch.attempts).toBe(1);
  });

  it("does not hand out an order whose purchase is already over", async () => {
    // Queued, then closed before anybody drew it. Handing it to a handler would
    // ask a merchant to work on a purchase that no longer exists.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.refuseOrder(harnessed.merchant.id, orderId, {
      code: "out_of_stock",
      message: "none",
    });
    await harnessed.gateway.runner.apply(orderId, { kind: "refund_settled", at: harnessed.now() });

    const drawn = await harnessed.gateway.poll(harnessed.merchant.id, 0);

    expect(drawn.envelopes.filter((e) => e.kind === "order")).toStrictEqual([]);
  });

  it("holds a poll open until something arrives", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const parked = harnessed.gateway.poll(harnessed.merchant.id, 1_000);

    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    expect((await parked).envelopes).toHaveLength(1);
  });

  it("hands an event over once, and never again if the batch it went in is lost", async () => {
    // Unlike an order, an event is finished the moment it is handed into a
    // batch: nothing acknowledges it and nothing redelivers it, so a lost batch
    // loses the event, here a debt to a buyer who paid and has no goods. The
    // recovery is the list of open orders, which carries the debt whether the
    // event arrived or not.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.refuseOrder(harnessed.merchant.id, orderId, {
      code: "out_of_stock",
      message: "the supplier has none",
    });

    // These polls stand for the poll responses that were drawn and never
    // arrived — answered by nobody, which is all an event ever gets.
    const drawn = await drawEverything(harnessed);
    expect(
      drawn.flatMap((each) => (each.kind === "order_event" ? [each.payload.type] : [])),
    ).toStrictEqual(["order.refund_due"]);

    harnessed.advance(60_000);
    expect((await harnessed.gateway.poll(harnessed.merchant.id, 50)).envelopes).toStrictEqual([]);

    // What the merchant can still find out for himself.
    const owing = await harnessed.gateway.orders(harnessed.merchant.id, true);
    expect(owing.map((held) => held.order.id)).toStrictEqual([orderId]);
    expect(owing[0]?.order.state).toBe("refund_due");
  });

  it("hands nobody an order the late answer already closed", async () => {
    // A handler that answers after the handler-answer wait already has a
    // redelivery queued behind it. Its late answer is taken and closes the
    // order. Deliveries stay at least once and a genuine race can still repeat
    // one, but the gateway must not send a repeat while knowing the order is
    // closed.
    const harnessed = await started({
      HANDLER_ANSWER_MS: "20",
      REDELIVERY_BASE_DELAY_MS: "20",
      SYNC_RESPONSE_MS: "2000",
      SETTLE_RESPONSE_MS: "500",
      SYNC_BUDGET_MS: "3000",
    });
    const itemId = await published(harnessed, syncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    // The agent's call parks while the merchant works.
    const buying = harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const handed = await harnessed.gateway.poll(harnessed.merchant.id, 1_000);
    expect(handed.envelopes.filter((each) => each.kind === "order")).toHaveLength(1);

    // Wait until the redelivery is queued: with none waiting, a poll that
    // hands out nothing proves nothing.
    await vi.waitFor(
      async () =>
        expect(await harnessed.queue.holdsOrder(harnessed.merchant.id, orderId)).toBe(true),
      { timeout: 2_000, interval: 5 },
    );

    // The handler's answer arrives anyway and is taken: the goods go to the
    // buyer and the charge goes through.
    await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: { access_code: "SESAME" },
    });
    const bought = await buying;
    expect(bought.step).toBe("settled");
    if (bought.step !== "settled") throw new Error(`the purchase came back ${bought.step}`);
    expect(bought.order.order.state).toBe("delivered");

    // The redelivery's turn. Nobody is handed a purchase that is over, and the
    // envelope is finished rather than left circling.
    const again = await harnessed.gateway.poll(harnessed.merchant.id, 200);

    expect(again.envelopes.filter((each) => each.kind === "order")).toStrictEqual([]);
    expect(await harnessed.queue.holdsOrder(harnessed.merchant.id, orderId)).toBe(false);
  });
});

describe("the merchant's calls", () => {
  it("tells a synchronous merchant that delivering separately is not his call", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    // The purchase is left open on purpose: the separate call only means
    // anything while the order is still with the merchant.
    const buying = harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    expect((await harnessed.gateway.poll(harnessed.merchant.id, 200)).envelopes).toHaveLength(1);

    const refused = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      access_code: "X",
    });
    expect(refused?.ok).toBe(false);
    if (refused?.ok !== false) throw new Error("the call was taken");
    expect(refused.error.code).toBe("not_applicable_in_mode");
    expect(refused.error.retryable).toBe(false);

    // The handler's own answer is the delivery here, and it closes the purchase.
    await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: { access_code: "X" },
    });
    expect((await buying).step).toBe("settled");
  });

  it("tells a synchronous merchant that taking the order on is not an answer of his mode", async () => {
    // What his SDK posts when a synchronous handler returns `accepted`. A
    // success here is a sale the merchant writes down as under way while the
    // order runs out its seconds with nothing sold; the refusal is what his
    // problem handler shows him instead.
    const harnessed = await started({
      // Short enough that the purchase ends inside the test, and a silence
      // would be noticed long before it does.
      HANDLER_ANSWER_MS: "20",
      SYNC_RESPONSE_MS: "200",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "2000",
    });
    const itemId = await published(harnessed, syncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const buying = harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    expect((await harnessed.gateway.poll(harnessed.merchant.id, 200)).envelopes).toHaveLength(1);

    const refused = await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      accepted: {},
    });
    expect(refused?.ok).toBe(false);
    if (refused?.ok !== false) throw new Error("the acceptance was taken");
    expect(refused.error.code).toBe("not_applicable_in_mode");
    expect(refused.error.retryable).toBe(false);

    // What the agent sees: the purchase ends at its deadline and nothing is
    // charged.
    const bought = await buying;
    if (bought.step !== "settled") throw new Error(`the purchase came back ${bought.step}`);
    expect(bought.order.order.state).toBe("expired");
    expect(harnessed.facilitator.settles).toHaveLength(0);
  });

  it("does not tell a merchant a live order is closed", async () => {
    // The contract promises "order_already_closed" means an ending no call
    // reopens, so a live order in the wrong state is refused under another
    // code.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");

    const refused = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {
        activation_code: "A",
      },
    );

    expect(refused?.ok).toBe(false);
    if (refused?.ok !== false) throw new Error("the call was taken");
    expect(refused.error.code).toBe("event_not_applicable");
    expect(refused.error.message).toContain("quoted");

    // And an order that really is closed still says so, under the code the
    // contract promises means exactly that.
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
    await harnessed.gateway.deliverOrder(harnessed.merchant.id, offered.order.order.id, {
      activation_code: "A",
    });
    const closed = await harnessed.gateway.refuseOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {
        code: "out_of_stock",
        message: "too late",
      },
    );
    if (closed?.ok !== false) throw new Error("a closed order took the call");
    expect(closed.error.code).toBe("order_already_closed");
  });

  it("has nothing to answer about an order that does not exist", async () => {
    const harnessed = await started();
    expect(
      await harnessed.gateway.deliverOrder(harnessed.merchant.id, "ord_nope", { a: "b" }),
    ).toBeNull();
    expect(await harnessed.gateway.acceptOrder(harnessed.merchant.id, "ord_nope", {})).toBeNull();
  });

  it("answers an acceptance on the answer route with the word for a successful one", async () => {
    // The SDK posts every handler answer to this route and relays anything that
    // is not ok:true to the merchant as a problem, so an acceptance answered as
    // a failure reports "something went wrong" on an order that is going
    // through.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.poll(harnessed.merchant.id, 0);

    const answered = await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      accepted: {},
    });

    expect(answered).toStrictEqual({ ok: true, result: "accepted" });
    // And the acceptance itself landed.
    expect((await harnessed.store.orderById(orderId))?.order.dispatch.accepted).toBe(true);

    // The call written for acceptances keeps its wordless success: it can only
    // ever mean the one thing, so there is nothing for a word to tell apart.
    expect(await harnessed.gateway.acceptOrder(harnessed.merchant.id, orderId, {})).toStrictEqual({
      ok: true,
    });
  });

  it("answers an acceptance of a delivered order with the state it is in", async () => {
    // Deliveries are at least once, so a worker takes a closed order on again
    // as a matter of course. "Accepted" would claim the goods are still owed;
    // he is told there is nothing left to deliver.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.poll(harnessed.merchant.id, 0);
    await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, { accepted: {} });
    await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, { activation_code: "A" });
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("delivered");

    expect(
      await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, { accepted: {} }),
    ).toStrictEqual({
      ok: true,
      result: "already_delivered",
    });
  });

  it("still takes an order on that is owed a refund, because the goods still close it", async () => {
    // Goods that arrive before the refund close the debt instead, so an
    // acceptance here takes on work that still exists, odd as that looks from
    // the merchant who refused. The fixture reaches the debt by a refusal; the
    // expiry path promises the same.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await workOnce(harnessed, { onOrder: () => ({ accepted: {} }) });
    await harnessed.gateway.refuseOrder(harnessed.merchant.id, orderId, {
      code: "out_of_stock",
      message: "none",
    });
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("refund_due");

    expect(
      await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, { accepted: {} }),
    ).toStrictEqual({
      ok: true,
      result: "accepted",
    });
  });
});

describe("the claims on payments", () => {
  it("forgets the ones too old to be guarding anything, and keeps the rest", async () => {
    // A claim covers the window between a payment being verified and the charge
    // being executed; after that the token itself refuses the same
    // authorisation. They cannot be kept forever — the route that makes them
    // takes no key — and they cannot be thrown away early either, or the guard
    // is off for every payment presented since the last sweep.
    const harnessed = await started({ CLAIM_RETENTION_MS: "60000" });
    const itemId = await published(harnessed, asyncCard);

    const old = await harnessed.gateway.beginPurchase(itemId, {});
    if (old.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(old.order.order.id, "OLD", "OLD");

    harnessed.advance(90_000);

    const fresh = await harnessed.gateway.beginPurchase(itemId, {});
    if (fresh.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(fresh.order.order.id, "FRESH", "FRESH");

    expect(await harnessed.gateway.forgetOldClaims()).toBe(1);

    // The old payment is nobody's again; the fresh one is still spoken for.
    const takingOld = await harnessed.gateway.beginPurchase(itemId, {});
    const takingFresh = await harnessed.gateway.beginPurchase(itemId, {});
    if (takingOld.step !== "pay" || takingFresh.step !== "pay") {
      throw new Error("no price was offered");
    }
    expect(
      (await harnessed.gateway.payPurchase(takingOld.order.order.id, "OLD", "OLD")).step,
    ).not.toBe("payment_already_spent");
    expect(
      (await harnessed.gateway.payPurchase(takingFresh.order.order.id, "FRESH", "FRESH")).step,
    ).toBe("payment_already_spent");
  });
});

describe("an order sent out again", () => {
  it("carries the instant of this delivery, under the identifier of the same message", async () => {
    // An envelope drawn and handed to nobody goes back with its identifier,
    // since no worker has seen it, but with a fresh stamp. This is not how a
    // worker recognises a repeat: a redelivery the gateway decides on is a
    // fresh envelope with a fresh identifier, and two attempts share only the
    // order they carry.
    const harnessed = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "400",
      SETTLE_RESPONSE_MS: "300",
      SYNC_BUDGET_MS: "700",
      SETTLE_IN_FLIGHT_RETRY_MS: "5",
    });
    const itemId = await published(harnessed, syncCard);
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "still asking" });

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    // The handler answers, which sends the order into its charge — and the
    // charge does not report back, so the order sits there mid-settle. The
    // machine answers nothing else while that is true.
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const buying = harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await vi.waitFor(
      async () =>
        expect((await harnessed.store.orderById(orderId))?.order.payment).toBe("settling"),
      { timeout: 2_000, interval: 5 },
    );
    await worker.stop();

    // The same order comes round again while the charge is in flight.
    const stale = "2020-01-01T00:00:00.000Z";
    const record = await harnessed.store.orderById(orderId);
    if (record === null) throw new Error("the order went missing");
    await harnessed.queue.publish(harnessed.merchant.id, {
      kind: "order",
      id: "env_the_same_message",
      sent_at: stale,
      payload: orderDocumentOf(record),
    });

    // The poll hands it to nobody — the machine will not take the hand-over
    // yet — and puts it back on the stream instead of dropping it.
    expect((await harnessed.gateway.poll(harnessed.merchant.id, 0)).envelopes).toStrictEqual([]);

    harnessed.advance(60_000);
    const back = await harnessed.queue.draw(harnessed.merchant.id, 10, 500);

    expect(back).toHaveLength(1);
    expect(back[0]?.envelope.id).toBe("env_the_same_message");
    expect(back[0]?.envelope.sent_at).not.toBe(stale);

    await buying;
  });
});

describe("the merchant's list of orders", () => {
  it("shows the ones still owed something apart from everything", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const first = await harnessed.gateway.beginPurchase(itemId, {});
    const second = await harnessed.gateway.beginPurchase(itemId, {});
    if (first.step !== "pay" || second.step !== "pay") throw new Error("no price was offered");

    await harnessed.gateway.payPurchase(first.order.order.id, "PAYMENT", "PAYMENT");
    await harnessed.gateway.deliverOrder(harnessed.merchant.id, first.order.order.id, {
      activation_code: "A",
    });
    // A second authorisation. Reusing the first would leave this order unpaid,
    // and an unpaid quote is not what this list is for.
    await harnessed.gateway.payPurchase(second.order.order.id, "PAYMENT-2", "PAYMENT-2");

    expect(await harnessed.gateway.orders(harnessed.merchant.id, undefined)).toHaveLength(2);
    expect(
      (await harnessed.gateway.orders(harnessed.merchant.id, true)).map((o) => o.order.id),
    ).toStrictEqual([second.order.order.id]);
  });

  it("does not put an unpaid quote beside an order the merchant has taken on", async () => {
    // A restarted worker walks this list to find what it still owes. An order
    // that was priced and never paid never reached the handler; delivering
    // against it makes goods for a purchase that did not happen. The buyer's
    // word for that order stays `in_progress` — the purchase is not finished —
    // and that word is not an instruction to the merchant.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const unpaid = await harnessed.gateway.beginPurchase(itemId, {});
    const taken = await harnessed.gateway.beginPurchase(itemId, {});
    if (unpaid.step !== "pay" || taken.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(taken.order.order.id, "PAYMENT-TAKEN", "PAYMENT-TAKEN");
    expect(
      await harnessed.gateway.acceptOrder(harnessed.merchant.id, taken.order.order.id, {}),
    ).toStrictEqual({ ok: true });

    const openIds = (await harnessed.gateway.orders(harnessed.merchant.id, true)).map(
      (held) => held.order.id,
    );

    expect(openIds).toContain(taken.order.order.id);
    expect(openIds).not.toContain(unpaid.order.order.id);
    const stillThere = await harnessed.gateway.merchantOrder(
      harnessed.merchant.id,
      unpaid.order.order.id,
    );
    expect(stillThere).not.toBeNull();
    expect(outcomeFor(stillThere?.order ?? taken.order.order)).toBe("in_progress");
  });
});

describe("the test mark on an order and its receipt", () => {
  /** One whole synchronous sale on a gateway configured this way. */
  const soldOn = async (overrides: Record<string, string>, transaction?: string) => {
    const harnessed = await started(overrides);
    if (transaction !== undefined) {
      harnessed.facilitator.willSettle({ settled: true, transaction });
    }
    const itemId = await published(harnessed, syncCard);

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const bought = await harnessed.gateway.payPurchase(
      offered.order.order.id,
      "PAYMENT",
      "PAYMENT",
    );
    await worker.stop();
    if (bought.step !== "settled") throw new Error("the purchase did not settle");

    return {
      order: bought.order.order,
      receipt: await harnessed.store.receiptForOrder(offered.order.order.id),
    };
  };

  it("names on the receipt the transfer the payment layer reported", async () => {
    const sold = await soldOn({ PAYMENT_NETWORK: "eip155:84532" });

    expect(sold.receipt?.transaction).toBe("0xtx1");
  });

  it("leaves the transfer off a receipt where the payment layer named it with nothing", async () => {
    // A receipt the contract refuses would break the merchant's whole list of
    // receipts, not just this one.
    const sold = await soldOn({ PAYMENT_NETWORK: "eip155:84532" }, " ");

    expect(sold.receipt).not.toBeNull();
    expect(ReceiptSchema.safeParse(sold.receipt).success).toBe(true);
    expect(sold.receipt?.transaction).toBeUndefined();
  });

  it("is true on a test environment", async () => {
    const sold = await soldOn({ PAYMENT_NETWORK: "eip155:84532" });

    expect(sold.order.test).toBe(true);
    expect(sold.receipt?.test).toBe(true);
  });

  it("is false on a live one", async () => {
    // `test: false` tells somebody else's agent that the money moved. The
    // harness wires the scripted facilitator whatever the configuration names,
    // so this checks the derivation and settles nothing.
    const sold = await soldOn({
      PAYMENT_NETWORK: "eip155:8453",
      FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
      CDP_API_KEY_ID: "key-id",
      CDP_API_KEY_SECRET: "secret",
    });

    expect(sold.order.test).toBe(false);
    expect(sold.receipt?.test).toBe(false);
  });
});

describe("a poll on a key revoked before it was held", () => {
  it("takes no order, even though the door let it in", async () => {
    // The door resolves the key and the poll is held a moment later. A key
    // revoked in that moment has no held poll to end, and the poll would draw
    // for its whole window on a key the merchant had just cut off.
    const harnessed = await started();
    const coded = await published(harnessed, asyncCard);
    await harnessed.disableKey(harnessed.merchant.keyId);

    const held = harnessed.gateway.poll(harnessed.merchant.id, 2_000, {
      keyId: harnessed.merchant.keyId,
    });
    const offered = await harnessed.gateway.beginPurchase(coded, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    expect((await held).envelopes).toStrictEqual([]);
    expect((await harnessed.gateway.poll(harnessed.merchant.id, 0)).envelopes).toHaveLength(1);
  });
});

describe("a merchant's standing in one read", () => {
  /** What the separate reads say about the harness's merchant now. */
  const separately = async (harnessed: Harness) => {
    const id = harnessed.merchant.id;
    const integration = await harnessed.gateway.integrationOf(id);
    return {
      selling: integration.selling,
      through: integration.through,
      sellerName: (await harnessed.gateway.sellerName(id)).seller_name,
      payoutWallet: (await harnessed.gateway.payoutWallet(id)).payout_wallet,
      liveApproved: await harnessed.gateway.liveApproved(id),
    };
  };

  it("says what the separate reads say, before and after the selling, the integration, the name and the approval change", async () => {
    const harnessed = await started();
    const id = harnessed.merchant.id;
    expect(await harnessed.gateway.standingOf(id)).toStrictEqual(await separately(harnessed));

    await harnessed.gateway.setSelling(id, "paused");
    await harnessed.gateway.sellThrough(id, "woocommerce");
    await harnessed.gateway.setSellerName(id, { seller_name: "Another name" });
    await harnessed.store.grantLiveApproval(id, harnessed.now());

    const changed = await harnessed.gateway.standingOf(id);
    expect(changed).toStrictEqual(await separately(harnessed));
    expect(changed).toMatchObject({
      selling: "paused",
      through: "woocommerce",
      sellerName: "Another name",
      liveApproved: true,
    });
  });

  it("reads the merchant's own row and nothing else, however many cards they have", async () => {
    const harnessed = await started();
    await published(harnessed, syncCard);
    const read: string[] = [];
    const store = harnessed.store as unknown as Record<string, (...asked: unknown[]) => unknown>;
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(harnessed.store))) {
      const method = store[name];
      if (name === "constructor" || typeof method !== "function") continue;
      store[name] = (...asked) => {
        read.push(name);
        return method.apply(harnessed.store, asked);
      };
    }

    await harnessed.gateway.standingOf(harnessed.merchant.id);

    expect(read).toStrictEqual(["merchantById"]);
  });
});

describe("one integration at a time", () => {
  // A merchant sells through their own code or through a WooCommerce shop the
  // dashboard connected, and a card of the other one is off sale. Selling both
  // ways at once would let the code's worker draw a paid order for a product
  // imported from the shop, which the shop would never hear of.
  const fromTheShop: Card = { ...asyncCard, merchant_item_id: "woo-mug", title: "A mug" };

  const onTheShop = async (harnessed: Harness): Promise<string> => {
    expect(await harnessed.gateway.sellThrough(harnessed.merchant.id, "woocommerce")).toStrictEqual(
      { switched: true, sellingPaused: false },
    );
    const result = await harnessed.gateway.publishCard(
      harnessed.merchant.id,
      fromTheShop,
      "woocommerce",
    );
    if (!result.ok) throw new Error(`importing failed: ${JSON.stringify(result.error.problems)}`);
    return result.id;
  };

  it("hands the code no order of the shop's, and sells none of the code's cards", async () => {
    const harnessed = await started();
    const coded = await published(harnessed, asyncCard);
    const imported = await onTheShop(harnessed);

    expect((await harnessed.gateway.catalog()).items.map((item) => item.id)).toStrictEqual([
      imported,
    ]);
    expect((await harnessed.gateway.beginPurchase(coded, {})).step).toBe("not_selling");

    const offered = await harnessed.gateway.beginPurchase(imported, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    const id = harnessed.merchant.id;
    expect((await harnessed.gateway.poll(id, 0)).envelopes).toStrictEqual([]);
    const shop = await harnessed.gateway.poll(id, 0, { through: "woocommerce" });
    expect(shop.envelopes.map((envelope) => envelope.payload)).toMatchObject([
      { id: offered.order.order.id },
    ]);
  });

  it("refuses a publish through the integration not in use, and says which it is", async () => {
    const harnessed = await started();
    await onTheShop(harnessed);

    const coded = await harnessed.gateway.publishCard(harnessed.merchant.id, syncCard);

    expect(PublishResultSchema.safeParse(coded).success).toBe(true);
    if (coded.ok) throw new Error("the code published while the shop sells");
    expect(coded.error.code).toBe(CARD_REJECTED);
    expect(coded.error.retryable).toBe(false);
    expect(coded.error.problems.map((problem) => problem.code)).toStrictEqual([
      "sells_through_a_shop",
    ]);
    expect(await harnessed.store.cards(harnessed.merchant.id)).toHaveLength(1);

    await harnessed.gateway.sellThrough(harnessed.merchant.id, "api");
    const imported = await harnessed.gateway.publishCard(
      harnessed.merchant.id,
      { ...fromTheShop, merchant_item_id: "woo-plate" },
      "woocommerce",
    );
    if (imported.ok) throw new Error("the shop published while the code sells");
    expect(imported.error.problems.map((problem) => problem.code)).toStrictEqual([
      "sells_through_their_code",
    ]);
  });

  it("keeps a card with what first published it, and says so at its identifier", async () => {
    const harnessed = await started();
    await onTheShop(harnessed);
    await harnessed.gateway.sellThrough(harnessed.merchant.id, "api");

    const taken = await harnessed.gateway.publishCard(harnessed.merchant.id, fromTheShop);

    if (taken.ok) throw new Error("the code took over the shop's card");
    expect(taken.error.problems.map((problem) => [problem.path, problem.code])).toStrictEqual([
      [["merchant_item_id"], "published_by_the_other_integration"],
    ]);
    const [card] = await harnessed.store.cards(harnessed.merchant.id);
    expect(card?.integration).toBe("woocommerce");
  });

  it("takes no order for a card whose merchant switches as the order is made", async () => {
    // The word an order is born under is read a moment before the order is
    // written. A switch landing in that moment would leave an order of the
    // integration just left, which nothing draws any more.
    const harnessed = await started();
    const coded = await published(harnessed, asyncCard);
    const { store } = harnessed;
    const write = store.addOrder.bind(store);
    store.addOrder = async (record, through) => {
      await store.switchIntegration(harnessed.merchant.id, "woocommerce");
      return await write(record, through);
    };

    const offered = await harnessed.gateway.beginPurchase(coded, {});

    expect(offered.step).toBe("not_selling");
    expect(await store.orders(harnessed.merchant.id)).toStrictEqual([]);
  });

  it("ends a poll held open across the switch with nothing", async () => {
    // Held open from before, the code's poll would draw whatever arrived in
    // its window — the shop's first order included.
    const harnessed = await started();
    const startedAt = performance.now();
    const held = harnessed.gateway.poll(harnessed.merchant.id, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await harnessed.gateway.sellThrough(harnessed.merchant.id, "woocommerce");

    expect((await held).envelopes).toStrictEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it("answers the integration not in use after the poll's window, not at once", async () => {
    // A worker polls again as soon as it is answered empty, and answered at
    // once a connector whose merchant sells through their code would spin.
    const harnessed = await started();
    const startedAt = performance.now();

    const answered = await harnessed.gateway.poll(harnessed.merchant.id, 300, {
      through: "woocommerce",
    });

    expect(answered.envelopes).toStrictEqual([]);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(250);
  });

  it("names the orders that still wait on the integration being left", async () => {
    const harnessed = await started();
    const coded = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(coded, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    expect(await harnessed.gateway.sellThrough(harnessed.merchant.id, "woocommerce")).toStrictEqual(
      { switched: false, waiting: [offered.order.order.id] },
    );
    expect(await harnessed.gateway.sellsThrough(harnessed.merchant.id)).toBe("api");
  });

  it("brings the code's cards back with selling stopped, and the shop's off sale", async () => {
    const harnessed = await started();
    await published(harnessed, asyncCard);
    await onTheShop(harnessed);

    expect(await harnessed.gateway.sellThrough(harnessed.merchant.id, "api")).toStrictEqual({
      switched: true,
      sellingPaused: true,
    });

    const cards = await harnessed.gateway.merchantCards(harnessed.merchant.id);
    expect(cards.selling).toBe("paused");
    expect((await harnessed.gateway.catalog()).items).toStrictEqual([]);
    await harnessed.gateway.setSelling(harnessed.merchant.id, "open");
    expect((await harnessed.gateway.catalog()).items.map((item) => item.fulfillment)).toHaveLength(
      1,
    );
    expect(
      (await harnessed.gateway.merchantCards(harnessed.merchant.id)).cards.map((card) => [
        card.card.merchant_item_id,
        card.selling,
      ]),
    ).toStrictEqual([
      ["esim-7d", "open"],
      ["woo-mug", "paused"],
    ]);
  });
});

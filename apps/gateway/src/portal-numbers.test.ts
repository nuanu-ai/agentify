/**
 * Every number the portal names, held to the configuration default it mirrors.
 * The merchant's own sentences are read out of the markdown and compared with
 * `loadConfig` given nothing but the database, which is the deployment the
 * portal describes. It sits beside `config.ts` because that is where a deadline
 * is changed.
 *
 * A pin quotes enough of the sentence around its number to fail when the
 * sentence is rewritten, rather than match some other "five" on the page: the
 * pages say "five seconds" about a merchant's own supplier and "at most five"
 * about tags, and neither is ours. Every occurrence is checked, so two
 * paragraphs cannot disagree. A route description in the contract's route
 * table that names one of these numbers is held the same way, read from the
 * description itself.
 *
 * The commission is held to the payout split the configuration names. It is
 * published beyond the portal as well, so a page outside it that names the
 * rate, a doc comment or a README among them, is read from its own file in
 * the same way.
 */

import { readFileSync } from "node:fs";
import { API_ROUTES, PayoutWalletSchema } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import type { PayoutSplitNetwork } from "./split/networks.js";

const repoRoot = new URL("../../../", import.meta.url);

/**
 * A page with its line wrapping collapsed, so that a pin can quote a sentence
 * the portal wraps across two lines.
 */
const pageText = (file: string): string => {
  const text = readFileSync(new URL(file, repoRoot), "utf8");
  // A doc comment wraps its sentence across lines that each open on an asterisk.
  const prose = /\.tsx?$/.test(file) ? text.replace(/\n[ \t]*\*(?!\/)[ \t]?/g, "\n") : text;
  return prose.replace(/\s+/g, " ");
};

/** The numbers the portal spells out, as it spells them. */
const NUMBER_WORDS: Record<string, number> = {
  three: 3,
  five: 5,
  fifteen: 15,
  eight: 8,
  ten: 10,
  twenty: 20,
  thirty: 30,
};

/** The stretches of time the portal names instead of counting seconds. */
const PERIOD_MS: Record<string, number> = { hour: 3_600_000, day: 86_400_000 };

/** What kind of quantity the captured word is. */
type Reads = "seconds" | "count" | "period" | "percent";

/** A percentage as the pages write it: digits, and a decimal part where there is one. */
const PERCENT = /^\d+(?:\.\d+)?$/;

/**
 * The number a captured word stands for, in the unit the configuration keeps.
 * Prose spells its numbers out and a drawing writes them in digits ("30 s"),
 * and both are read. A word it cannot read (say "nine") throws rather than
 * skips, or the pin would pass on a page saying anything at all. Case is
 * forgiven, because a sentence that opens on its number capitalises it. A
 * percentage is read in parts of a million, the unit a split's allocations add
 * up to.
 */
function quantityOf(written: string, reads: Reads): number {
  const word = written.toLowerCase();

  if (reads === "percent") {
    if (!PERCENT.test(word)) {
      throw new Error(
        `the page now writes the percentage as "${written}", which this test cannot read; write it in digits, as "0.1"`,
      );
    }
    return Math.round(Number(word) * 10_000);
  }

  if (reads === "period") {
    const ms = PERIOD_MS[word];
    if (ms === undefined) {
      throw new Error(
        `the portal now writes the period as "${written}", which this test cannot read; add it to PERIOD_MS or write it the way the portal writes periods`,
      );
    }
    return ms;
  }

  const value = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word];
  if (value === undefined) {
    throw new Error(
      `the portal now writes the number as "${written}", which this test cannot read; add it to NUMBER_WORDS or spell it the way the portal spells numbers`,
    );
  }

  return reads === "seconds" ? value * 1_000 : value;
}

/** Every number the anchor captures on the page, in the order they are written. */
function capturedBy(page: string, anchor: RegExp): string[] {
  const global = new RegExp(anchor.source, `${anchor.flags.replace("g", "")}g`);
  return [...page.matchAll(global)].map((match) => match[1] ?? "");
}

interface Pin {
  /** The promise this sentence makes to its reader. */
  readonly what: string;
  /** Where the sentence is published, and the file it is read from when `text` is absent. */
  readonly page: string;
  /**
   * The published text itself, for a sentence that lives somewhere other than a
   * page of the portal — a description in the contract's route table.
   */
  readonly text?: string;
  /** The sentence, with the number as its one capture group. */
  readonly anchor: RegExp;
  readonly reads: Reads;
  /** The configuration default the sentence has to be quoting. */
  readonly is: number;
}

const config = loadConfig({
  DATABASE_URL: "postgres://agentify:secret@localhost:5432/agentify",
});
const { deadlines, redelivery } = config;

/** Agentify's share of every payment on one network, in parts of a million. */
const commissionOf = (split: PayoutSplitNetwork): number =>
  (split.commissionAllocation * 1_000_000) / split.totalAllocation;

const commission = commissionOf(config.payoutSplit);
const merchantShare = 1_000_000 - commission;

/** Where a sentence is published, as a pin names it. */
type Where = Pick<Pin, "page" | "text">;

const NUMBER = String.raw`\d+(?:\.\d+)?`;
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One pin for each share a sentence names, written as the page writes it with
 * `{merchant}` and `{agentify}` where the two percentages stand. A pin holds
 * one of them and matches the other as any number, so it still quotes the
 * whole sentence.
 */
function sharesIn(what: string, where: Where, sentence: string): Pin[] {
  const pieces = sentence.split(/\{(merchant|agentify)\}/);
  const shareAt = pieces.flatMap((_, at) => (at % 2 === 1 ? [at] : []));
  return shareAt.map((held) => {
    const whose = pieces[held] === "merchant" ? "merchant" : "agentify";
    const source = pieces
      .map((piece, at) => (at % 2 === 0 ? literal(piece) : at === held ? `(${NUMBER})` : NUMBER))
      .join("");
    return {
      what: `${what}: ${whose === "merchant" ? "the merchant's share" : "Agentify's share"}`,
      ...where,
      anchor: new RegExp(source),
      reads: "percent",
      is: whose === "merchant" ? merchantShare : commission,
    };
  });
}

/**
 * The numbers the drawing of one purchase states: in its notes, in digits, and
 * in the description a screen reader reads aloud, in words. The guide and
 * Orders each carry a copy of the drawing, and each copy is held, so a changed
 * deadline fails here and not only for want of a fresh drawing. A line break
 * inside a note is written `<br/>`.
 */
const purchaseDrawingPins = (page: string): Pin[] => [
  {
    what: "how long a price question waits, in the purchase drawing",
    page,
    anchor: /Y-->>G: a price, or none \((\d+) s\)/,
    reads: "seconds",
    is: deadlines.quoteResponseMs,
  },
  {
    what: "the same wait, in the purchase drawing read aloud",
    page,
    anchor: /Agentify asks your process the price and waits (\w+) seconds/,
    reads: "seconds",
    is: deadlines.quoteResponseMs,
  },
  {
    what: "how long a price holds, in the purchase drawing",
    page,
    anchor: /Note over A,G: the price holds (\d+) s\b/,
    reads: "seconds",
    is: deadlines.quoteTtlMs,
  },
  {
    what: "the same, in the purchase drawing read aloud",
    page,
    anchor: /and the price holds (\w+) seconds/,
    reads: "seconds",
    is: deadlines.quoteTtlMs,
  },
  {
    what: "how long a synchronous hand-over waits, in the purchase drawing",
    page,
    anchor: /Y-->>G: the goods \((\d+) s per(?:<br\/>| )hand-over/,
    reads: "seconds",
    is: deadlines.handlerAnswerMs,
  },
  {
    what: "how long a synchronous answer has in all, in the purchase drawing",
    page,
    anchor: /hand-over, (\d+) s in all(?:<br\/>| )from the payment check\)/,
    reads: "seconds",
    is: deadlines.syncResponseMs,
  },
  {
    what: "the same, in the purchase drawing read aloud",
    page,
    anchor: /and has (\w+) seconds in all from the payment check to send back the goods/,
    reads: "seconds",
    is: deadlines.syncResponseMs,
  },
  {
    what: "how long an asynchronous hand-over waits, in the purchase drawing",
    page,
    anchor: /Y-->>G: accepted, or the goods(?:<br\/>| )\((\d+) s per hand-over\)/,
    reads: "seconds",
    is: deadlines.handlerAnswerMs,
  },
  {
    what: "how long each hand-over waits, in both modes of the purchase drawing read aloud",
    page,
    anchor: /answers each hand-over within (\w+) seconds/,
    reads: "seconds",
    is: deadlines.handlerAnswerMs,
  },
];

const PINS: readonly Pin[] = [
  // --- the commission, where merchant code reads about it -------------------
  ...sharesIn(
    "the shares, where merchant code reads the wallet",
    {
      page: "API_ROUTES.get_payout_wallet.description",
      text: API_ROUTES.get_payout_wallet.description,
    },
    "then sends {merchant}% of the accumulated balance to this wallet and {agentify}% to Agentify",
  ),
  ...sharesIn(
    "the shares, in the wallet's own description",
    { page: "PayoutWalletSchema.description", text: PayoutWalletSchema.description },
    "then sends {merchant}% of the accumulated balance to payout_wallet and {agentify}% to Agentify",
  ),
  ...sharesIn(
    "the shares, where an editor shows the wallet's type",
    { page: "packages/contracts/src/merchant.ts" },
    "and then sends {merchant}% of it to this wallet and {agentify}% to Agentify",
  ),
  ...sharesIn(
    "the shares, where a refund owed is described to merchant code",
    { page: "packages/contracts/src/events.ts" },
    "which sends {merchant}% of it to the merchant and {agentify}% to Agentify",
  ),

  // --- the commission, in the READMEs an engineer opens first ---------------
  ...sharesIn(
    "the shares, in the SDK's README",
    { page: "packages/sdk/README.md" },
    "sends {merchant}% to the merchant's wallet and {agentify}% to Agentify",
  ),
  ...sharesIn(
    "the shares, in the repository's README",
    { page: "README.md" },
    "which pays {merchant}% to the merchant's wallet and {agentify}% to Agentify",
  ),

  // --- what Agentify takes, and what reaches the merchant -------------------
  ...sharesIn(
    "how a payout divides what came in",
    { page: "apps/docs/money.md" },
    "then sends {merchant}% to your wallet and {agentify}% to Agentify",
  ),
  ...sharesIn(
    "the rate, where the page says what we take",
    { page: "apps/docs/money.md" },
    "We take {agentify}% of every payment",
  ),
  ...sharesIn(
    "the rate inside the price",
    { page: "apps/docs/money.md" },
    "your payout contract sends {merchant}% of it to you and {agentify}% to us",
  ),
  ...sharesIn(
    "the share a payout gives after rounding",
    { page: "apps/docs/money.md" },
    "a payout gives you about {merchant}% of what came in",
  ),
  ...sharesIn(
    "the commission a refund of the whole price leaves with us",
    { page: "apps/docs/money.md" },
    "although your payout contract pays you {merchant}% of it: the {agentify}% commission stays with Agentify",
  ),
  ...sharesIn(
    "the shares, where the owner decides whether to connect",
    { page: "apps/docs/index.md" },
    "then sends {merchant}% to your wallet and {agentify}% to us",
  ),
  ...sharesIn(
    "the rate inside the price, where the owner decides whether to connect",
    { page: "apps/docs/index.md" },
    "Our {agentify}% is inside your price",
  ),
  ...sharesIn(
    "the rate, in the short answer about cost",
    { page: "apps/docs/faq.md" },
    "We take {agentify}% of every payment",
  ),
  ...sharesIn(
    "the shares, in the short answer about cost",
    { page: "apps/docs/faq.md" },
    "your payout contract sends {merchant}% of it to your wallet and {agentify}% to us",
  ),

  // --- the commission, on the sellers' landing ------------------------------
  ...sharesIn(
    "the shares, on the sellers' landing",
    { page: "apps/web/content/sell.ts" },
    "sends {merchant}% to your wallet and {agentify}% to Agentify",
  ),
  ...sharesIn(
    "the shares, in the payment picture read aloud",
    { page: "apps/web/content/sell.ts" },
    "sends {merchant}% to the seller's wallet and {agentify}% to Agentify",
  ),
  ...sharesIn(
    "the shares, on the sellers' landing's short labels",
    { page: "apps/web/content/sell.ts" },
    "{merchant}% to your wallet, {agentify}% to Agentify",
  ),
  ...sharesIn(
    "the price, on the sellers' landing",
    { page: "apps/web/content/sell.ts" },
    'price: "{agentify}%"',
  ),
  ...sharesIn(
    "the rate inside the price, on the sellers' landing",
    { page: "apps/web/content/sell.ts" },
    '"{agentify}% commission, inside the price"',
  ),

  // --- the commission, on the scanner's pages -------------------------------
  ...sharesIn(
    "the shares, on the scanner's page about selling to agents",
    { page: "apps/web/content/agentic-shop.ts" },
    "a payout sends {merchant}% to your wallet and {agentify}% to Agentify",
  ),
  ...sharesIn(
    "the shares, in that page's payment path",
    { page: "apps/web/content/agentic-shop.ts" },
    "{merchant}% to your wallet, {agentify}% to Agentify",
  ),
  ...sharesIn(
    "the shares, in the text for language models",
    { page: "apps/web/lib/llms.ts" },
    "which sends {merchant}% to the merchant's wallet and {agentify}% to Agentify",
  ),

  // --- how long we wait for a price, and how long the answer lives ----------
  {
    // The challenge's maxTimeoutSeconds is longer, so the agent is told the
    // price's own life rather than reading it off the challenge.
    what: "how long a price holds, in the text for language models",
    page: "apps/web/lib/llms.ts",
    anchor: /the price in them holds for (\w+) seconds/,
    reads: "seconds",
    is: deadlines.quoteTtlMs,
  },
  {
    what: "how long a price holds, where the purchase is described to an agent's engineer",
    page: "API_ROUTES.purchase_item.description",
    text: API_ROUTES.purchase_item.description,
    anchor: /The price a challenge names holds for (\w+) seconds/,
    reads: "seconds",
    is: deadlines.quoteTtlMs,
  },
  {
    what: "how long a price goes on being good, in the table of every time limit",
    page: "apps/docs/orders.md",
    anchor: /\| The price an order was given \| the agent \| (\w+) seconds \|/,
    reads: "seconds",
    is: deadlines.quoteTtlMs,
  },
  {
    what: "how long a price question may go unanswered, in the table of every time limit",
    page: "apps/docs/orders.md",
    anchor: /\| Your price handler's answer \| you \| (\w+) seconds \|/,
    reads: "seconds",
    is: deadlines.quoteResponseMs,
  },
  {
    // The anchor holds the moment as well as the number. `expires_at` is a
    // different, longer number: the wait for an answer plus the price's own
    // life, set when the question goes out. A pin on the number alone would
    // pass a page that paired the two.
    what: "how long a price holds, and the moment it is counted from",
    page: "apps/docs/cards.md",
    anchor:
      /A price you name holds for (\w+) seconds, counted from the moment your answer reaches us/,
    reads: "seconds",
    is: deadlines.quoteTtlMs,
  },
  {
    what: "how long a price question may go unanswered before it counts as silence",
    page: "apps/docs/failures.md",
    anchor: /no answer within (\w+) seconds/,
    reads: "seconds",
    is: deadlines.quoteResponseMs,
  },
  {
    what: "the same wait, on the page a price handler is written from",
    page: "apps/docs/cards.md",
    anchor: /We wait (\w+) seconds for an answer/,
    reads: "seconds",
    is: deadlines.quoteResponseMs,
  },

  // --- the synchronous answer, and the ceiling around it --------------------
  //
  // The number a merchant sizes a synchronous handler against.
  {
    what: "how long a synchronous answer has, in the table of every time limit",
    page: "apps/docs/orders.md",
    anchor:
      /\| The goods of a synchronous order \| you \| (\w+) seconds \| the payment checked out \|/,
    reads: "seconds",
    is: deadlines.syncResponseMs,
  },
  {
    what: "the same, where the page says the answer and the charge fit the agent's promise",
    page: "apps/docs/orders.md",
    anchor: /and your (\w+) seconds and the facilitator's \w+ fit inside them/,
    reads: "seconds",
    is: deadlines.syncResponseMs,
  },
  {
    what: "the same, on the card reference",
    page: "apps/docs/cards.md",
    anchor: /the same for every product: (\w+) seconds/,
    reads: "seconds",
    is: deadlines.syncResponseMs,
  },
  {
    what: "the whole purchase the agent is promised, which the answer sits inside",
    page: "apps/docs/orders.md",
    anchor: /promised a synchronous purchase within (\w+) seconds of the payment check/,
    reads: "seconds",
    is: deadlines.syncBudgetMs,
  },

  {
    what: "how long a synchronous answer has, where the handler is written",
    page: "apps/docs/quickstart.md",
    anchor: /a synchronous sale is lost (\w+) seconds after the payment check/,
    reads: "seconds",
    is: deadlines.syncResponseMs,
  },
  {
    what: "how long we wait for a handler's answer, where the synchronous handler is written",
    page: "apps/docs/quickstart.md",
    anchor: /still working after (\w+) seconds has the same order sent again/,
    reads: "seconds",
    is: deadlines.handlerAnswerMs,
  },

  // --- how long the facilitator is waited for about a charge -----------------
  //
  // The only clock that makes an order `payment_unresolved`, so a merchant
  // reading that word knows how long the silence lasted.
  {
    what: "the wait for the facilitator's answer on a synchronous order",
    page: "apps/docs/orders.md",
    anchor:
      /\| The facilitator's answer about the charge \| Agentify \| (\w+) seconds on a synchronous order/,
    reads: "seconds",
    is: deadlines.settleResponseMs,
  },
  {
    what: "the same, inside the agent's promise beside the merchant's answer",
    page: "apps/docs/orders.md",
    anchor: /the facilitator's (\w+) fit inside them/,
    reads: "seconds",
    is: deadlines.settleResponseMs,
  },
  {
    what: "the wait for the facilitator's answer where the charge comes before the goods",
    page: "apps/docs/orders.md",
    anchor: /(\w+) where the charge comes before the goods/,
    reads: "seconds",
    is: deadlines.settleBeforeGoodsMs,
  },

  // --- what a card that names no deadline of its own is held to -------------
  {
    what: "the delivery deadline a card leaves out, in the table of every time limit",
    page: "apps/docs/orders.md",
    anchor: /the deadline your card names; without one, a (\w+) \|/,
    reads: "period",
    is: deadlines.defaultAsyncFulfillmentMs,
  },
  {
    what: "the same, on the card reference",
    page: "apps/docs/cards.md",
    anchor: /A (\w+) applies instead/,
    reads: "period",
    is: deadlines.defaultAsyncFulfillmentMs,
  },
  {
    what: "the same, where the handler is written",
    page: "apps/docs/quickstart.md",
    anchor: /A card that names none is held to a (\w+)\./,
    reads: "period",
    is: deadlines.defaultAsyncFulfillmentMs,
  },
  {
    // The agent's side of the same number: how long an order whose goods come
    // later can run before the merchant owes a refund, said where the agent
    // reads about the route it collects them on.
    what: "the same, told to the agent where it comes back for goods that come later",
    page: "API_ROUTES.get_order_status.description",
    text: API_ROUTES.get_order_status.description,
    anchor: /fulfill_deadline_seconds where the card names one, and a (\w+) where it names none/,
    reads: "period",
    is: deadlines.defaultAsyncFulfillmentMs,
  },

  // --- how long a handler's answer is waited for before the order goes again --
  //
  // A handler slower than this is answered as one that crashed until its answer
  // lands: the order is sent again in the meantime, possibly to another
  // instance. The pages say so where a merchant decides how much work to do
  // before answering, and where they read about instances.
  {
    what: "how long we wait for a handler's answer, in the table of every time limit",
    page: "apps/docs/orders.md",
    anchor: /\| Each hand-over of an order to your process \| you \| (\w+) seconds \|/,
    reads: "seconds",
    is: deadlines.handlerAnswerMs,
  },
  {
    what: "how long we wait for a handler's answer, where the three answers are set out",
    page: "apps/docs/orders.md",
    anchor: /We wait (\w+) seconds for a handler's answer/,
    reads: "seconds",
    is: deadlines.handlerAnswerMs,
  },
  {
    what: "the same wait, where several instances of a handler are run",
    page: "apps/docs/orders.md",
    anchor: /takes longer than the (\w+) seconds we wait for an answer/,
    reads: "seconds",
    is: deadlines.handlerAnswerMs,
  },
  {
    what: "the same wait, where the asynchronous handler is written",
    page: "apps/docs/quickstart.md",
    anchor: /within (\w+) seconds, which is how long we wait for a handler's answer/,
    reads: "seconds",
    is: deadlines.handlerAnswerMs,
  },

  // --- the purchase drawing, in the guide and in the reference --------------
  ...purchaseDrawingPins("apps/docs/quickstart.md"),
  ...purchaseDrawingPins("apps/docs/orders.md"),

  // --- how many times an order that never reached the handler is sent again --
  {
    what: "the attempt cap, in the table of every time limit",
    page: "apps/docs/orders.md",
    anchor: /up to (\w+) deliveries in all, within its own deadline/,
    reads: "count",
    is: redelivery.maxAttempts,
  },
  {
    what: "the attempt cap, where the three answers a handler has are set out",
    page: "apps/docs/orders.md",
    anchor: /we have delivered it (\w+) times/,
    reads: "count",
    is: redelivery.maxAttempts,
  },
  {
    what: "the same cap, said again as the number this deployment is set to",
    page: "apps/docs/orders.md",
    anchor: /(\w+) is what this system is set to/,
    reads: "count",
    is: redelivery.maxAttempts,
  },
  {
    what: "the same cap, in the table of failures",
    page: "apps/docs/failures.md",
    anchor: /up to (\w+) deliveries in all, while its deadline lasts/,
    reads: "count",
    is: redelivery.maxAttempts,
  },
];

describe("every number the portal names is the number this gateway ships", () => {
  for (const pin of PINS) {
    it(`${pin.what} (${pin.page})`, () => {
      const captured = capturedBy(pin.text ?? pageText(pin.page), pin.anchor);

      // Without this a pin would pass on a page that had stopped saying
      // anything at all.
      expect(
        captured.length,
        `${pin.page} no longer carries the sentence this pin reads (${pin.anchor.source}); if it was rewritten, rewrite the pin with it`,
      ).toBeGreaterThan(0);

      for (const word of captured) {
        expect(
          quantityOf(word, pin.reads),
          `${pin.page} tells its reader "${word}" where the configuration says ${pin.is}`,
        ).toBe(pin.is);
      }
    });
  }

  it("takes one commission on every network the code names, so that a page can name one", () => {
    for (const split of Object.values(config.payoutSplitNetworks)) {
      expect(commissionOf(split), split.network).toBe(commission);
    }
  });

  it("grows the pause between attempts, which is the one claim carrying no number", () => {
    // failures.md: "the order comes again after a pause that grows with each
    // attempt". The configuration accepts a factor of one, a flat retry that
    // puts every attempt inside a couple of seconds, and the sentence would
    // then describe nothing that happens.
    expect(redelivery.factor).toBeGreaterThan(1);
  });
});

describe("a number the portal publishes is not also called undecided", () => {
  // A page that names a deadline in its body must not also list it under "What
  // is not settled yet", or the merchant reads both a number and a statement
  // that there is none. Each entry below names what is true instead.
  const RESOLVED: readonly {
    readonly page: string;
    readonly claim: RegExp;
    readonly truth: string;
  }[] = [
    {
      page: "apps/docs/orders.md",
      claim: /how long we wait for a synchronous answer/,
      truth: "ten seconds, named in “Every time limit”",
    },
    {
      page: "apps/docs/quickstart.md",
      claim: /how long we wait for a synchronous answer/,
      truth: "ten seconds, named on step 3",
    },
    {
      page: "apps/docs/orders.md",
      claim: /how many times we do it/,
      truth: "five attempts, named where a handler's three answers are set out",
    },
    {
      page: "apps/docs/failures.md",
      claim: /how many times we repeat it/,
      truth: "five attempts, named under “The handler crashed without answering”",
    },
    {
      page: "apps/docs/failures.md",
      claim: /freshness threshold/,
      truth: "there is no such check: the timestamp on a price answer is carried and never weighed",
    },
    {
      page: "apps/docs/cards.md",
      claim: /how long we wait for an answer/,
      truth: "five seconds, named under “Asking the price and availability”",
    },
    {
      page: "apps/docs/quickstart.md",
      claim: /the build that would let the command start/,
      truth: "the SDK builds and `agentify verify` runs; `scripts/outside.sh` runs it",
    },
    // The pause between attempts is settled in `config.ts` and deliberately
    // unpublished, because a merchant sizes nothing against it; listing it as
    // open would be the same half-claim.
    {
      page: "apps/docs/orders.md",
      claim: /The delay before we resend/,
      truth:
        "settled in configuration and deliberately unpublished as internal mechanics: the repeating is automatic and is bounded by the deadline and the attempt count, and both of those are named",
    },
    {
      page: "apps/docs/failures.md",
      claim: /The delay before we repeat/,
      truth:
        "settled in configuration and deliberately unpublished as internal mechanics: the page says the pauses grow, which is the whole of what a handler needs",
    },
  ];

  function unsettledSection(page: string): string {
    const text = readFileSync(new URL(page, repoRoot), "utf8");
    const start = text.indexOf("## What is not settled yet");
    if (start === -1) throw new Error(`${page} has no "What is not settled yet" section`);
    return text.slice(start).replace(/\s+/g, " ");
  }

  for (const { page, claim, truth } of RESOLVED) {
    it(`${page} no longer asks about ${claim.source}`, () => {
      expect(
        unsettledSection(page),
        `${page} lists this as unsettled again, and it is settled: ${truth}`,
      ).not.toMatch(claim);
    });
  }

  it("is reading the sections and not an empty string", () => {
    // The negative control for the guard above: every one of those assertions
    // passes against nothing at all.
    for (const page of ["apps/docs/orders.md", "apps/docs/cards.md", "apps/docs/failures.md"]) {
      expect(unsettledSection(page).length).toBeGreaterThan(200);
    }
    expect(() => unsettledSection("apps/docs/WRITING.md")).toThrowError(
      /no "What is not settled yet"/,
    );
  });
});

describe("the pin itself", () => {
  // Everything above is worth exactly as much as these few functions. A reader
  // that silently found nothing, or a matcher that took any number it met,
  // would leave the whole file green against a portal saying anything.

  it("reads a sentence the page has wrapped across two lines", () => {
    const wrapped =
      "answer is set by us, the same for every\nproduct: eight seconds. That one runs";

    expect(
      capturedBy(wrapped.replace(/\s+/g, " "), /the same for every product: (\w+) seconds/),
    ).toStrictEqual(["eight"]);
  });

  it("finds nothing when the sentence is gone, rather than a number from elsewhere", () => {
    // The pages do say "five seconds", about a merchant's own supplier, which
    // is not our number.
    const page = "a supplier that did not answer within five seconds is not worth a refusal";

    expect(capturedBy(page, /until we have tried (\w+) times/)).toStrictEqual([]);
  });

  it("catches a number that changed under an unchanged sentence", () => {
    const page = "A synchronous answer has nine seconds.";
    const [word] = capturedBy(page, /A synchronous answer has (\w+) seconds/);

    expect(word).toBe("nine");
    expect(() => quantityOf(word ?? "", "seconds")).toThrowError(/cannot read/);
    expect(quantityOf("eight", "seconds")).toBe(8_000);
  });

  it("holds every occurrence, so one paragraph cannot drift from another", () => {
    const page = "A synchronous answer has eight seconds. A synchronous answer has nine seconds.";

    expect(capturedBy(page, /A synchronous answer has (\w+) seconds/)).toStrictEqual([
      "eight",
      "nine",
    ]);
  });

  it("reads periods and counts in the units the configuration keeps them in", () => {
    expect(quantityOf("day", "period")).toBe(86_400_000);
    expect(quantityOf("hour", "period")).toBe(3_600_000);
    expect(quantityOf("five", "count")).toBe(5);
    expect(quantityOf("thirty", "seconds")).toBe(30_000);
    expect(() => quantityOf("fortnight", "period")).toThrowError(/cannot read/);
    // A sentence that opens on its number writes it with a capital.
    expect(quantityOf("Five", "count")).toBe(5);
  });

  it("leaves none of the numbers the portal publishes without a pin", () => {
    // Deleting a sentence from the portal and its pin together is a decision
    // somebody can take; losing the pin on its own is how the number goes back
    // to drifting. Each of these is a default a page names in words, so each
    // has to be somebody's `is` above.
    const pinned = new Set(PINS.map((pin) => pin.is));

    for (const [what, value] of [
      ["how long we wait for a price", deadlines.quoteResponseMs],
      ["how long a price holds", deadlines.quoteTtlMs],
      ["how long a synchronous answer has", deadlines.syncResponseMs],
      ["the purchase the agent is promised", deadlines.syncBudgetMs],
      ["the delivery deadline a card leaves out", deadlines.defaultAsyncFulfillmentMs],
      ["how long the facilitator is waited for after the goods", deadlines.settleResponseMs],
      ["how long the facilitator is waited for before the goods", deadlines.settleBeforeGoodsMs],
      ["how many times an order is sent again", redelivery.maxAttempts],
      ["Agentify's share of every payment", commission],
      ["the merchant's share of every payment", merchantShare],
    ] as const) {
      expect(pinned, `nothing above holds the portal to ${what}`).toContain(value);
    }
  });
});

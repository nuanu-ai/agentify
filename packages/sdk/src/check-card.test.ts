import { ProblemSchema } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import { checkCard } from "./check-card.js";

/**
 * The card the documentation's quickstart publishes, the card a merchant meets
 * first. Copied as an object: what this file is about is what the checker
 * says, and the page's examples are held to the schemas in the contracts
 * package.
 */
const validCard = {
  merchant_item_id: "access-monthly",
  title: "Доступ к сервису на один месяц",
  description: "Что покупатель получает, для какой задачи это годится и что в это не входит.",
  price: { amount: "5.00", currency: "USD" },
  params: {
    email: { type: "string", required: true, title: "Куда прислать доступ" },
  },
  result: {
    access_url: { type: "string", title: "Ссылка для входа" },
  },
  fulfillment: "sync",
};

const pathsOf = (card: unknown): string[][] => checkCard(card).problems.map((p) => p.path);

describe("checking a card before it is published", () => {
  it("passes a card an agent could buy from", () => {
    // The promise: the check a merchant runs before publishing does not fail
    // the card the documentation told them to write.
    expect(checkCard(validCard).problems).toStrictEqual([]);
  });

  it("names the field that is missing, in the shape the publish call answers in", () => {
    // The promise: a finding the merchant reads locally is the same kind of
    // object the gateway sends back: a path, a code and a sentence.
    const { problems } = checkCard({ ...validCard, title: undefined });

    expect(problems).toHaveLength(1);
    for (const problem of problems) {
      expect(ProblemSchema.safeParse(problem).success).toBe(true);
    }
    expect(problems[0]?.path).toStrictEqual(["title"]);
    // In words that say what the field is, not the validator's.
    expect(problems[0]?.message).not.toMatch(/received undefined/);
  });

  it("reports every problem of one pass at once rather than the first", () => {
    // The promise: a merchant sees every finding at once, not one per round
    // trip.
    const paths = pathsOf({
      ...validCard,
      title: undefined,
      price: { amount: "5,00", currency: "USD" },
      fulfillment: "later",
    });

    expect(paths).toContainEqual(["title"]);
    expect(paths).toContainEqual(["price", "amount"]);
    expect(paths).toContainEqual(["fulfillment"]);
  });

  // `checkCard` is `CardSchema` and the price rule. The card's own rules are
  // tested in the contracts package's `card.test.ts`, and the price rule where
  // a price comes in, in `apps/gateway/src/app/gateway.test.ts`
  // (`UNSELLABLE_PRICES`) and `apps/gateway/src/http/x402.test.ts`. What this
  // file holds is the shape of the answer.

  it("finds a price the publish call would refuse, and passes one it would take", () => {
    // The promise: a card this check passes is not refused at publication for
    // anything about the card. The price rule is applied outside the card's
    // schema, so it is read here too; one case of each kind, as the rule is
    // walked in the gateway's tests.
    for (const [price, field] of [
      [{ amount: "0.00", currency: "USD" }, "amount"],
      ["500 USD", "amount"],
      ["0.0000001 USD", "amount"],
      [{ amount: "5.00", currency: "EUR" }, "currency"],
    ] as const) {
      expect(pathsOf({ ...validCard, price }), JSON.stringify(price)).toStrictEqual([
        ["price", field],
      ]);
    }
    expect(checkCard({ ...validCard, price: "0.001 USDC" }).problems).toStrictEqual([]);
  });

  it("stops before the rules that compare fields when the shape itself is wrong", () => {
    // A merchant should know a clean second run is not implied by a short
    // first one: this card has two problems, and one pass sees only the first.
    const paths = pathsOf({ ...validCard, nonsense: 1, fulfill_deadline_seconds: 600 });

    expect(paths).toStrictEqual([[]]);
    expect(checkCard({ ...validCard, nonsense: 1 }).problems[0]?.message).toMatch(/nonsense/);
  });

  it("says so about a card as a whole when what it was handed is not a card", () => {
    // A file holding a list, a string or nothing gets a finding about the
    // card, with an empty path, rather than a crash.
    for (const value of [null, "a card", 42, [], undefined]) {
      const { problems } = checkCard(value);

      expect(problems).toHaveLength(1);
      expect(problems[0]?.path).toStrictEqual([]);
      expect(ProblemSchema.safeParse(problems[0]).success).toBe(true);
    }
  });
});

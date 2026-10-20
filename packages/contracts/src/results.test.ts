import { describe, expect, it } from "vitest";
import {
  CARD_REJECTED,
  CallErrorSchema,
  MERCHANT_FINDINGS,
  ORDER_CALL_ERROR_CODES,
  ORDER_CALL_RESULTS,
  OrderCallResultSchema,
  ProblemSchema,
  PublishResultSchema,
} from "./results.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

describe("what publishing a card returns", () => {
  // The promise: publishing a card never throws; an invalid card comes back
  // as findings, each pointing at a field.

  it("returns the catalog id when the card is accepted", () => {
    const result = { ok: true, id: "itm_9f2c4a" };
    expect(PublishResultSchema.parse(result)).toStrictEqual(result);
  });

  it("returns findings when the card is not", () => {
    const result = {
      ok: false,
      error: {
        code: CARD_REJECTED,
        message: "this card was not published",
        retryable: false,
        problems: [
          {
            path: ["params", "email", "type"],
            code: "unknown_type",
            message: 'unknown type "date"',
          },
          { path: ["result"], code: "empty_result", message: "a card declares what it delivers" },
        ],
      },
    };
    expect(PublishResultSchema.parse(result)).toStrictEqual(result);
  });

  it("says which of the two it is in one field, and never in both at once", () => {
    // A consumer reads `ok` and knows, in any language.
    expect(PublishResultSchema.parse({ ok: true, id: "itm_9f2c4a" }).ok).toBe(true);
    expect(
      PublishResultSchema.safeParse({
        ok: true,
        id: "itm_9f2c4a",
        error: {
          code: CARD_REJECTED,
          message: "…",
          retryable: false,
          problems: [{ path: [], code: "x", message: "y" }],
        },
      }).success,
    ).toBe(false);
  });

  it("refuses a refusal with an empty list of findings, and names the field", () => {
    // An empty `problems` would say the card was refused and name nothing.
    const message = errorOf(PublishResultSchema, {
      ok: false,
      error: { code: CARD_REJECTED, message: "this card was not published", retryable: false },
    });

    expect(message).toContain("problems");

    const emptied = errorOf(PublishResultSchema, {
      ok: false,
      error: {
        code: CARD_REJECTED,
        message: "this card was not published",
        retryable: false,
        problems: [],
      },
    });

    expect(emptied).toContain("problems");
  });

  it("refuses an acceptance that names no catalog id, and names the field", () => {
    // The id is what the card is known by from then on.
    expect(errorOf(PublishResultSchema, { ok: true })).toContain("id");
  });

  it("refuses an answer that is neither", () => {
    for (const result of [
      {},
      null,
      { id: "itm_9f2c4a" },
      { ok: "itm_9f2c4a" },
      { ok: { id: "itm_9f2c4a" } },
      { errors: [{ path: [], code: "x", message: "y" }] },
      // "No" with no reason after it.
      { ok: false },
    ]) {
      expect(PublishResultSchema.safeParse(result).success, JSON.stringify(result)).toBe(false);
    }
  });

  it("names the refusal in the word a merchant's code branches on", () => {
    // The constant is the wire word: integrations compare against the string,
    // so renaming it changes the contract.
    expect(CARD_REJECTED).toBe("card_rejected");
  });

  it("names the findings about the merchant in the words a merchant's code branches on", () => {
    // A program tells "fix the card" from "fix the merchant" by comparing a
    // finding's code with these, so each is the wire word the gateway sends.
    expect(Object.values(MERCHANT_FINDINGS)).toStrictEqual([
      "no_seller_name",
      "no_payout_wallet",
      "no_operator_approval",
      "no_seller_site",
    ]);
  });

  it("carries a finding that is about the merchant rather than the card", () => {
    // Findings about the merchant come in the same list as the card's, so one
    // answer carries everything standing between the card and the catalog.
    const result = {
      ok: false,
      error: {
        code: CARD_REJECTED,
        message: "this card was not published",
        retryable: false,
        problems: [
          { path: [], code: "no_seller_name", message: "set the name you sell under first" },
        ],
      },
    };

    expect(PublishResultSchema.parse(result)).toStrictEqual(result);
  });
});

describe("one finding about what was sent", () => {
  const finding = { path: ["price", "amount"], code: "invalid_amount", message: "not a decimal" };

  it("points at a field, in a code and in words", () => {
    expect(ProblemSchema.parse(finding)).toStrictEqual(finding);
  });

  for (const field of ["path", "code", "message"]) {
    it(`refuses a finding without ${field} and names it`, () => {
      expectMissingFieldRejected(ProblemSchema, finding, field);
    });
  }

  it("says with an empty path that the finding is about the card as a whole", () => {
    // An empty path means "about the card as a whole", so the field must be
    // present to tell it from a missing one.
    expect(ProblemSchema.safeParse({ ...finding, path: [] }).success).toBe(true);
  });

  it("refuses a path that is not a list of field names", () => {
    for (const path of ["price.amount", ["price", 0], [null]]) {
      expect(ProblemSchema.safeParse({ ...finding, path }).success, JSON.stringify(path)).toBe(
        false,
      );
    }
  });
});

describe("what delivering or refusing an order answers with", () => {
  // The promise: the merchant's code branches on these words, so they are
  // contract, not prose.

  it("names every way the call can succeed", () => {
    expect([...ORDER_CALL_RESULTS]).toStrictEqual([
      "accepted",
      "delivered",
      "already_delivered",
      "delivered_late",
      "refused",
      "purchase_already_closed",
    ]);
  });

  it("names a successful acceptance among them, and not among the failures", () => {
    // The promise: a merchant who takes an order on is not told something went
    // wrong. The answer route's success must name a word, and without one for
    // an acceptance an integration would record a healthy order as a problem.
    expect(ORDER_CALL_RESULTS).toContain("accepted");
    expect(ORDER_CALL_ERROR_CODES).not.toContain("accepted");
  });

  it("accepts each of them and nothing else", () => {
    for (const result of ORDER_CALL_RESULTS) {
      expect(OrderCallResultSchema.safeParse(result).success, result).toBe(true);
    }
    for (const result of ["ok", "success", "delivered_twice", "debt_closed_by_delivery", ""]) {
      expect(OrderCallResultSchema.safeParse(result).success, JSON.stringify(result)).toBe(false);
    }
  });
});

describe("the error codes the calls answer with", () => {
  it("names the ones the merchant is expected to branch on", () => {
    expect([...ORDER_CALL_ERROR_CODES]).toStrictEqual([
      "fulfillment_closed",
      "order_already_closed",
      "not_applicable_in_mode",
      "delivery_does_not_match_card",
      "shipment_already_recorded",
    ]);
  });

  it("says in the dictionary what each of them means", () => {
    // The description is all a client generated outside TypeScript reads
    // about these codes. The publish refusal is asked for by name, since it
    // belongs to no list of order-call codes.
    const dictionary = CallErrorSchema.shape.code.meta()?.description ?? "";
    for (const code of [...ORDER_CALL_ERROR_CODES, CARD_REJECTED]) {
      expect(dictionary, code).toContain(code);
    }
  });

  it("still accepts a code outside the promised ones", () => {
    // The list is a promise of meaning, not a gate: an unanticipated error
    // must still reach the merchant in words.
    expect(
      CallErrorSchema.safeParse({
        code: "gateway_unavailable",
        message: "…",
        retryable: true,
      }).success,
    ).toBe(true);
  });

  it("carries each of them in an error a merchant can act on", () => {
    for (const code of ORDER_CALL_ERROR_CODES) {
      const error = { code, message: "…", retryable: false };
      expect(CallErrorSchema.safeParse(error).success, code).toBe(true);
    }
  });
});

describe("an error from a call that did not go through", () => {
  const error = {
    code: "fulfillment_closed",
    message: "the merchant closed future Agentify fulfillment for this order",
    retryable: false,
  };

  it("says whether repeating the call could help", () => {
    expect(CallErrorSchema.parse(error)).toStrictEqual(error);
    expect(CallErrorSchema.parse({ ...error, retryable: true })).toStrictEqual({
      ...error,
      retryable: true,
    });
  });

  for (const field of ["code", "message", "retryable"]) {
    it(`refuses an error without ${field} and names it`, () => {
      expectMissingFieldRejected(CallErrorSchema, error, field);
    });
  }

  it("refuses a retry flag that is not one", () => {
    // A truthy string would turn "call again" into "write it down" or the
    // reverse.
    for (const retryable of ["true", 1, null, "yes"]) {
      expect(
        CallErrorSchema.safeParse({ ...error, retryable }).success,
        JSON.stringify(retryable),
      ).toBe(false);
    }
  });

  it("refuses a blank code or a blank message", () => {
    expect(CallErrorSchema.safeParse({ ...error, code: "" }).success).toBe(false);
    expect(CallErrorSchema.safeParse({ ...error, message: "  " }).success).toBe(false);
  });

  it("carries the findings where the call is refusing what it was handed", () => {
    // The merchant is told which fields of a misfit delivery did not fit.
    const misfit = {
      code: "delivery_does_not_match_card",
      message: "the goods are not the ones this card declares",
      retryable: true,
      problems: [{ path: ["access_url"], code: "unexpected_field", message: "not declared" }],
    };

    expect(CallErrorSchema.parse(misfit)).toStrictEqual(misfit);
  });

  it("leaves the findings out where there is nothing to point at", () => {
    // An empty list beside a failure about the state of the world would read
    // as "nothing wrong with what you sent".
    expect(CallErrorSchema.parse(error)).not.toHaveProperty("problems");
  });

  it("refuses an empty list of findings", () => {
    // Present and empty names nothing; absent says there is nothing to point
    // at.
    expect(CallErrorSchema.safeParse({ ...error, problems: [] }).success).toBe(false);
  });
});

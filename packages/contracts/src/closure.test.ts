import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  AgentOrderStatusSchema,
  MerchantClosureSchema,
  OrderCloseRequestSchema,
  OrderCloseResponseSchema,
  OrderWithStatusSchema,
  PaymentStatusSchema,
  toJsonSchemas,
} from "./index.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

const closure = { closed_at: "2026-10-19T12:00:00Z", message: "We will contact you directly." };

describe("a merchant closes future Agentify fulfillment", () => {
  it("accepts no explanation and preserves a supplied explanation literally", () => {
    expect(OrderCloseRequestSchema.parse({})).toStrictEqual({});
    const request = {
      message: "  A partial refund was agreed outside Agentify.\nWe will contact you.  ",
    };
    expect(OrderCloseRequestSchema.parse(request)).toStrictEqual(request);
    expect(OrderCloseRequestSchema.safeParse({ message: "x".repeat(2000) }).success).toBe(true);
  });

  it("refuses an empty, oversized or nontext explanation and financial fields", () => {
    for (const message of ["", " \n ", "x".repeat(2001), null, 1]) {
      expect(errorOf(OrderCloseRequestSchema, { message })).toContain("message");
    }
    for (const field of ["refund", "amount", "transaction", "settled"]) {
      expect(errorOf(OrderCloseRequestSchema, { [field]: true })).toContain(field);
    }
  });

  it("holds the explanation to plain text, since the buyer's agent reads it exactly as written", () => {
    for (const message of [
      "Tea & coffee, 5 < 10.\nWe will write to you.",
      "Mohon maaf, pesanan dibatalkan.",
      "مرتجع",
    ]) {
      expect(OrderCloseRequestSchema.safeParse({ message }).success, message).toBe(true);
    }
    for (const [message, named] of [
      ["<b>Refund sent</b>", "HTML markup"],
      ["Refund &amp; apology", "HTML character reference"],
      ["a\u0000b", "U+0000"],
      ["ring \u0007 bell", "U+0007"],
      ["a\r\nb", "U+000D"],
      ["\u202Edecnys\u202C", "bidirectional"],
      ["\u2066isolated\u2069", "bidirectional"],
    ] as const) {
      const error = errorOf(OrderCloseRequestSchema, { message });
      expect(error, JSON.stringify(message)).toContain("message");
      expect(error, JSON.stringify(message)).toContain(named);
    }
  });

  it("records the merchant's first closure time and optional words", () => {
    expect(MerchantClosureSchema.parse(closure)).toStrictEqual(closure);
    expect(MerchantClosureSchema.parse({ closed_at: closure.closed_at })).toStrictEqual({
      closed_at: closure.closed_at,
    });
    expectMissingFieldRejected(MerchantClosureSchema, closure, "closed_at");
    expect(errorOf(MerchantClosureSchema, { ...closure, closed_at: "yesterday" })).toContain(
      "closed_at",
    );
    expect(errorOf(MerchantClosureSchema, { ...closure, refund_verified: true })).toContain(
      "refund_verified",
    );
  });

  it("answers a closure retry with the same success shape and returns a refusal as a value", () => {
    expect(OrderCloseResponseSchema.parse({ ok: true })).toStrictEqual({ ok: true });
    expectMissingFieldRejected(OrderCloseResponseSchema, { ok: true }, "ok");
    const refused = {
      ok: false,
      error: {
        code: "order_already_closed",
        message: "The shipment is already recorded.",
        retryable: false,
      },
    };
    expect(OrderCloseResponseSchema.parse(refused)).toStrictEqual(refused);
    expectMissingFieldRejected(OrderCloseResponseSchema, refused, "error");
    expect(OrderCloseResponseSchema.safeParse({ ok: true, refund_verified: true }).success).toBe(
      false,
    );
  });

  it("keeps original payment facts separate from fulfillment closure", () => {
    const merchant = {
      id: "ord_closed",
      merchant_item_id: "access-monthly",
      params: {},
      price: { amount: "5.00", currency: "USD", at: closure.closed_at, as_of: closure.closed_at },
      test: true,
      status: "fulfillment_closed",
      payment_status: "paid",
      merchant_closure: closure,
    };
    const agent = {
      order_id: merchant.id,
      status_url: "https://test.agentify.ad/x402/orders/ord_closed/status",
      status: merchant.status,
      payment_status: merchant.payment_status,
      price: merchant.price,
      delivered: null,
      test: true,
      seller: { name: "Freeland", site: null },
      merchant_closure: closure,
    };
    for (const payment_status of ["not_paid", "paid", "unresolved"] as const) {
      expect(PaymentStatusSchema.parse(payment_status)).toBe(payment_status);
      expect(OrderWithStatusSchema.parse({ ...merchant, payment_status }).payment_status).toBe(
        payment_status,
      );
      expect(AgentOrderStatusSchema.parse({ ...agent, payment_status }).payment_status).toBe(
        payment_status,
      );
    }
    expectMissingFieldRejected(OrderWithStatusSchema, merchant, "payment_status");
    expectMissingFieldRejected(AgentOrderStatusSchema, agent, "payment_status");
    expect(errorOf(OrderWithStatusSchema, { ...merchant, payment_status: "refunded" })).toContain(
      "payment_status",
    );
    expect(
      OrderWithStatusSchema.safeParse({
        ...merchant,
        merchant_closure: { ...closure, later_field: true },
      }).success,
    ).toBe(false);
    expect(
      AgentOrderStatusSchema.safeParse({
        ...agent,
        merchant_closure: { ...closure, later_field: true },
      }).success,
    ).toBe(true);
  });

  it("exports the same closure and payment boundaries for generated clients", () => {
    const schemas = toJsonSchemas();
    expect(schemas.order_close_request.additionalProperties).toBe(false);
    expect(schemas.order_close_request.properties?.message).toMatchObject({
      maxLength: 2000,
      pattern: "\\S",
    });
    expect(schemas.merchant_closure.required).toStrictEqual(["closed_at"]);
    expect(schemas.payment_status.enum).toStrictEqual(["not_paid", "paid", "unresolved"]);
    expect(schemas.order_with_status.required).toContain("payment_status");
    expect(schemas.agent_order_status.required).toContain("payment_status");
    const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
    const validate = ajv.compile(schemas.order_close_request);
    for (const body of [{}, { message: "A partial refund was agreed directly." }]) {
      expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    }
    for (const body of [{ message: " " }, { message: "x".repeat(2001) }, { amount: "5.00" }]) {
      expect(validate(body)).toBe(false);
    }
    const validateClosure = ajv.compile(schemas.merchant_closure);
    expect(validateClosure(closure), JSON.stringify(validateClosure.errors)).toBe(true);
    expect(validateClosure({ message: closure.message })).toBe(false);
  });
});

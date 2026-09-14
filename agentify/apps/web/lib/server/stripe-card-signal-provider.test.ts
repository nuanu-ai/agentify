import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { LocalStripeCardSignalProvider } from "./stripe-card-signal-provider";

describe("local Stripe card-signal provider", () => {
  it("is replay-safe and always creates an on-session setup", async () => {
    const provider = new LocalStripeCardSignalProvider("test-webhook-secret");
    const key = randomUUID();
    const customerId = await provider.createCustomer({
      leadId: randomUUID(),
      idempotencyKey: key,
    });
    const input = {
      customerId,
      leadId: randomUUID(),
      scanId: randomUUID(),
      idempotencyKey: key,
    };
    const first = await provider.createSetup(input);
    const replay = await provider.createSetup(input);
    expect(replay.id).toBe(first.id);
    expect(first).toMatchObject({
      status: "requires_payment_method",
      usage: "on_session",
      paymentMethodId: null,
    });

    const delivery = await provider.confirmLocalSetup(first.id);
    expect(
      provider.verifyWebhook(delivery.rawBody, delivery.signature),
    ).toEqual({
      id: expect.stringMatching(/^evt_local_/),
      type: "setup_intent.succeeded",
      setupIntentId: first.id,
    });
    const confirmed = await provider.retrieveSetup(first.id);
    expect(confirmed.status).toBe("succeeded");
    const attached = await provider.retrieveCustomerPaymentMethod(
      customerId,
      confirmed.paymentMethodId!,
    );
    expect(attached.customerId).toBe(customerId);
    await provider.detachPaymentMethod(attached.id);
    expect(await provider.retrievePaymentMethod(attached.id)).toEqual({
      id: attached.id,
      customerId: null,
    });
    expect(await provider.deleteCustomer(customerId)).toEqual({
      id: customerId,
      deleted: true,
    });
    expect(await provider.retrieveCustomer(customerId)).toEqual({
      id: customerId,
      deleted: true,
    });
  });

  it("cancels an unconfirmed setup and verifies the readback", async () => {
    const provider = new LocalStripeCardSignalProvider("test-webhook-secret");
    const key = randomUUID();
    const customerId = await provider.createCustomer({
      leadId: randomUUID(),
      idempotencyKey: key,
    });
    const setup = await provider.createSetup({
      customerId,
      leadId: randomUUID(),
      scanId: randomUUID(),
      idempotencyKey: key,
    });
    expect((await provider.cancelSetup(setup.id)).status).toBe("canceled");
    expect((await provider.retrieveSetup(setup.id)).status).toBe("canceled");
  });
});

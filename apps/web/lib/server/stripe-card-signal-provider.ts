import { createHash, randomUUID } from "node:crypto";

import Stripe from "stripe";

import {
  localWebhookSignature,
  verifyLocalWebhookSignature,
} from "./stripe-card-signal-crypto";
import {
  getStripeCardSignalConfig,
  type StripeCardSignalConfig,
} from "./stripe-card-signal-config";

export type SetupReadback = Readonly<{
  id: string;
  customerId: string;
  clientSecret: string | null;
  paymentMethodId: string | null;
  status:
    | "requires_payment_method"
    | "requires_confirmation"
    | "requires_action"
    | "processing"
    | "canceled"
    | "succeeded";
  usage: "on_session";
  leadId: string;
  scanId: string;
}>;

export type PaymentMethodReadback = Readonly<{
  id: string;
  customerId: string | null;
}>;

export type CustomerReadback = Readonly<{
  id: string;
  deleted: boolean;
}>;

export type CardSignalWebhookEvent = Readonly<{
  id: string;
  type: string;
  setupIntentId: string | null;
}>;

export interface StripeCardSignalProvider {
  readonly adapter: "local" | "stripe";
  createCustomer(input: {
    leadId: string;
    idempotencyKey: string;
  }): Promise<string>;
  retrieveCustomer(id: string): Promise<CustomerReadback>;
  deleteCustomer(id: string): Promise<CustomerReadback>;
  createSetup(input: {
    customerId: string;
    leadId: string;
    scanId: string;
    idempotencyKey: string;
  }): Promise<SetupReadback>;
  retrieveSetup(id: string): Promise<SetupReadback>;
  cancelSetup(id: string): Promise<SetupReadback>;
  retrieveCustomerPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<PaymentMethodReadback>;
  detachPaymentMethod(id: string): Promise<PaymentMethodReadback>;
  retrievePaymentMethod(id: string): Promise<PaymentMethodReadback>;
  verifyWebhook(rawBody: string, signature: string): CardSignalWebhookEvent;
  confirmLocalSetup?(id: string): Promise<{
    rawBody: string;
    signature: string;
  }>;
}

function objectId(value: string | { id: string } | null): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

class StripeProvider implements StripeCardSignalProvider {
  readonly adapter = "stripe" as const;
  readonly #stripe: Stripe;
  readonly #webhookSecret: string;

  constructor(config: StripeCardSignalConfig) {
    if (!config.STRIPE_SECRET_KEY) throw new Error("stripe_secret_key_missing");
    this.#stripe = new Stripe(config.STRIPE_SECRET_KEY);
    this.#webhookSecret = config.webhookSecret;
  }

  async createCustomer(input: { leadId: string; idempotencyKey: string }) {
    const customer = await this.#stripe.customers.create(
      { metadata: { agentify_lead_id: input.leadId, purpose: "card_signal" } },
      { idempotencyKey: `card-customer:${input.idempotencyKey}` },
    );
    return customer.id;
  }

  async retrieveCustomer(id: string) {
    const customer = await this.#stripe.customers.retrieve(id);
    return { id: customer.id, deleted: customer.deleted === true };
  }

  async deleteCustomer(id: string) {
    const customer = await this.#stripe.customers.del(id);
    return { id: customer.id, deleted: customer.deleted === true };
  }

  async createSetup(input: {
    customerId: string;
    leadId: string;
    scanId: string;
    idempotencyKey: string;
  }) {
    const setup = await this.#stripe.setupIntents.create(
      {
        customer: input.customerId,
        payment_method_types: ["card"],
        usage: "on_session",
        metadata: {
          agentify_lead_id: input.leadId,
          agentify_scan_id: input.scanId,
          purpose: "card_signal",
        },
      },
      { idempotencyKey: `card-setup:${input.idempotencyKey}` },
    );
    return stripeSetupReadback(setup);
  }

  async retrieveSetup(id: string) {
    return stripeSetupReadback(await this.#stripe.setupIntents.retrieve(id));
  }

  async cancelSetup(id: string) {
    return stripeSetupReadback(await this.#stripe.setupIntents.cancel(id));
  }

  async retrieveCustomerPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ) {
    const method = await this.#stripe.customers.retrievePaymentMethod(
      customerId,
      paymentMethodId,
    );
    return { id: method.id, customerId: objectId(method.customer) };
  }

  async detachPaymentMethod(id: string) {
    const method = await this.#stripe.paymentMethods.detach(id);
    return { id: method.id, customerId: objectId(method.customer) };
  }

  async retrievePaymentMethod(id: string) {
    const method = await this.#stripe.paymentMethods.retrieve(id);
    return { id: method.id, customerId: objectId(method.customer) };
  }

  verifyWebhook(rawBody: string, signature: string) {
    const event = this.#stripe.webhooks.constructEvent(
      rawBody,
      signature,
      this.#webhookSecret,
    );
    const object = event.data.object as { id?: unknown };
    return {
      id: event.id,
      type: event.type,
      setupIntentId:
        event.type === "setup_intent.succeeded" && typeof object.id === "string"
          ? object.id
          : null,
    };
  }
}

function stripeSetupReadback(setup: Stripe.SetupIntent): SetupReadback {
  const customerId = objectId(setup.customer);
  const paymentMethodId = objectId(setup.payment_method);
  const leadId = setup.metadata?.agentify_lead_id;
  const scanId = setup.metadata?.agentify_scan_id;
  if (!customerId || !leadId || !scanId || setup.usage !== "on_session")
    throw new Error("stripe_setup_readback_invalid");
  return {
    id: setup.id,
    customerId,
    clientSecret: setup.client_secret,
    paymentMethodId,
    status: setup.status,
    usage: "on_session",
    leadId,
    scanId,
  };
}

type LocalSetup = SetupReadback;
const localState = globalThis as typeof globalThis & {
  agentifyLocalStripe?: {
    customers: Map<string, string>;
    deletedCustomers: Set<string>;
    setups: Map<string, LocalSetup>;
    methods: Map<string, PaymentMethodReadback>;
  };
};

function getLocalState() {
  localState.agentifyLocalStripe ??= {
    customers: new Map(),
    deletedCustomers: new Set(),
    setups: new Map(),
    methods: new Map(),
  };
  localState.agentifyLocalStripe.deletedCustomers ??= new Set();
  return localState.agentifyLocalStripe;
}

export class LocalStripeCardSignalProvider implements StripeCardSignalProvider {
  readonly adapter = "local" as const;
  readonly #webhookSecret: string;

  constructor(webhookSecret: string) {
    this.#webhookSecret = webhookSecret;
  }

  async createCustomer(input: { leadId: string; idempotencyKey: string }) {
    const id = deterministicId("cus_local", input.idempotencyKey);
    getLocalState().customers.set(id, input.leadId);
    return id;
  }

  async retrieveCustomer(id: string) {
    const state = getLocalState();
    if (!state.customers.has(id) && !state.deletedCustomers.has(id))
      throw new Error("local_customer_not_found");
    return { id, deleted: state.deletedCustomers.has(id) };
  }

  async deleteCustomer(id: string) {
    const state = getLocalState();
    if (!state.customers.has(id) && !state.deletedCustomers.has(id))
      throw new Error("local_customer_not_found");
    state.customers.delete(id);
    state.deletedCustomers.add(id);
    return { id, deleted: true };
  }

  async createSetup(input: {
    customerId: string;
    leadId: string;
    scanId: string;
    idempotencyKey: string;
  }) {
    const id = deterministicId("seti_local", input.idempotencyKey);
    const existing = getLocalState().setups.get(id);
    if (existing) return existing;
    const setup: LocalSetup = {
      id,
      customerId: input.customerId,
      clientSecret: `${id}_secret_local_only`,
      paymentMethodId: null,
      status: "requires_payment_method",
      usage: "on_session",
      leadId: input.leadId,
      scanId: input.scanId,
    };
    getLocalState().setups.set(id, setup);
    return setup;
  }

  async retrieveSetup(id: string) {
    const setup = getLocalState().setups.get(id);
    if (!setup) throw new Error("local_setup_not_found");
    return setup;
  }

  async cancelSetup(id: string) {
    const current = await this.retrieveSetup(id);
    if (current.status === "succeeded")
      throw new Error("local_setup_already_succeeded");
    const canceled: LocalSetup = { ...current, status: "canceled" };
    getLocalState().setups.set(id, canceled);
    return canceled;
  }

  async retrieveCustomerPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ) {
    const method = getLocalState().methods.get(paymentMethodId);
    if (!method || method.customerId !== customerId)
      throw new Error("local_payment_method_not_attached");
    return method;
  }

  async detachPaymentMethod(id: string) {
    const method = await this.retrievePaymentMethod(id);
    const detached = { ...method, customerId: null };
    getLocalState().methods.set(id, detached);
    return detached;
  }

  async retrievePaymentMethod(id: string) {
    const method = getLocalState().methods.get(id);
    if (!method) throw new Error("local_payment_method_not_found");
    return method;
  }

  verifyWebhook(rawBody: string, signature: string) {
    verifyLocalWebhookSignature(rawBody, signature, this.#webhookSecret);
    const event = JSON.parse(rawBody) as {
      id?: unknown;
      type?: unknown;
      data?: { object?: { id?: unknown } };
    };
    if (typeof event.id !== "string" || typeof event.type !== "string")
      throw new Error("stripe_event_invalid");
    return {
      id: event.id,
      type: event.type,
      setupIntentId:
        event.type === "setup_intent.succeeded" &&
        typeof event.data?.object?.id === "string"
          ? event.data.object.id
          : null,
    };
  }

  async confirmLocalSetup(id: string) {
    const current = await this.retrieveSetup(id);
    const paymentMethodId = deterministicId("pm_local", id);
    getLocalState().methods.set(paymentMethodId, {
      id: paymentMethodId,
      customerId: current.customerId,
    });
    getLocalState().setups.set(id, {
      ...current,
      paymentMethodId,
      status: "succeeded",
    });
    const rawBody = JSON.stringify({
      id: deterministicId("evt_local", id),
      type: "setup_intent.succeeded",
      data: { object: { id } },
    });
    return {
      rawBody,
      signature: localWebhookSignature(rawBody, this.#webhookSecret),
    };
  }
}

function deterministicId(prefix: string, input: string) {
  return `${prefix}_${createHash("sha256").update(input).digest("hex").slice(0, 24)}`;
}

export function getStripeCardSignalProvider(
  config = getStripeCardSignalConfig(),
): StripeCardSignalProvider {
  return config.STRIPE_ADAPTER === "stripe"
    ? new StripeProvider(config)
    : new LocalStripeCardSignalProvider(config.webhookSecret);
}

export function newLocalIdempotencyKey() {
  return randomUUID();
}

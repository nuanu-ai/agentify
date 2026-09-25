import { CONSENT_POLICY_VERSION, DEFAULT_CONSENT } from "@agentify/analytics";
import {
  consentSnapshots,
  createUuidV7,
  emitStoredBusinessEvent,
  leadScans,
  paymentSignals,
  scans,
  sessions,
  webhookReceipts,
} from "@agentify/scanner-database";
import { and, desc, eq, sql } from "drizzle-orm";

import { ownedLead, type Visitor } from "./auth";
import { getServerConfig } from "./config";
import { sha256 } from "./crypto";
import { getDatabase } from "./database";
import { getStripeCardSignalConfig } from "./stripe-card-signal-config";
import { decryptPaymentMethodId, encryptPaymentMethodId } from "./stripe-card-signal-crypto";
import {
  getStripeCardSignalProvider,
  type StripeCardSignalProvider,
} from "./stripe-card-signal-provider";

export type CardSignalState = "not_started" | "setup_pending" | "attached" | "detached" | "failed";

export type SetupCardSignalResult =
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "unauthorized" }>
  | Readonly<{
      status: CardSignalState;
      signalId: string;
      clientSecret: string | null;
      adapter: "local" | "stripe";
    }>;

export async function setupCardSignal(input: {
  visitor: Visitor;
  scanId: string;
  idempotencyKey: string;
  provider?: StripeCardSignalProvider;
}): Promise<SetupCardSignalResult> {
  const cardConfig = getStripeCardSignalConfig();
  if (!cardConfig.CARD_SIGNAL_ENABLED) return { status: "disabled" };
  const leadId = await ownedLead(input.visitor, input.scanId);
  const verified = leadId === undefined ? undefined : { leadId };
  if (!verified) return { status: "unauthorized" };
  const { db } = getDatabase();
  const scan = (await db.select().from(scans).where(eq(scans.id, input.scanId)).limit(1))[0];
  if (!scan) return { status: "unauthorized" };

  const provider = input.provider ?? getStripeCardSignalProvider(cardConfig);
  const existing = (
    await db
      .select()
      .from(paymentSignals)
      .where(eq(paymentSignals.leadId, verified.leadId))
      .orderBy(desc(paymentSignals.createdAt))
      .limit(1)
  )[0];
  if (existing?.status === "attached" || existing?.status === "detached") {
    return {
      status: existing.status,
      signalId: existing.id,
      clientSecret: null,
      adapter: provider.adapter,
    };
  }
  if (existing?.status === "setup_pending") {
    try {
      const setup = await provider.retrieveSetup(existing.setupIntentId);
      return {
        status: existing.status,
        signalId: existing.id,
        clientSecret: setup.clientSecret,
        adapter: provider.adapter,
      };
    } catch {
      await db
        .update(paymentSignals)
        .set({ status: "failed" })
        .where(eq(paymentSignals.id, existing.id));
    }
  }

  const stableKey = sha256(`${verified.leadId}\0${input.idempotencyKey}`);
  const customerId =
    existing?.stripeCustomerId ??
    (await provider.createCustomer({
      leadId: verified.leadId,
      idempotencyKey: stableKey,
    }));
  const setup = await provider.createSetup({
    customerId,
    leadId: verified.leadId,
    scanId: scan.id,
    idempotencyKey: stableKey,
  });
  if (setup.usage !== "on_session") throw new Error("card_signal_usage_invariant_failed");

  const signalId = createUuidV7();
  const stored = await db.transaction(async (tx) => {
    const session = (
      await tx.select().from(sessions).where(eq(sessions.id, scan.sessionId)).limit(1)
    )[0];
    if (!session) throw new Error("card_signal_session_missing");
    const currentConsent = session.consentSnapshotId
      ? (
          await tx
            .select()
            .from(consentSnapshots)
            .where(eq(consentSnapshots.id, session.consentSnapshotId))
            .limit(1)
        )[0]
      : undefined;
    const categories = {
      ...DEFAULT_CONSENT,
      ...(currentConsent?.categories as Record<string, boolean> | undefined),
      essential_processing: true,
      card_signal: true,
    };
    const consentSnapshotId = createUuidV7();
    await tx.insert(consentSnapshots).values({
      id: consentSnapshotId,
      sessionId: session.id,
      policyVersion: currentConsent?.policyVersion ?? CONSENT_POLICY_VERSION,
      country: currentConsent?.country,
      categories,
      source: "card",
    });
    await tx
      .update(sessions)
      .set({ consentSnapshotId, lastSeenAt: new Date() })
      .where(eq(sessions.id, session.id));
    await tx
      .insert(paymentSignals)
      .values({
        id: signalId,
        leadId: verified.leadId,
        stripeCustomerId: customerId,
        setupIntentId: setup.id,
        status: "setup_pending",
        consentSnapshotId,
      })
      .onConflictDoNothing({ target: paymentSignals.setupIntentId });
    return (
      await tx
        .select()
        .from(paymentSignals)
        .where(eq(paymentSignals.setupIntentId, setup.id))
        .limit(1)
    )[0];
  });
  if (!stored) throw new Error("card_signal_persist_failed");
  return {
    status: stored.status,
    signalId: stored.id,
    clientSecret: setup.clientSecret,
    adapter: provider.adapter,
  };
}

export async function getCardSignalState(signalId: string, visitor: Visitor) {
  const leadId = await ownedLead(visitor);
  const verified = leadId === undefined ? undefined : { leadId };
  if (!verified) return undefined;
  const { db } = getDatabase();
  const signal = (
    await db
      .select({ id: paymentSignals.id, status: paymentSignals.status })
      .from(paymentSignals)
      .where(and(eq(paymentSignals.id, signalId), eq(paymentSignals.leadId, verified.leadId)))
      .limit(1)
  )[0];
  return signal;
}

export async function getOwnedCardSignalForReport(scanId: string, visitor: Visitor) {
  const leadId = await ownedLead(visitor, scanId);
  const verified = leadId === undefined ? undefined : { leadId };
  if (!verified) return undefined;
  const signal = (
    await getDatabase()
      .db.select()
      .from(paymentSignals)
      .where(eq(paymentSignals.leadId, verified.leadId))
      .orderBy(desc(paymentSignals.createdAt))
      .limit(1)
  )[0];
  if (!signal) return undefined;
  const config = getStripeCardSignalConfig();
  let clientSecret: string | null = null;
  if (signal.status === "setup_pending") {
    try {
      clientSecret = (await getStripeCardSignalProvider(config).retrieveSetup(signal.setupIntentId))
        .clientSecret;
    } catch {
      // Status still hydrates honestly; provider recovery remains retryable.
    }
  }
  return {
    signalId: signal.id,
    status: signal.status,
    clientSecret,
    adapter: config.STRIPE_ADAPTER,
  } as const;
}

export async function detachCardSignal(input: {
  signalId: string;
  visitor: Visitor;
  provider?: StripeCardSignalProvider;
}) {
  const leadId = await ownedLead(input.visitor);
  const verified = leadId === undefined ? undefined : { leadId };
  if (!verified) return undefined;
  const { db } = getDatabase();
  const signal = (
    await db
      .select()
      .from(paymentSignals)
      .where(and(eq(paymentSignals.id, input.signalId), eq(paymentSignals.leadId, verified.leadId)))
      .limit(1)
  )[0];
  if (!signal) return undefined;
  if (signal.status === "detached") return { status: "detached" as const };
  if (signal.status !== "attached" || !signal.paymentMethodIdCiphertext)
    return { status: signal.status };

  const methodId = decryptPaymentMethodId(
    signal.paymentMethodIdCiphertext,
    getServerConfig().encryptionKey,
  );
  const provider = input.provider ?? getStripeCardSignalProvider();
  const detached = await provider.detachPaymentMethod(methodId);
  const readback = await provider.retrievePaymentMethod(methodId);
  if (detached.id !== methodId || detached.customerId !== null || readback.customerId !== null) {
    throw new Error("card_signal_detach_readback_failed");
  }
  await db
    .update(paymentSignals)
    .set({ status: "detached", detachedAt: new Date() })
    .where(and(eq(paymentSignals.id, signal.id), eq(paymentSignals.status, "attached")));
  return { status: "detached" as const };
}

export async function processCardSignalWebhook(input: {
  rawBody: string;
  signature: string;
  provider?: StripeCardSignalProvider;
}) {
  const provider = input.provider ?? getStripeCardSignalProvider();
  const event = provider.verifyWebhook(input.rawBody, input.signature);
  const payloadHash = sha256(input.rawBody);
  const receipt = await registerReceipt(event.id, payloadHash);
  if (receipt === "duplicate") return { status: "duplicate" as const };
  try {
    if (event.type !== "setup_intent.succeeded" || !event.setupIntentId) {
      await completeReceipt(event.id);
      return { status: "ignored" as const };
    }
    const setup = await provider.retrieveSetup(event.setupIntentId);
    if (setup.status !== "succeeded" || setup.usage !== "on_session" || !setup.paymentMethodId) {
      throw new Error("card_signal_setup_readback_failed");
    }
    const method = await provider.retrieveCustomerPaymentMethod(
      setup.customerId,
      setup.paymentMethodId,
    );
    if (method.customerId !== setup.customerId)
      throw new Error("card_signal_customer_readback_failed");
    await attachFromReadback({
      eventId: event.id,
      setupIntentId: setup.id,
      customerId: setup.customerId,
      paymentMethodId: method.id,
      leadId: setup.leadId,
      scanId: setup.scanId,
    });
    return { status: "processed" as const };
  } catch (error) {
    await failReceipt(event.id);
    throw error;
  }
}

async function registerReceipt(eventId: string, payloadHash: string) {
  const { db } = getDatabase();
  return await db.transaction(async (tx) => {
    const leaseStartedAt = new Date();
    const inserted = await tx
      .insert(webhookReceipts)
      .values({
        provider: "stripe",
        providerEventId: eventId,
        payloadHash,
        processedAt: leaseStartedAt,
      })
      .onConflictDoNothing()
      .returning({ providerEventId: webhookReceipts.providerEventId });
    if (inserted[0]) return "received" as const;

    const receipt = (
      await tx
        .select({
          payloadHash: webhookReceipts.payloadHash,
          status: webhookReceipts.status,
          processedAt: webhookReceipts.processedAt,
        })
        .from(webhookReceipts)
        .where(
          and(eq(webhookReceipts.provider, "stripe"), eq(webhookReceipts.providerEventId, eventId)),
        )
        .limit(1)
    )[0];
    if (!receipt) throw new Error("stripe_receipt_conflict_without_row");
    if (receipt.payloadHash !== payloadHash) throw new Error("stripe_event_replay_mismatch");
    if (receipt.status === "processed") return "duplicate" as const;

    const staleBefore = new Date(leaseStartedAt.getTime() - 5 * 60_000);
    const claimed = await tx.execute<{ provider_event_id: string }>(
      sql`update webhook_receipts
          set status = 'received', processed_at = ${leaseStartedAt}
          where provider = 'stripe'
            and provider_event_id = ${eventId}
            and (
              status = 'failed'
              or (
                status = 'received'
                and (processed_at is null or processed_at < ${staleBefore})
              )
            )
          returning provider_event_id`,
    );
    if (!claimed.rows[0]) {
      return "duplicate" as const;
    }
    return "received" as const;
  });
}

async function completeReceipt(eventId: string) {
  const { db } = getDatabase();
  await db
    .update(webhookReceipts)
    .set({ status: "processed", processedAt: new Date() })
    .where(
      and(eq(webhookReceipts.provider, "stripe"), eq(webhookReceipts.providerEventId, eventId)),
    );
}

async function failReceipt(eventId: string) {
  const { db } = getDatabase();
  await db
    .update(webhookReceipts)
    .set({ status: "failed", processedAt: new Date() })
    .where(
      and(eq(webhookReceipts.provider, "stripe"), eq(webhookReceipts.providerEventId, eventId)),
    );
}

async function attachFromReadback(input: {
  eventId: string;
  setupIntentId: string;
  customerId: string;
  paymentMethodId: string;
  leadId: string;
  scanId: string;
}) {
  const { db } = getDatabase();
  await db.transaction(async (tx) => {
    const locked = await tx.execute<{
      id: string;
      lead_id: string;
      stripe_customer_id: string;
      status: CardSignalState;
      consent_snapshot_id: string;
    }>(
      sql`select id, lead_id, stripe_customer_id, status, consent_snapshot_id from payment_signals where setup_intent_id = ${input.setupIntentId} for update`,
    );
    const signal = locked.rows[0];
    if (
      !signal ||
      signal.lead_id !== input.leadId ||
      signal.stripe_customer_id !== input.customerId
    ) {
      throw new Error("card_signal_binding_mismatch");
    }
    const linked = (
      await tx
        .select({ leadId: leadScans.leadId })
        .from(leadScans)
        .where(and(eq(leadScans.leadId, signal.lead_id), eq(leadScans.scanId, input.scanId)))
        .limit(1)
    )[0];
    const scan = linked
      ? (await tx.select().from(scans).where(eq(scans.id, input.scanId)).limit(1))[0]
      : undefined;
    if (!scan) throw new Error("card_signal_scan_binding_mismatch");
    await tx
      .update(paymentSignals)
      .set({
        status: "attached",
        paymentMethodIdCiphertext: encryptPaymentMethodId(
          input.paymentMethodId,
          getServerConfig().encryptionKey,
        ),
        attachedAt: new Date(),
        detachedAt: null,
      })
      .where(eq(paymentSignals.id, signal.id));
    const session = (
      await tx.select().from(sessions).where(eq(sessions.id, scan.sessionId)).limit(1)
    )[0];
    if (!session) throw new Error("card_signal_event_session_missing");
    await emitStoredBusinessEvent(tx, {
      name: "card_attached",
      identifiers: { setup_intent_id: input.setupIntentId },
      sessionId: scan.sessionId,
      consentSnapshotId: signal.consent_snapshot_id,
      leadId: signal.lead_id,
      scanId: scan.id,
      segment: scan.segment,
      landingVariant: session.firstLandingVariant ?? "unknown",
      properties: { card_signal_version: "v1" },
    });
    await tx
      .update(webhookReceipts)
      .set({ status: "processed", processedAt: new Date() })
      .where(
        and(
          eq(webhookReceipts.provider, "stripe"),
          eq(webhookReceipts.providerEventId, input.eventId),
        ),
      );
  });
}

export async function confirmLocalCardSignal(input: {
  signalId: string;
  visitor: Visitor;
  provider?: StripeCardSignalProvider;
}) {
  const leadId = await ownedLead(input.visitor);
  const verified = leadId === undefined ? undefined : { leadId };
  if (!verified) return undefined;
  const config = getStripeCardSignalConfig();
  if (config.production || config.STRIPE_ADAPTER !== "local")
    throw new Error("local_card_confirmation_forbidden");
  const { db } = getDatabase();
  const signal = (
    await db
      .select()
      .from(paymentSignals)
      .where(and(eq(paymentSignals.id, input.signalId), eq(paymentSignals.leadId, verified.leadId)))
      .limit(1)
  )[0];
  if (!signal) return undefined;
  const provider = input.provider ?? getStripeCardSignalProvider(config);
  if (!provider.confirmLocalSetup) throw new Error("local_card_confirmation_unavailable");
  const event = await provider.confirmLocalSetup(signal.setupIntentId);
  await processCardSignalWebhook({ ...event, provider });
  return await getCardSignalState(signal.id, input.visitor);
}

/**
 * Mandatory pre-anonymization hook. A deletion worker must await this before
 * removing lead/provider linkage; any provider/readback error intentionally
 * aborts final deletion so an attached method is never orphaned.
 */
export async function detachLeadCardSignalsForDeletion(
  leadId: string,
  provider?: StripeCardSignalProvider,
) {
  const { db } = getDatabase();
  const signals = await db.select().from(paymentSignals).where(eq(paymentSignals.leadId, leadId));
  const activeSignals = signals.filter(
    (signal) =>
      !signal.setupIntentId.startsWith("deleted:") &&
      !signal.stripeCustomerId.startsWith("deleted:"),
  );
  if (!activeSignals.length) return { detachedCount: 0, customersDeleted: 0 } as const;
  const cardProvider = provider ?? getStripeCardSignalProvider();
  const customerIds = new Set<string>();
  for (const signal of signals) {
    if (
      signal.setupIntentId.startsWith("deleted:") ||
      signal.stripeCustomerId.startsWith("deleted:")
    )
      continue;
    const setup = await cardProvider.retrieveSetup(signal.setupIntentId);
    customerIds.add(setup.customerId);
    if (setup.customerId !== signal.stripeCustomerId)
      throw new Error("card_signal_deletion_customer_mismatch");
    const storedMethodId = signal.paymentMethodIdCiphertext
      ? decryptPaymentMethodId(signal.paymentMethodIdCiphertext, getServerConfig().encryptionKey)
      : null;
    if (storedMethodId && setup.paymentMethodId && storedMethodId !== setup.paymentMethodId) {
      throw new Error("card_signal_deletion_method_mismatch");
    }
    const methodId = storedMethodId ?? setup.paymentMethodId;
    if (methodId) {
      const current = await cardProvider.retrievePaymentMethod(methodId);
      if (current.customerId !== null && current.customerId !== setup.customerId)
        throw new Error("card_signal_deletion_binding_mismatch");
      if (current.customerId === setup.customerId) {
        const detached = await cardProvider.detachPaymentMethod(methodId);
        if (detached.customerId !== null) throw new Error("card_signal_deletion_detach_failed");
      }
      const readback = await cardProvider.retrievePaymentMethod(methodId);
      if (readback.customerId !== null)
        throw new Error("card_signal_deletion_detach_readback_failed");
    } else if (setup.status !== "canceled") {
      const canceled = await cardProvider.cancelSetup(setup.id);
      const readback = await cardProvider.retrieveSetup(setup.id);
      if (canceled.status !== "canceled" || readback.status !== "canceled")
        throw new Error("card_signal_deletion_cancel_readback_failed");
    }
  }
  for (const customerId of customerIds) {
    const customer = await cardProvider.retrieveCustomer(customerId);
    if (!customer.deleted) {
      const deleted = await cardProvider.deleteCustomer(customerId);
      if (!deleted.deleted) throw new Error("card_signal_deletion_customer_delete_failed");
    }
    const readback = await cardProvider.retrieveCustomer(customerId);
    if (!readback.deleted) throw new Error("card_signal_deletion_customer_readback_failed");
  }
  const detachedAt = new Date();
  await db
    .update(paymentSignals)
    .set({ status: "detached", detachedAt })
    .where(eq(paymentSignals.leadId, leadId));
  return {
    detachedCount: activeSignals.length,
    customersDeleted: customerIds.size,
  } as const;
}

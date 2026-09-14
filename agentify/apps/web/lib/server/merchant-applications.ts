import {
  MERCHANT_APPLICATION_POLICY,
  MERCHANT_APPLICATION_RETENTION_DAYS,
  type MerchantApplication,
} from "@b2a/contracts";
import { createUuidV7, merchantApplications } from "@b2a/db";
import { eq, sql } from "drizzle-orm";

import { getServerConfig } from "./config";
import { encryptSensitiveValue, hmacHex } from "./crypto";
import { getDatabase } from "./database";
import { consumeRateLimitsAtomically } from "./rate-limit";

export async function saveMerchantApplication(
  body: MerchantApplication,
  idempotencyKey: string,
  ip: string,
) {
  const config = getServerConfig();
  const payload = JSON.stringify(body);
  const idempotencyKeyHash = hmacHex(
    config.hmacSecret,
    "merchant-idempotency",
    idempotencyKey,
  );
  const requestHash = hmacHex(config.hmacSecret, "merchant-body", payload);
  return getDatabase().db.transaction(async (tx) => {
    // Serialise retries before consuming limits; one key produces one durable row.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`merchant:${idempotencyKeyHash}`}, 0))`,
    );
    const [existing] = await tx
      .select({ requestHash: merchantApplications.requestHash })
      .from(merchantApplications)
      .where(eq(merchantApplications.idempotencyKeyHash, idempotencyKeyHash))
      .limit(1);
    if (existing)
      return existing.requestHash === requestHash ? "received" : "conflict";
    const now = new Date();
    const limits = await consumeRateLimitsAtomically(
      [
        {
          kind: "merchant_ip_hour",
          keyHash: hmacHex(config.hmacSecret, "merchant-ip", ip),
          limit: 5,
        },
        {
          kind: "merchant_email_hour",
          keyHash: hmacHex(config.hmacSecret, "merchant-email", body.email),
          limit: 3,
        },
      ],
      now,
      tx,
    );
    if (!limits.allowed) return "rate_limited";
    await tx.insert(merchantApplications).values({
      id: createUuidV7(),
      idempotencyKeyHash,
      requestHash,
      payloadCiphertext: encryptSensitiveValue(payload, config.encryptionKey),
      policyVersion: MERCHANT_APPLICATION_POLICY,
      createdAt: now,
      expiresAt: new Date(
        now.getTime() + MERCHANT_APPLICATION_RETENTION_DAYS * 86_400_000,
      ),
    });
    return "received";
  });
}

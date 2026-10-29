import {
  CONSENT_POLICY_VERSION,
  type ConsentCategories,
  createConsentSnapshot,
} from "@agentify/analytics";
import { countedClient } from "@agentify/scanner/ip";
import { consentSnapshots, createUuidV7, sessions } from "@agentify/scanner-database";
import { eq } from "drizzle-orm";

import { getServerConfig } from "./config";
import { hmacHex, randomCapability } from "./crypto";
import { getDatabase } from "./database";
import { consumeRateLimitsAtomically } from "./rate-limit";

export const CONSENT_COOKIE = "agentify_anonymous";

const sameCategories = (left: unknown, right: ConsentCategories): boolean => {
  if (!left || typeof left !== "object") return false;
  return Object.entries(right).every(
    ([key, value]) => (left as Record<string, unknown>)[key] === value,
  );
};

/**
 * New visits one visitor's address may open in a rolling hour by saving a
 * choice: three times the scans it may start, since every new browser saves
 * one whether it scans or not, and an office's or a carrier's visitors share
 * an address. A returning visitor's change opens nothing and is not counted.
 */
const NEW_VISITS_PER_CLIENT_HOUR = 30;
/**
 * The same, together, for every choice whose address names no visitor: on a
 * channel whose ingress hides visitors' addresses, all of its visitors.
 */
const NEW_VISITS_PER_UNKNOWN_CLIENT_HOUR = 300;

export type ConsentSaved =
  | Readonly<{ saved: true; anonymousToken?: string; snapshotId: string }>
  | Readonly<{ saved: false; retryAt: Date }>;

export const persistConsentSnapshot = async (input: {
  anonymousToken?: string;
  decisions: Partial<ConsentCategories>;
  /** The address the request came from, which a new visit is counted against. */
  clientAddress: string;
}): Promise<ConsentSaved> => {
  const config = getServerConfig();
  const { db } = getDatabase();
  const suppliedHash = input.anonymousToken
    ? hmacHex(config.hmacSecret, "anonymous", input.anonymousToken)
    : undefined;
  const snapshot = createConsentSnapshot({
    policyVersion: CONSENT_POLICY_VERSION,
    decisions: input.decisions,
    source: "banner",
  });

  return await db.transaction(async (tx) => {
    let session = suppliedHash
      ? (
          await tx
            .select()
            .from(sessions)
            .where(eq(sessions.anonymousIdHash, suppliedHash))
            .limit(1)
        )[0]
      : undefined;
    let anonymousToken: string | undefined;
    if (!session) {
      const client = countedClient(input.clientAddress);
      const quota = await consumeRateLimitsAtomically(
        [
          {
            keyHash: hmacHex(
              config.hmacSecret,
              "consent-ip",
              client.visitor ? client.key : "unknown",
            ),
            kind: "consent_ip_hour",
            limit: client.visitor ? NEW_VISITS_PER_CLIENT_HOUR : NEW_VISITS_PER_UNKNOWN_CLIENT_HOUR,
          },
        ],
        new Date(),
        tx,
      );
      if (!quota.allowed) return { saved: false, retryAt: quota.retryAt };
      anonymousToken = randomCapability();
      const sessionId = createUuidV7();
      await tx.insert(sessions).values({
        id: sessionId,
        anonymousIdHash: hmacHex(config.hmacSecret, "anonymous", anonymousToken),
      });
      session = (await tx.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1))[0];
    }
    if (!session) throw new Error("consent_session_creation_failed");

    if (session.consentSnapshotId) {
      const current = (
        await tx
          .select()
          .from(consentSnapshots)
          .where(eq(consentSnapshots.id, session.consentSnapshotId))
          .limit(1)
      )[0];
      if (
        current?.policyVersion === snapshot.policyVersion &&
        sameCategories(current.categories, snapshot.categories)
      ) {
        return {
          saved: true,
          ...(anonymousToken ? { anonymousToken } : {}),
          snapshotId: current.id,
        };
      }
    }

    const snapshotId = createUuidV7();
    await tx.insert(consentSnapshots).values({
      id: snapshotId,
      sessionId: session.id,
      policyVersion: snapshot.policyVersion,
      categories: snapshot.categories,
      capturedAt: new Date(snapshot.capturedAt),
      source: snapshot.source,
    });
    await tx
      .update(sessions)
      .set({ consentSnapshotId: snapshotId, lastSeenAt: new Date() })
      .where(eq(sessions.id, session.id));
    return { saved: true, ...(anonymousToken ? { anonymousToken } : {}), snapshotId };
  });
};

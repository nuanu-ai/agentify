import {
  CONSENT_POLICY_VERSION,
  type ConsentCategories,
  createConsentSnapshot,
} from "@agentify/analytics";
import {
  consentSnapshots,
  createUuidV7,
  sessions,
} from "@agentify/scanner-database";
import { eq } from "drizzle-orm";

import { getServerConfig } from "./config";
import { hmacHex, randomCapability } from "./crypto";
import { getDatabase } from "./database";

export const CONSENT_COOKIE = "agentify_anonymous";

const sameCategories = (left: unknown, right: ConsentCategories): boolean => {
  if (!left || typeof left !== "object") return false;
  return Object.entries(right).every(
    ([key, value]) => (left as Record<string, unknown>)[key] === value,
  );
};

export const persistConsentSnapshot = async (input: {
  anonymousToken?: string;
  decisions: Partial<ConsentCategories>;
  country?: string;
}): Promise<{ anonymousToken?: string; snapshotId: string }> => {
  const config = getServerConfig();
  const { db } = getDatabase();
  const suppliedHash = input.anonymousToken
    ? hmacHex(config.hmacSecret, "anonymous", input.anonymousToken)
    : undefined;
  const snapshot = createConsentSnapshot({
    policy: {
      policyVersion: CONSENT_POLICY_VERSION,
      requireOptInForAdsMeasurement: true,
      requireOptInForProductAnalytics: true,
    },
    decisions: input.decisions,
    ...(input.country ? { country: input.country } : {}),
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
      anonymousToken = randomCapability();
      const sessionId = createUuidV7();
      await tx.insert(sessions).values({
        id: sessionId,
        anonymousIdHash: hmacHex(
          config.hmacSecret,
          "anonymous",
          anonymousToken,
        ),
      });
      session = (
        await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1)
      )[0];
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
      country: snapshot.country,
      categories: snapshot.categories,
      capturedAt: new Date(snapshot.capturedAt),
      source: snapshot.source,
    });
    await tx
      .update(sessions)
      .set({ consentSnapshotId: snapshotId, lastSeenAt: new Date() })
      .where(eq(sessions.id, session.id));
    return { ...(anonymousToken ? { anonymousToken } : {}), snapshotId };
  });
};

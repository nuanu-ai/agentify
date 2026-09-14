import { CONSENT_POLICY_VERSION } from "@agentify/analytics";
import {
  consentSnapshots,
  createUuidV7,
  sessions,
} from "@agentify/scanner-database";
import type { Segment } from "@agentify/scanner-contracts";
import { eq } from "drizzle-orm";

import { getServerConfig } from "./config";
import { hmacHex, randomCapability } from "./crypto";
import { getDatabase } from "./database";

export type AttributionTouch = Readonly<{
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid_hash?: string;
}>;

export const PARTNER_CLICK_ID_COOKIE = "clickid";

export async function persistAttributionTouch(input: {
  anonymousToken?: string;
  segment: Segment;
  landingVariant: string;
  touch: AttributionTouch;
  partnerClickId?: string;
}): Promise<{
  anonymousToken?: string;
  sessionId: string;
  partnerClickIdAccepted: boolean;
}> {
  const config = getServerConfig();
  const suppliedHash = input.anonymousToken
    ? hmacHex(config.hmacSecret, "anonymous", input.anonymousToken)
    : undefined;
  const { db } = getDatabase();
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
      const consentId = createUuidV7();
      await tx.insert(sessions).values({
        id: sessionId,
        anonymousIdHash: hmacHex(
          config.hmacSecret,
          "anonymous",
          anonymousToken,
        ),
        firstLandingVariant: input.landingVariant,
        firstUtmSource: input.touch.utm_source ?? null,
        firstUtmMedium: input.touch.utm_medium ?? null,
        firstUtmCampaign: input.touch.utm_campaign ?? null,
        firstUtmContent: input.touch.utm_content ?? null,
        firstUtmTerm: input.touch.utm_term ?? null,
        firstFbclidHash: input.touch.fbclid_hash ?? null,
        lastLandingVariant: input.landingVariant,
        lastUtmSource: input.touch.utm_source ?? null,
        lastUtmMedium: input.touch.utm_medium ?? null,
        lastUtmCampaign: input.touch.utm_campaign ?? null,
        lastUtmContent: input.touch.utm_content ?? null,
        lastUtmTerm: input.touch.utm_term ?? null,
        lastFbclidHash: input.touch.fbclid_hash ?? null,
      });
      await tx.insert(consentSnapshots).values({
        id: consentId,
        sessionId,
        policyVersion: CONSENT_POLICY_VERSION,
        categories: {
          essential_processing: true,
          product_analytics: false,
          ads_measurement: false,
          marketing_email: false,
          dataset_reuse: false,
          card_signal: false,
        },
        source: "landing_attribution",
      });
      await tx
        .update(sessions)
        .set({ consentSnapshotId: consentId })
        .where(eq(sessions.id, sessionId));
      session = (
        await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1)
      )[0];
    } else {
      const firstTouch = !session.firstLandingVariant;
      let consentSnapshotId = session.consentSnapshotId;
      if (!consentSnapshotId) {
        consentSnapshotId = createUuidV7();
        await tx.insert(consentSnapshots).values({
          id: consentSnapshotId,
          sessionId: session.id,
          policyVersion: CONSENT_POLICY_VERSION,
          categories: {
            essential_processing: true,
            product_analytics: false,
            ads_measurement: false,
            marketing_email: false,
            dataset_reuse: false,
            card_signal: false,
          },
          source: "landing_attribution",
        });
      }
      await tx
        .update(sessions)
        .set({
          ...(firstTouch
            ? {
                firstLandingVariant: input.landingVariant,
                firstUtmSource: input.touch.utm_source ?? null,
                firstUtmMedium: input.touch.utm_medium ?? null,
                firstUtmCampaign: input.touch.utm_campaign ?? null,
                firstUtmContent: input.touch.utm_content ?? null,
                firstUtmTerm: input.touch.utm_term ?? null,
                firstFbclidHash: input.touch.fbclid_hash ?? null,
              }
            : {}),
          lastLandingVariant: input.landingVariant,
          lastUtmSource: input.touch.utm_source ?? null,
          lastUtmMedium: input.touch.utm_medium ?? null,
          lastUtmCampaign: input.touch.utm_campaign ?? null,
          lastUtmContent: input.touch.utm_content ?? null,
          lastUtmTerm: input.touch.utm_term ?? null,
          lastFbclidHash: input.touch.fbclid_hash ?? null,
          consentSnapshotId,
          lastSeenAt: new Date(),
        })
        .where(eq(sessions.id, session.id));
    }
    if (!session) throw new Error("attribution_session_creation_failed");
    const currentSession = (
      await tx
        .select({ consentSnapshotId: sessions.consentSnapshotId })
        .from(sessions)
        .where(eq(sessions.id, session.id))
        .limit(1)
    )[0];
    const currentConsent = currentSession?.consentSnapshotId
      ? (
          await tx
            .select({ categories: consentSnapshots.categories })
            .from(consentSnapshots)
            .where(eq(consentSnapshots.id, currentSession.consentSnapshotId))
            .limit(1)
        )[0]
      : undefined;
    const partnerClickIdAccepted =
      Boolean(input.partnerClickId) &&
      typeof currentConsent?.categories === "object" &&
      currentConsent.categories !== null &&
      (currentConsent.categories as Record<string, unknown>).ads_measurement ===
        true;
    return {
      ...(anonymousToken ? { anonymousToken } : {}),
      sessionId: session.id,
      partnerClickIdAccepted,
    };
  });
}

import { type ConsentCategories, consentAllowsMeasurement } from "@agentify/analytics";
import type { Segment } from "@agentify/scanner-contracts";
import { consentSnapshots, sessions } from "@agentify/scanner-database";
import { eq } from "drizzle-orm";

import { getServerConfig } from "./config";
import { hmacHex } from "./crypto";
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

/**
 * Keeps the campaign a visit arrived from, for a visitor who allowed optional
 * measurement. A visit is known by the session its cookie names, and that
 * session carries the visitor's choice; without both, or with a choice that
 * allows no measurement, nothing is written and no session is opened.
 */
export async function persistAttributionTouch(input: {
  anonymousToken?: string;
  segment: Segment;
  landingVariant: string;
  touch: AttributionTouch;
  partnerClickId?: string;
}): Promise<{ partnerClickIdAccepted: boolean }> {
  if (!input.anonymousToken) return { partnerClickIdAccepted: false };
  const anonymousHash = hmacHex(getServerConfig().hmacSecret, "anonymous", input.anonymousToken);
  const { db } = getDatabase();
  return await db.transaction(async (tx) => {
    const session = (
      await tx.select().from(sessions).where(eq(sessions.anonymousIdHash, anonymousHash)).limit(1)
    )[0];
    const consent = session?.consentSnapshotId
      ? (
          await tx
            .select({ categories: consentSnapshots.categories })
            .from(consentSnapshots)
            .where(eq(consentSnapshots.id, session.consentSnapshotId))
            .limit(1)
        )[0]
      : undefined;
    const categories =
      typeof consent?.categories === "object" && consent.categories !== null
        ? (consent.categories as Partial<ConsentCategories>)
        : {};
    if (!session || !consentAllowsMeasurement(categories)) return { partnerClickIdAccepted: false };

    const firstTouch = !session.firstLandingVariant;
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
        lastSeenAt: new Date(),
      })
      .where(eq(sessions.id, session.id));
    return {
      partnerClickIdAccepted: Boolean(input.partnerClickId) && categories.ads_measurement === true,
    };
  });
}

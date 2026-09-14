import { clientAnalyticsEventRequestSchema } from "@b2a/contracts";
import { emitStoredBusinessEvent, scans, sessions } from "@b2a/db";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import {
  getVerifiedSession,
  REPORT_SESSION_COOKIE,
} from "../../../../lib/server/auth";
import { getServerConfig } from "../../../../lib/server/config";
import { hmacHex } from "../../../../lib/server/crypto";
import { getDatabase } from "../../../../lib/server/database";
import {
  bearerToken,
  errorResponse,
  hasSameOrigin,
} from "../../../../lib/server/http";
import { ANONYMOUS_COOKIE, authorizeScan } from "../../../../lib/server/scans";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return errorResponse(
      request,
      403,
      "invalid_origin",
      "The request origin is not allowed.",
    );
  }
  const parsed = clientAnalyticsEventRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return errorResponse(
      request,
      400,
      "invalid_event",
      "The analytics event is invalid.",
    );
  }

  const { db } = getDatabase();
  const body = parsed.data;
  let eventProperties: Record<string, string | number | boolean> = {};
  let context:
    | {
        sessionId: string;
        consentSnapshotId: string;
        segment: "store" | "owner" | "local";
        landingVariant: string;
        leadId?: string;
        scanId?: string;
        identifiers: Record<string, string>;
      }
    | undefined;

  if (body.name === "landing_view") {
    const anonymousToken = request.cookies.get(ANONYMOUS_COOKIE)?.value;
    if (!anonymousToken || !body.segment || !body.landing_variant) {
      return errorResponse(
        request,
        404,
        "analytics_context_not_found",
        "Analytics context was not found.",
      );
    }
    const anonymousHash = hmacHex(
      getServerConfig().hmacSecret,
      "anonymous",
      anonymousToken,
    );
    const session = (
      await db
        .select()
        .from(sessions)
        .where(eq(sessions.anonymousIdHash, anonymousHash))
        .limit(1)
    )[0];
    if (!session?.consentSnapshotId) {
      return errorResponse(
        request,
        404,
        "analytics_context_not_found",
        "Analytics context was not found.",
      );
    }
    context = {
      sessionId: session.id,
      consentSnapshotId: session.consentSnapshotId,
      segment: body.segment,
      landingVariant: body.landing_variant,
      identifiers: {
        session_id: session.id,
        variant: body.landing_variant,
        day: new Date().toISOString().slice(0, 10),
      },
    };
    eventProperties = { day: new Date().toISOString().slice(0, 10) };
  } else if (body.name === "registration_started" && body.scan_id) {
    const bearer = bearerToken(request);
    const scan = bearer ? await authorizeScan(body.scan_id, bearer) : undefined;
    if (!scan || scan.accessTokenExpiresAt <= new Date()) {
      return errorResponse(
        request,
        404,
        "analytics_context_not_found",
        "Analytics context was not found.",
      );
    }
    const session = (
      await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, scan.sessionId))
        .limit(1)
    )[0];
    if (!session?.consentSnapshotId) {
      return errorResponse(
        request,
        404,
        "analytics_context_not_found",
        "Analytics context was not found.",
      );
    }
    context = {
      sessionId: session.id,
      consentSnapshotId: session.consentSnapshotId,
      segment: scan.segment,
      landingVariant: session.firstLandingVariant ?? "unknown",
      scanId: scan.id,
      identifiers: { session_id: session.id, scan_id: scan.id },
    };
  } else if (body.name === "results_viewed" && body.scan_id) {
    const verified = await getVerifiedSession(
      request.cookies.get(REPORT_SESSION_COOKIE)?.value,
      body.scan_id,
    );
    const bearer = bearerToken(request);
    const capabilityScan = bearer
      ? await authorizeScan(body.scan_id, bearer)
      : undefined;
    const scan =
      verified || capabilityScan
        ? (
            await db
              .select()
              .from(scans)
              .where(eq(scans.id, body.scan_id))
              .limit(1)
          )[0]
        : undefined;
    const session = scan
      ? (
          await db
            .select()
            .from(sessions)
            .where(eq(sessions.id, scan.sessionId))
            .limit(1)
        )[0]
      : undefined;
    if (
      (!verified && !capabilityScan) ||
      !scan ||
      !session?.consentSnapshotId
    ) {
      return errorResponse(
        request,
        404,
        "analytics_context_not_found",
        "Analytics context was not found.",
      );
    }
    context = {
      sessionId: session.id,
      consentSnapshotId: session.consentSnapshotId,
      segment: scan.segment,
      landingVariant: session.firstLandingVariant ?? "unknown",
      leadId: verified?.leadId,
      scanId: scan.id,
      identifiers: { session_id: session.id, scan_id: scan.id },
    };
    const coverage = Number(scan.coverage ?? 0);
    eventProperties = {
      coverage_band:
        coverage >= 0.9 ? "high" : coverage >= 0.7 ? "medium" : "low",
    };
  }

  if (!context) {
    return errorResponse(
      request,
      400,
      "invalid_event_context",
      "The event context is invalid.",
    );
  }

  let stored: { inserted: boolean; eventId: string };
  try {
    stored = await db.transaction(
      async (tx) =>
        await emitStoredBusinessEvent(tx, {
          eventId: body.event_id,
          name: body.name,
          identifiers: context.identifiers,
          sessionId: context.sessionId,
          consentSnapshotId: context.consentSnapshotId,
          leadId: context.leadId,
          scanId: context.scanId,
          segment: context.segment,
          landingVariant: context.landingVariant,
          properties: { ...body.properties, ...eventProperties },
        }),
    );
  } catch {
    return errorResponse(
      request,
      503,
      "analytics_unavailable",
      "The event could not be recorded.",
      true,
      5,
    );
  }
  return NextResponse.json(
    {
      status: stored.inserted ? "recorded" : "already_recorded",
      event_id: stored.eventId,
      segment: context.segment,
      landing_variant: context.landingVariant,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

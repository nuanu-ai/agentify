import { CONSENT_POLICY_VERSION } from "@b2a/analytics/browser";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  CONSENT_COOKIE,
  persistConsentSnapshot,
} from "../../../../lib/server/consent";
import { PARTNER_CLICK_ID_COOKIE } from "../../../../lib/server/attribution";
import { getServerConfig } from "../../../../lib/server/config";
import { errorResponse, hasSameOrigin } from "../../../../lib/server/http";

export const runtime = "nodejs";

const categoriesSchema = z
  .object({
    essential_processing: z.literal(true),
    product_analytics: z.boolean(),
    ads_measurement: z.boolean(),
    marketing_email: z.literal(false),
    dataset_reuse: z.literal(false),
    card_signal: z.literal(false),
  })
  .strict();

const requestSchema = z
  .object({
    policy_version: z.literal(CONSENT_POLICY_VERSION),
    categories: categoriesSchema,
  })
  .strict();

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request)) {
    return errorResponse(
      request,
      403,
      "origin_forbidden",
      "Request origin is not allowed.",
    );
  }
  const parsed = requestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return errorResponse(
      request,
      400,
      "invalid_consent",
      "Consent preferences are invalid.",
    );
  }
  const countryHeader = request.headers.get("x-vercel-ip-country");
  const country =
    countryHeader && /^[A-Z]{2}$/i.test(countryHeader)
      ? countryHeader
      : undefined;
  try {
    const result = await persistConsentSnapshot({
      anonymousToken: request.cookies.get(CONSENT_COOKIE)?.value,
      decisions: parsed.data.categories,
      ...(country ? { country } : {}),
    });
    const response = NextResponse.json(
      { status: "saved", policy_version: CONSENT_POLICY_VERSION },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
    if (result.anonymousToken) {
      response.cookies.set(CONSENT_COOKIE, result.anonymousToken, {
        httpOnly: true,
        secure: getServerConfig().production,
        sameSite: "lax",
        path: "/",
        maxAge: 13 * 30 * 24 * 60 * 60,
      });
    }
    if (!parsed.data.categories.ads_measurement) {
      response.cookies.set(PARTNER_CLICK_ID_COOKIE, "", {
        httpOnly: true,
        secure: getServerConfig().production,
        sameSite: "lax",
        path: "/",
        maxAge: 0,
      });
    }
    return response;
  } catch {
    return errorResponse(
      request,
      503,
      "consent_unavailable",
      "Consent preferences could not be saved.",
      true,
      5,
    );
  }
}

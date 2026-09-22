import { partnerClickIdSchema } from "@agentify/scanner-contracts";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  PARTNER_CLICK_ID_COOKIE,
  persistAttributionTouch,
} from "../../../../lib/server/attribution";
import { getServerConfig } from "../../../../lib/server/config";
import { errorResponse, hasSameOrigin } from "../../../../lib/server/http";
import { ANONYMOUS_COOKIE } from "../../../../lib/server/scans";

export const runtime = "nodejs";

const campaignValue = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~ +%-]*$/)
  .refine((value) => !/\d{7,}/.test(value), "Possible PII is not allowed");
const requestSchema = z
  .object({
    segment: z.enum(["store", "owner", "local"]),
    landing_variant: z.string().min(1).max(100),
    partner_click_id: partnerClickIdSchema.optional(),
    touch: z
      .object({
        utm_source: campaignValue.optional(),
        utm_medium: campaignValue.optional(),
        utm_campaign: campaignValue.optional(),
        utm_content: campaignValue.optional(),
        utm_term: campaignValue.optional(),
        fbclid_hash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict(),
  })
  .strict();

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request))
    return errorResponse(
      request,
      403,
      "invalid_origin",
      "The request origin is not allowed.",
    );
  const parsed = requestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return errorResponse(
      request,
      400,
      "invalid_attribution",
      "Campaign attribution is invalid.",
    );
  try {
    const result = await persistAttributionTouch({
      anonymousToken: request.cookies.get(ANONYMOUS_COOKIE)?.value,
      segment: parsed.data.segment,
      landingVariant: parsed.data.landing_variant,
      touch: parsed.data.touch,
      partnerClickId: parsed.data.partner_click_id,
    });
    const response = new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
    if (result.anonymousToken) {
      response.cookies.set(ANONYMOUS_COOKIE, result.anonymousToken, {
        httpOnly: true,
        secure: getServerConfig().production,
        sameSite: "lax",
        path: "/",
        maxAge: 30 * 86_400,
      });
    }
    if (result.partnerClickIdAccepted && parsed.data.partner_click_id) {
      response.cookies.set(
        PARTNER_CLICK_ID_COOKIE,
        parsed.data.partner_click_id,
        {
          httpOnly: true,
          secure: getServerConfig().production,
          sameSite: "lax",
          path: "/",
          maxAge: 30 * 86_400,
        },
      );
    }
    return response;
  } catch {
    return errorResponse(
      request,
      503,
      "attribution_unavailable",
      "Campaign attribution could not be saved.",
      true,
      5,
    );
  }
}

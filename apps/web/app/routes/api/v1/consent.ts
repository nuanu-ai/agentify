import { CONSENT_POLICY_VERSION } from "@agentify/analytics/browser";
import { z } from "zod";
import { getServerConfig } from "../../../../lib/server/config";
import { CONSENT_COOKIE, persistConsentSnapshot } from "../../../../lib/server/consent";
import { cookieHeader, readCookie } from "../../../../lib/server/cookies";
import { errorResponse, hasSameOrigin } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";

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

/**
 * Browsers may still hold the partner click cookie an earlier release set for a
 * visitor who allowed ads measurement; a choice saved without ads measurement
 * removes it, with the name, path and attributes it was set with.
 */
const PARTNER_CLICK_COOKIE = "clickid";

const requestSchema = z
  .object({
    policy_version: z.literal(CONSENT_POLICY_VERSION),
    categories: categoriesSchema,
  })
  .strict();

async function consent(request: Request): Promise<Response> {
  if (!hasSameOrigin(request)) {
    return errorResponse(request, 403, "origin_forbidden", "Request origin is not allowed.");
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(request, 400, "invalid_consent", "Consent preferences are invalid.");
  }
  try {
    const result = await persistConsentSnapshot({
      anonymousToken: readCookie(request, CONSENT_COOKIE),
      decisions: parsed.data.categories,
    });
    const response = Response.json(
      { status: "saved", policy_version: CONSENT_POLICY_VERSION },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
    if (result.anonymousToken) {
      response.headers.append(
        "Set-Cookie",
        cookieHeader(CONSENT_COOKIE, result.anonymousToken, {
          httpOnly: true,
          secure: getServerConfig().production,
          sameSite: "lax",
          path: "/",
          maxAge: 13 * 30 * 24 * 60 * 60,
        }),
      );
    }
    if (!parsed.data.categories.ads_measurement) {
      response.headers.append(
        "Set-Cookie",
        cookieHeader(PARTNER_CLICK_COOKIE, "", {
          httpOnly: true,
          secure: getServerConfig().production,
          sameSite: "lax",
          path: "/",
          maxAge: 0,
        }),
      );
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

export const loader = methods({ POST: consent });
export const action = loader;

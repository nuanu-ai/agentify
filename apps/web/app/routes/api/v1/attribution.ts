import { z } from "zod";
import { persistAttributionTouch } from "../../../../lib/server/attribution";
import { readCookie } from "../../../../lib/server/cookies";
import { errorResponse, hasSameOrigin } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { ANONYMOUS_COOKIE } from "../../../../lib/server/scans";

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

async function attribute(request: Request): Promise<Response> {
  if (!hasSameOrigin(request))
    return errorResponse(request, 403, "invalid_origin", "The request origin is not allowed.");
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return errorResponse(request, 400, "invalid_attribution", "Campaign attribution is invalid.");
  try {
    await persistAttributionTouch({
      anonymousToken: readCookie(request, ANONYMOUS_COOKIE),
      segment: parsed.data.segment,
      landingVariant: parsed.data.landing_variant,
      touch: parsed.data.touch,
    });
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
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

export const loader = methods({ POST: attribute });
export const action = loader;

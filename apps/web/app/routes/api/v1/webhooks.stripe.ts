import { errorResponse } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { processCardSignalWebhook } from "../../../../lib/server/stripe-card-signal";

async function stripeEvent(request: Request): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  if (!signature)
    return errorResponse(
      request,
      400,
      "stripe_signature_missing",
      "The webhook signature is missing.",
    );
  // Stripe signs the body's bytes as sent, so nothing in the process may read
  // or parse the body before this.
  const rawBody = await request.text();
  try {
    const result = await processCardSignalWebhook({ rawBody, signature });
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return errorResponse(
      request,
      400,
      "stripe_webhook_rejected",
      "The webhook could not be verified or processed.",
      true,
    );
  }
}

export const loader = methods({ POST: stripeEvent });
export const action = loader;

import { NextResponse } from "next/server";

import { errorResponse } from "../../../../../lib/server/http";
import { processCardSignalWebhook } from "../../../../../lib/server/stripe-card-signal";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature)
    return errorResponse(
      request,
      400,
      "stripe_signature_missing",
      "The webhook signature is missing.",
    );
  const rawBody = await request.text();
  try {
    const result = await processCardSignalWebhook({ rawBody, signature });
    return NextResponse.json(result, {
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

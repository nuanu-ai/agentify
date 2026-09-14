import { merchantApplicationSchema } from "@agentify/scanner-contracts";
import { NextResponse } from "next/server";

import {
  errorResponse,
  hasSameOrigin,
  logServerError,
  requestHeaders,
} from "../../../../lib/server/http";
import { saveMerchantApplication } from "../../../../lib/server/merchant-applications";

export const runtime = "nodejs";

async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8_192) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function POST(request: Request) {
  try {
    if (!hasSameOrigin(request))
      return errorResponse(
        request,
        403,
        "invalid_origin",
        "Please submit the form from Agentify.",
      );
    if (
      request.headers.get("content-type")?.split(";")[0]?.trim() !==
      "application/json"
    )
      return errorResponse(
        request,
        415,
        "invalid_content_type",
        "Please submit the application form.",
      );
    const key = request.headers.get("idempotency-key") ?? "";
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key))
      return errorResponse(
        request,
        400,
        "invalid_idempotency_key",
        "Please reload the page and try again.",
      );
    let raw: unknown;
    try {
      raw = await readBody(request);
    } catch {
      return errorResponse(
        request,
        400,
        "invalid_body",
        "Please check the form and try again.",
      );
    }
    const body = merchantApplicationSchema.safeParse(raw);
    if (!body.success)
      return errorResponse(
        request,
        400,
        "invalid_application",
        "Please check all required fields, the website address and your consent.",
      );
    // Caddy is the sole public proxy and appends the authoritative peer address.
    const ip =
      request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ||
      "unknown";
    const result = await saveMerchantApplication(body.data, key, ip);
    if (result === "conflict")
      return errorResponse(
        request,
        409,
        "application_changed",
        "The form changed after an earlier attempt. Please submit it again.",
      );
    if (result === "rate_limited")
      return errorResponse(
        request,
        429,
        "rate_limited",
        "Too many applications. Please try again in one hour.",
        true,
        3600,
      );
    return NextResponse.json(
      { status: "received" },
      { status: 202, headers: requestHeaders(request) },
    );
  } catch (error) {
    logServerError(request, "merchant_application_failed", error);
    return errorResponse(
      request,
      503,
      "application_unavailable",
      "We couldn’t save your application. Please try again shortly.",
      true,
    );
  }
}

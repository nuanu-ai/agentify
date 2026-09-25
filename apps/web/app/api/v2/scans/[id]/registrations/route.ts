import { partnerClickIdSchema, registrationRequestSchema } from "@agentify/scanner-contracts";
import { type NextRequest, NextResponse } from "next/server";
import { PARTNER_CLICK_ID_COOKIE } from "../../../../../../lib/server/attribution";
import { visitorOf } from "../../../../../../lib/server/auth";
import { getServerConfig } from "../../../../../../lib/server/config";
import { normalizeEmail } from "../../../../../../lib/server/crypto";
import {
  bearerToken,
  errorResponse,
  hasSameOrigin,
  waitResponse,
  waitSeconds,
} from "../../../../../../lib/server/http";
import { linkCooldownResponse } from "../../../../../../lib/server/link-wait";
import {
  askAsSignedIn,
  createScannerRegistrationIntent,
} from "../../../../../../lib/server/scanner-registration";
import { authorizeScan } from "../../../../../../lib/server/scans";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasSameOrigin(request))
    return errorResponse(request, 403, "invalid_origin", "The request origin is not allowed.");
  if (!getServerConfig().REGISTRATION_ENABLED)
    return errorResponse(
      request,
      503,
      "registration_unavailable",
      "Contact verification is not enabled for this deployment yet.",
      true,
      3600,
    );
  const token = bearerToken(request);
  const { id } = await params;
  if (!token)
    return errorResponse(request, 401, "unauthorized", "A private scan token is required.");
  const scan = await authorizeScan(id, token);
  if (!scan) return errorResponse(request, 404, "scan_not_found", "The scan was not found.");
  if (scan.status !== "completed" && scan.status !== "partial")
    return errorResponse(
      request,
      409,
      "report_not_ready",
      "A report is not available for this scan.",
      true,
      5,
    );
  const parsed = registrationRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return errorResponse(
      request,
      400,
      "invalid_registration",
      "Check the email, the phone if given, and the consent fields.",
    );
  // Who is asking decides what the ask is. A signed-in person's own ask is
  // filed under the session's address at once and sends nothing; anybody
  // else's waits for the link sent to the address they typed. A cabinet that
  // does not answer is neither, and nothing is asked on a guess (ADR-0026 §2).
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown")
    return errorResponse(
      request,
      503,
      "visitor_unknown",
      "We cannot tell who is visiting right now, so the report cannot be asked for. Try again shortly.",
      true,
      30,
    );
  const email = parsed.data.email;
  // An address typed beside a session is not quietly swapped for the session's:
  // the person is told which address a report they ask for is filed under,
  // and how to ask with another (ADR-0026 §1).
  if (
    visitor.kind === "person" &&
    email !== undefined &&
    normalizeEmail(email) !== normalizeEmail(visitor.email)
  )
    return errorResponse(
      request,
      409,
      "signed_in_as_another_address",
      `You are signed in as ${visitor.email}, so a report you ask for is filed under that address. To ask with ${email}, sign out first.`,
    );
  if (visitor.kind === "stranger" && email === undefined)
    return errorResponse(
      request,
      400,
      "invalid_registration",
      "Enter the email address the report should be sent to.",
    );
  const partnerClickId = partnerClickIdSchema.safeParse(
    request.cookies.get(PARTNER_CLICK_ID_COOKIE)?.value,
  );
  const partner = partnerClickId.success ? { partnerClickId: partnerClickId.data } : {};
  try {
    if (visitor.kind === "person") {
      let result: Awaited<ReturnType<typeof askAsSignedIn>>;
      try {
        result = await askAsSignedIn(scan, parsed.data, visitor.email, partner);
      } catch {
        return errorResponse(
          request,
          503,
          "report_unavailable",
          "The report could not be filed under your address right now. Nothing was changed; try again shortly.",
          true,
          60,
        );
      }
      // No link is involved in a signed-in ask, so its refusal speaks of asks.
      if (!result.sent) {
        const seconds = waitSeconds(result.retryAt);
        return waitResponse(
          request,
          429,
          "report_ask_cooldown",
          `This scan has been asked about many times in the last hour. You can ask again in ${seconds < 60 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`}.`,
          seconds,
        );
      }
      return NextResponse.json(
        {
          status: "report_ready",
          report_url: `/report/${encodeURIComponent(scan.id)}`,
          email: visitor.email,
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const result = await createScannerRegistrationIntent(
      scan,
      { ...parsed.data, email: email ?? "" },
      partner,
    );
    if (!result.sent) return linkCooldownResponse(request, result);
    return NextResponse.json(
      { status: "verification_sent" },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return errorResponse(
      request,
      503,
      "email_unavailable",
      "Verification email is temporarily unavailable.",
      true,
      60,
    );
  }
}

import { namesAVisitor } from "@agentify/scanner/ip";
import { registrationRequestSchema } from "@agentify/scanner-contracts";
import type { Params } from "react-router";
import { visitorOf } from "../../../../lib/server/auth";
import { getServerConfig } from "../../../../lib/server/config";
import { hmacHex, normalizeEmail } from "../../../../lib/server/crypto";
import {
  bearerToken,
  clientAddress,
  errorResponse,
  hasSameOrigin,
  waitResponse,
  waitSeconds,
} from "../../../../lib/server/http";
import { linkCooldownResponse } from "../../../../lib/server/link-wait";
import { methods } from "../../../../lib/server/methods";
import { consumeRateLimitsAtomically } from "../../../../lib/server/rate-limit";
import {
  askAsSignedIn,
  createScannerRegistrationIntent,
} from "../../../../lib/server/scanner-registration";
import { authorizeScan } from "../../../../lib/server/scans";

/**
 * A stranger's asks from one client address in the rolling hour, whatever scans
 * and addresses it uses: each sends mail to the address typed.
 */
const REPORT_LINK_ASKS_PER_CLIENT_HOUR = 10;

async function register(request: Request, params: Params): Promise<Response> {
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
  if (!token)
    return errorResponse(request, 401, "unauthorized", "A private scan token is required.");
  const scan = await authorizeScan(params.id ?? "", token);
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
  // A signed-in person's ask is filed under their address at once and sends
  // nothing; a stranger's waits for the link sent to the address typed.
  // A dashboard that does not answer is neither, and nothing is asked on a guess.
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
  // A signed-in ask names the address its page showed. A page left open while
  // the session changed in another tab would otherwise file the report, and
  // the ownership claim, under an address the person never saw on it.
  if (visitor.kind === "person") {
    if (email === undefined)
      return errorResponse(
        request,
        409,
        "signed_in_as_another_address",
        `You are signed in as ${visitor.email}, and this ask did not say which address it was for, so nothing was filed. Reload the page to ask as ${visitor.email}.`,
      );
    if (normalizeEmail(email) !== normalizeEmail(visitor.email))
      return errorResponse(
        request,
        409,
        "signed_in_as_another_address",
        `You are signed in as ${visitor.email} now, so nothing was filed under ${email}. Reload the page to ask as ${visitor.email}, or sign out to ask with ${email}.`,
      );
  }
  if (visitor.kind === "stranger" && email === undefined)
    return errorResponse(
      request,
      400,
      "invalid_registration",
      "Enter the email address the report should be sent to.",
    );
  try {
    if (visitor.kind === "person") {
      let result: Awaited<ReturnType<typeof askAsSignedIn>>;
      try {
        result = await askAsSignedIn(scan, parsed.data, visitor.email);
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
      return Response.json(
        {
          status: "report_ready",
          report_url: `/report/${encodeURIComponent(scan.id)}`,
          email: visitor.email,
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
    // Counts asks, not links sent, as the scan's own hour does: the address's
    // hour is the one given back when no link went out.
    const client = clientAddress(request);
    if (namesAVisitor(client)) {
      const fromClient = await consumeRateLimitsAtomically([
        {
          keyHash: hmacHex(getServerConfig().hmacSecret, "registration-ip", client),
          kind: "registration_ip_hour",
          limit: REPORT_LINK_ASKS_PER_CLIENT_HOUR,
        },
      ]);
      if (!fromClient.allowed)
        return linkCooldownResponse(request, { retryAt: fromClient.retryAt, wall: "unspecified" });
    }
    const result = await createScannerRegistrationIntent(scan, {
      ...parsed.data,
      email: email ?? "",
    });
    if (!result.sent) return linkCooldownResponse(request, result);
    return Response.json(
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

export const loader = methods({ POST: register });
export const action = loader;

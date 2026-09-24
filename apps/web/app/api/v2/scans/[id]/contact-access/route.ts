import { contactAccessResponseSchema } from "@agentify/scanner-contracts";
import { type NextRequest, NextResponse } from "next/server";
import { owns, visitorOf } from "../../../../../../lib/server/auth";
import { errorResponse } from "../../../../../../lib/server/http";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const visitor = await visitorOf(request.headers.get("cookie"));
  // A cabinet that does not answer is not a stranger, and the page is told
  // so rather than being asked to confirm an address it may already have.
  if (visitor.kind === "unknown")
    return errorResponse(
      request,
      503,
      "visitor_unknown",
      "We cannot tell who is visiting right now. Try again shortly.",
      true,
      30,
    );
  if (visitor.kind !== "person" || visitor.leadId === null || !(await owns(visitor.leadId, id)))
    return errorResponse(
      request,
      401,
      "contact_verification_required",
      "Confirm your email to copy or download the prompt.",
    );
  return NextResponse.json(contactAccessResponseSchema.parse({ status: "verified" }), {
    headers: { "Cache-Control": "private, no-store" },
  });
}

import { contactAccessResponseSchema } from "@agentify/scanner-contracts";
import type { Params } from "react-router";
import { owns, visitorOf } from "../../../../lib/server/auth";
import { errorResponse } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";

async function contactAccess(request: Request, params: Params): Promise<Response> {
  const visitor = await visitorOf(request.headers.get("cookie"));
  // A dashboard that does not answer is not a stranger, and the page is told
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
  if (
    visitor.kind !== "person" ||
    visitor.leadId === null ||
    !(await owns(visitor.leadId, params.id ?? ""))
  )
    return errorResponse(
      request,
      401,
      "contact_verification_required",
      "Confirm your email to copy or download the prompt.",
    );
  return Response.json(contactAccessResponseSchema.parse({ status: "verified" }), {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export const loader = methods({ GET: contactAccess });
export const action = loader;

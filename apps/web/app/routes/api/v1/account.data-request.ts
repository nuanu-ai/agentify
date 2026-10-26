import { accountDataRequestSchema } from "@agentify/scanner-contracts";
import { visitorOf } from "../../../../lib/server/auth";
import {
  answerDataCopyRequest,
  type CopyAnswer,
  recordDataCopyRequest,
} from "../../../../lib/server/data-copy";
import { errorResponse, hasSameOrigin, pageNotMatched } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { updateAccountState } from "../../../../lib/server/reporting";

const MINUTE_MS = 60_000;

/**
 * A copy request's answer in whole minutes the page can say: how long ago a
 * copy went, or how long the tries still run, counted on this side's clock so
 * the browser's own clock cannot move them.
 */
function copyAnswer(answer: CopyAnswer, sentTo: string) {
  const now = Date.now();
  if (answer.status === "sent")
    return {
      status: "sent",
      type: "access",
      sent_to: sentTo,
      fresh: answer.fresh,
      minutes_ago: Math.max(0, Math.floor((now - answer.sentAt.getTime()) / MINUTE_MS)),
    } as const;
  if (answer.status !== "pending")
    return { status: answer.status, type: "access", sent_to: sentTo } as const;
  return {
    status: "pending",
    type: "access",
    sent_to: sentTo,
    outcome: answer.outcome,
    within_minutes: Math.max(1, Math.ceil((answer.lastTryBy.getTime() - now) / MINUTE_MS)),
  } as const;
}

async function requestData(request: Request): Promise<Response> {
  if (!hasSameOrigin(request))
    return errorResponse(request, 403, "invalid_origin", "The request origin is not allowed.");
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown")
    return errorResponse(
      request,
      503,
      "visitor_unknown",
      "We cannot tell who is visiting right now, so nothing was changed. Try again shortly.",
      true,
      30,
    );
  if (visitor.kind === "stranger")
    return errorResponse(
      request,
      404,
      "session_not_found",
      "Sign in with the address your reports were sent to before making this request.",
    );
  const sent = await request.json().catch(() => null);
  const unmatched = pageNotMatched(request, sent, visitor.email);
  if (unmatched !== null) return unmatched;
  const parsed = accountDataRequestSchema.safeParse(sent);
  if (!parsed.success)
    return errorResponse(request, 400, "invalid_data_request", "The request type is invalid.");
  // The copy goes to the address this session is signed in as, the proof that
  // the address is the person's; an address with no reports may still hold a
  // seller dashboard, so asking for a copy needs no lead.
  if (parsed.data.type === "access") {
    let recorded: Awaited<ReturnType<typeof recordDataCopyRequest>>;
    try {
      recorded = await recordDataCopyRequest(visitor.email);
    } catch {
      return errorResponse(
        request,
        503,
        "data_copy_not_recorded",
        "The request could not be recorded, so no copy was sent. Try again shortly.",
        true,
        60,
      );
    }
    let answer: CopyAnswer;
    try {
      answer = await answerDataCopyRequest(recorded);
    } catch {
      // The request is kept and the background retry makes its tries; what
      // became of this one is not known.
      return errorResponse(
        request,
        503,
        "data_copy_outcome_unknown",
        `The request is recorded, but we cannot tell yet whether a copy went to ${visitor.email}. It is tried again automatically, and pressing again sends no second copy.`,
        true,
        60,
      );
    }
    return Response.json(copyAnswer(answer, visitor.email));
  }
  if (visitor.leadId === null)
    return errorResponse(
      request,
      404,
      "no_reports_for_address",
      `No reports are filed under ${visitor.email}, so there is nothing here to act on for that address.`,
    );
  let status: "requested" | "completed";
  try {
    status = await updateAccountState(visitor.leadId, "deletion");
  } catch {
    return errorResponse(
      request,
      503,
      "deletion_cleanup_failed",
      "Deletion could not be recorded, so report access remains unchanged. Try again shortly.",
      true,
      60,
    );
  }
  return Response.json({ status, type: "deletion" });
}

export const loader = methods({ POST: requestData });
export const action = loader;

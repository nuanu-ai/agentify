/**
 * Who is visiting a scanner page, asked of the cabinet.
 *
 * The scanner keeps no session of its own (ADR-0026 §2). The cabinet holds the
 * one session the site has, and the scanner asks it over the internal route
 * whose session a request's cookies are, then reads its own tables for what
 * that address owns: a report opens for a session whose address owns it,
 * meaning the lead with that address is linked to the scan.
 *
 * Three answers and not two. A cabinet that cannot be reached is not a
 * stranger: a page that cannot tell who is visiting says so, because not
 * knowing who somebody is must not look like knowing they are nobody.
 */

import { createLogger, safeErrorType } from "@agentify/observability";
import { sessionCookiePairs } from "@agentify/scanner-contracts/report-identity";
import { leadScans, leads, scans, waitlistEntries } from "@agentify/scanner-database";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { getCabinetReportIdentityClient } from "./cabinet-report-identity";
import { getServerConfig } from "./config";
import { hmacHex, normalizeEmail } from "./crypto";
import { getDatabase } from "./database";
import { finishWaitingRequest } from "./scanner-registration";

const logger = createLogger({
  service: "web",
  environment: process.env.NODE_ENV ?? "development",
});

export type Visitor =
  | Readonly<{
      kind: "person";
      email: string;
      /** The lead this address owns reports through, or null for an address with none. */
      leadId: string | null;
      /** The cabinet's renewed cookie, for an answer that asked to renew and can pass it on. */
      setCookies: readonly string[];
    }>
  | Readonly<{ kind: "stranger" }>
  | Readonly<{ kind: "unknown" }>;

/**
 * Who a cookie header belongs to.
 *
 * `renew` is for the one answer that can hand the browser a renewed cookie:
 * a page drawn on the server cannot set one, so everything else reads the
 * session without moving its end, and the header's own call is what renews
 * it once a day and passes the cookie on.
 *
 * When the session names the request its link was asked for, that request is
 * finished here, at whichever page is the session's first visit. A finishing
 * that fails is logged and the visit goes on: the request keeps waiting and the
 * next visit finishes it, which is better than a page that does not draw.
 *
 * A page reads this once and passes it down, so that everything it draws is
 * about one answer: a cabinet that stops answering between two questions could
 * otherwise turn a report's owner into somebody it is not filed under.
 */
export async function visitorOf(
  cookieHeader: string | undefined | null,
  options: Readonly<{ renew?: boolean }> = {},
): Promise<Visitor> {
  // Only the session's cookie goes to the cabinet: it is told whose session
  // this is and nothing about the visitor's other cookies. None at all is
  // nobody's session, and asking the cabinet about it would put a call to it
  // in front of every first visit to the site.
  const cookie = sessionCookiePairs(cookieHeader ?? "");
  if (cookie === "") return { kind: "stranger" };
  let answer: Awaited<ReturnType<ReturnType<typeof getCabinetReportIdentityClient>["readSession"]>>;
  try {
    answer = await getCabinetReportIdentityClient().readSession({
      cookie,
      renew: options.renew ?? false,
    });
  } catch {
    return { kind: "unknown" };
  }
  if (answer.status === "signed_out") return { kind: "stranger" };
  if (answer.request !== null) {
    try {
      await finishWaitingRequest(answer.request, answer.email);
    } catch (error) {
      logger.error("waiting_request_not_finished", { error_type: safeErrorType(error) });
    }
  }
  return {
    kind: "person",
    email: answer.email,
    leadId: await leadOf(answer.email),
    setCookies: answer.set_cookie,
  };
}

/**
 * The lead a visitor already read owns reports through, and, when a scan is
 * named, only if that lead is linked to it: undefined for a stranger and for a
 * person whose address owns nothing here. A visitor the cabinet could not name
 * never reaches this; whoever read it answers that it cannot tell.
 */
export async function ownedLead(visitor: Visitor, scanId?: string): Promise<string | undefined> {
  if (visitor.kind !== "person" || visitor.leadId === null) return undefined;
  if (scanId !== undefined && !(await owns(visitor.leadId, scanId))) return undefined;
  return visitor.leadId;
}

/** Whether this lead is linked to this scan, which is what owning its report means. */
export async function owns(leadId: string, scanId: string): Promise<boolean> {
  const linked = (
    await getDatabase()
      .db.select({ leadId: leadScans.leadId })
      .from(leadScans)
      .where(and(eq(leadScans.leadId, leadId), eq(leadScans.scanId, scanId)))
      .limit(1)
  )[0];
  return linked !== undefined;
}

/**
 * The latest report this lead owns, which is where a person with reports and
 * no merchant starts (ADR-0026 §1), or undefined for a lead that owns none.
 */
export async function latestReportOf(leadId: string): Promise<string | undefined> {
  const latest = (
    await getDatabase()
      .db.select({ scanId: scans.id })
      .from(leadScans)
      .innerJoin(scans, eq(scans.id, leadScans.scanId))
      .innerJoin(
        waitlistEntries,
        and(eq(waitlistEntries.scanId, scans.id), eq(waitlistEntries.leadId, leadId)),
      )
      .where(and(eq(leadScans.leadId, leadId), inArray(scans.status, ["completed", "partial"])))
      .orderBy(desc(scans.finishedAt), desc(scans.acceptedAt))
      .limit(1)
  )[0];
  return latest?.scanId;
}

/**
 * The lead for an address, unless its deletion has been asked for: the moment
 * somebody asks for their data to go, their reports stop opening, whether or
 * not the cabinet has answered yet.
 */
async function leadOf(email: string): Promise<string | null> {
  const lead = (
    await getDatabase()
      .db.select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(
            leads.emailLookupHash,
            hmacHex(getServerConfig().hmacSecret, "email", normalizeEmail(email)),
          ),
          isNull(leads.deletionRequestedAt),
          isNull(leads.anonymizedAt),
        ),
      )
      .limit(1)
  )[0];
  return lead?.id ?? null;
}

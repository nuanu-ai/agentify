/**
 * Who is visiting a scanner page. The scanner keeps no session of its own;
 * it asks the dashboard, which holds the site's only session. A dashboard
 * that cannot be reached yields "unknown" rather than "stranger": not
 * knowing who someone is must not look like knowing they are nobody.
 */

import { createLogger, safeErrorType } from "@agentify/observability";
import { sessionCookiePairs } from "@agentify/scanner-contracts/report-identity";
import { leadScans, leads, scans, waitlistEntries } from "@agentify/scanner-database";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getServerConfig } from "./config";
import { hmacHex, normalizeEmail } from "./crypto";
import { getDashboardReportIdentityClient } from "./dashboard-report-identity";
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
      /** Whether this person's account carries the operator flag. */
      operator: boolean;
      /** The lead this address owns reports through, or null for an address with none. */
      leadId: string | null;
      /** The dashboard's renewed cookie, for an answer that asked to renew and can pass it on. */
      setCookies: readonly string[];
    }>
  | Readonly<{ kind: "stranger" }>
  | Readonly<{ kind: "unknown" }>;

/**
 * Who a cookie header belongs to.
 *
 * Pass `renew` only from a caller that hands the browser the renewed cookie,
 * `setCookies`, in the headers of its answer, as any route's loader or action
 * can. A waiting request the session names is finished here; if that fails it
 * is logged and the next visit finishes it. A page reads this once and passes
 * it down, so a dashboard that stops answering mid-page cannot give one page
 * two different visitors.
 */
export async function visitorOf(
  cookieHeader: string | undefined | null,
  options: Readonly<{ renew?: boolean }> = {},
): Promise<Visitor> {
  // Only the session cookie is forwarded. With none, skip the call: every first
  // visit to the site would otherwise wait on the dashboard.
  const cookie = sessionCookiePairs(cookieHeader ?? "");
  if (cookie === "") return { kind: "stranger" };
  let answer: Awaited<
    ReturnType<ReturnType<typeof getDashboardReportIdentityClient>["readSession"]>
  >;
  try {
    answer = await getDashboardReportIdentityClient().readSession({
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
    operator: answer.operator,
    leadId: await leadOf(answer.email),
    setCookies: answer.set_cookie,
  };
}

/**
 * The visitor's lead, and when a scan is named only if that lead owns it.
 * Answer an "unknown" visitor before calling this: undefined here means the
 * visitor owns nothing.
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
 * no merchant starts, or undefined for a lead that owns none.
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
 * The lead for an address, unless its deletion has been asked for: reports stop
 * opening the moment deletion is requested, before the dashboard has answered.
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

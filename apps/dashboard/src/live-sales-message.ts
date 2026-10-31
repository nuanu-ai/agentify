import { decisionMessage } from "./live-sales-decision-message.js";
import type { LiveSalesMailEvent } from "./live-sales-events.js";
import type { Message } from "./mail.js";
import { transactionalEmailHtml } from "./mail-template.js";
import { momentInUtc } from "./moments.js";

const date = (at: number): string => momentInUtc(new Date(at).toISOString());
const number = (count: number): string => count.toLocaleString("en-US");

/** Used by the durable sender and the gallery, with the same dated facts. */
export function liveSalesMessage(parts: {
  readonly to: string;
  readonly event: LiveSalesMailEvent;
  readonly requesterEmail: string | null;
  readonly baseUrl: string;
  readonly idempotencyKey: string;
}): Message {
  const { event, requesterEmail, baseUrl } = parts;
  if (!("request" in event)) return decisionMessage({ ...parts, event });
  const { request, sellerName, kind } = event;
  const operator = kind !== "declined";
  const link = operator ? `${baseUrl}/admin/merchants/${request.merchantId}` : baseUrl;
  let subject: string;
  let lead: string;
  let paragraphs: string[];
  if (kind === "declined") {
    const decline = request.decline;
    if (decline?.reason == null) throw new Error("a decline email needs its recorded note");
    subject = `Agentify didn't approve ${sellerName} for live sales`;
    lead = `Agentify looked at your request for live sales on ${date(decline.at)} and didn't approve it.`;
    paragraphs = [
      `Note from Agentify:\n${decline.reason}`,
      "Fix what the note asks, then ask again from your dashboard.",
    ];
  } else if (kind === "reminder") {
    subject = `${sellerName} has waited two working days`;
    lead = `${sellerName} asked for live sales on ${date(request.requestedAt)}, and nobody has answered.`;
    paragraphs = ["Their screen says we usually reply within one or two working days."];
  } else {
    subject = `${sellerName} asked for live sales`;
    lead =
      request.accountId === null
        ? `Agentify recorded ${sellerName}'s existing pending request on ${date(request.requestedAt)}.`
        : `${sellerName}${requesterEmail === null ? "" : ` (${requesterEmail})`} asked on ${date(request.requestedAt)}.`;
    const evidence = request.evidence;
    if (evidence === null) {
      paragraphs = ["We don't have a recorded catalog check or code connection for this request."];
    } else if (evidence.integration === "api") {
      paragraphs = [`Their code connected ${date(evidence.connectedAt)}.`];
    } else {
      paragraphs = evidence.complete
        ? [
            `${number(evidence.ready)} of ${number(evidence.total ?? evidence.read)} products in ${evidence.host} checked ready.`,
          ]
        : [
            `${number(evidence.ready)} of the ${number(evidence.read)} products read from ${evidence.host} checked ready.`,
            "We don't know about the rest yet.",
          ];
      paragraphs.push(`Checked ${date(evidence.checkedAt)}.`);
    }
    if (!event.hasWallet) paragraphs.push("No payout wallet yet.");
  }
  const action = operator ? `Open ${sellerName} in the admin` : "Ask again in your dashboard";
  const reason = operator
    ? "You get this email because you are an operator of Agentify's live channel."
    : "You get this email because you asked Agentify for live sales.";
  return {
    to: parts.to,
    subject,
    body: ["Agentify", subject, lead, ...paragraphs, `${action}:\n${link}`, reason].join("\n\n"),
    html: transactionalEmailHtml(
      {
        preview: lead,
        title: subject,
        lead,
        paragraphs,
        action,
        link,
        reason,
      },
      { paragraphsBeforeAction: true },
    ),
    idempotencyKey: parts.idempotencyKey,
  };
}

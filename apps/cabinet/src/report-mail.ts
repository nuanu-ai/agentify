import type { Message } from "./mail.js";
import { transactionalEmailHtml } from "./mail-template.js";

export type ReportMailPurpose = "registration" | "recovery";

const copy = {
  registration: {
    subject: "Unlock your Agentify report",
    eyebrow: "Report access",
    heading: "Your Agentify report is ready",
    body: "Confirm your email to unlock the AI fix prompt and downloadable Markdown report.",
    action: "Open my report",
  },
  recovery: {
    subject: "Recover your Agentify report",
    eyebrow: "Report recovery",
    heading: "Recover your Agentify report",
    body: "If a private report is linked to this address, use this secure link to recover it.",
    action: "Recover report access",
  },
} as const;

export function reportLinkMessage(to: string, purpose: ReportMailPurpose, url: string): Message {
  const content = copy[purpose];
  const lifetime =
    "This secure link expires in one hour and can be used once. If you did not request it, you can ignore this email.";

  return {
    to,
    subject: content.subject,
    body: `Agentify\n\n${content.heading}\n\n${content.body}\n\n${content.action}: ${url}\n\n${lifetime}`,
    html: transactionalEmailHtml({
      preview: content.body,
      eyebrow: content.eyebrow,
      title: content.heading,
      lead: content.body,
      action: content.action,
      link: url,
      paragraphs: [lifetime],
    }),
  };
}

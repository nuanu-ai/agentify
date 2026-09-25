import type { Message } from "./mail.js";
import { transactionalEmailHtml } from "./mail-template.js";

/**
 * The message for a link the scanner asked for: the full report of one scan.
 *
 * Like every link, it lands on the cabinet's page with one control, and that
 * press signs the address in on this browser before it opens the report.
 */
export function reportLinkMessage(to: string, url: string): Message {
  const title = "Your Agentify report is ready";
  const lead = "Confirm your email to unlock the AI fix prompt and downloadable Markdown report.";
  const lifetime =
    "This link opens once and expires an hour after it was sent. Opening it only shows a page; nothing happens unless the button on it is pressed. If you did not ask for it, ignore this message.";

  return {
    to,
    subject: "Unlock your Agentify report",
    // The URL stands on a line of its own, so that a client that draws no
    // button and a person copying it by hand both get the whole of it.
    body: `Agentify\n\n${title}\n\n${lead}\n\nOpen my report:\n\n${url}\n\n${lifetime}`,
    html: transactionalEmailHtml({
      preview: lead,
      eyebrow: "Report access",
      title,
      lead,
      action: "Open my report",
      link: url,
      paragraphs: [lifetime],
    }),
  };
}

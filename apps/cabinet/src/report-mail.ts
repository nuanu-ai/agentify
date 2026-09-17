import type { Message } from "./mail.js";

export type ReportMailPurpose = "registration" | "recovery";

const copy = {
  registration: {
    subject: "Unlock your Agentify report",
    heading: "Your Agentify report is ready",
    body: "Confirm your email to unlock the AI fix prompt and downloadable Markdown report.",
    action: "Open my report",
  },
  recovery: {
    subject: "Recover your Agentify report",
    heading: "Recover your Agentify report",
    body: "If a private report is linked to this address, use this secure link to recover it.",
    action: "Recover report access",
  },
} as const;

export function reportLinkMessage(to: string, purpose: ReportMailPurpose, url: string): Message {
  const content = copy[purpose];
  const safeUrl = escapeHtml(url);
  const lifetime =
    "This secure link expires in one hour and can be used once. If you did not request it, you can ignore this email.";

  return {
    to,
    subject: content.subject,
    body: `Agentify\n\n${content.heading}\n\n${content.body}\n\n${content.action}: ${url}\n\n${lifetime}`,
    html: `<div style="margin:0;background:#f6f7f3;padding:32px 16px;font-family:Inter,Arial,sans-serif;color:#171915">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #dfe3da;border-radius:18px;padding:32px">
    <div style="font-size:14px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#577159">Agentify</div>
    <h1 style="margin:18px 0 12px;font-size:28px;line-height:1.15">${content.heading}</h1>
    <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#545a51">${content.body}</p>
    <p style="margin:0 0 24px"><a href="${safeUrl}" style="display:inline-block;background:#1f5f3b;color:#ffffff;text-decoration:none;font-weight:800;padding:14px 22px;border-radius:10px">${content.action}</a></p>
    <p style="margin:0;font-size:13px;line-height:1.5;color:#777d74">${lifetime}</p>
  </div>
</div>`,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
